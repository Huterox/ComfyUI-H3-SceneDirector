"""源视频 IO（v2v）：探测元信息、按时间段解码帧序列、抽原声。

只用 PyAV（ComfyUI 自带依赖），不引入 cv2 / imageio-ffmpeg。
帧输出遵循 ComfyUI IMAGE 约定：[T,H,W,C] float32 [0,1]。
"""

import numpy as np
import torch

try:
    import av
except ImportError:  # 理论上不会：ComfyUI 依赖 PyAV
    av = None

from .payload import _input_file_path

TARGET_FPS = 24  # H3 原生帧率，源片段统一重采样到它


def _need_av():
    if av is None:
        raise ImportError("h3_scenedirector: 需要 PyAV 解码源视频。")


def probe_video(video, subfolder=""):
    """探测源视频：时长/帧率/宽高/是否有音轨。"""
    _need_av()
    path = _input_file_path(video, subfolder)
    with av.open(path) as c:
        vs = next((s for s in c.streams if s.type == "video"), None)
        if vs is None:
            raise ValueError("h3_scenedirector: %r 里没有视频流。" % video)
        dur = float(c.duration or 0) / 1e6
        if vs.duration and vs.time_base:
            dur = max(dur, float(vs.duration * vs.time_base))
        fps = float(vs.average_rate or vs.base_rate or TARGET_FPS)
        has_audio = any(s.type == "audio" for s in c.streams)
        return {"duration": round(dur, 3), "fps": round(fps, 3),
                "width": int(vs.width), "height": int(vs.height),
                "has_audio": bool(has_audio)}


def decode_frames(video, subfolder, start, end, fps=TARGET_FPS, max_frames=None):
    """把 [start, end) 秒的源画面解码成 [T,H,W,C] 张量（重采样到 fps）。

    抽帧策略：按目标帧率取距目标时刻最近的解码帧（最近邻），不做插值——
    v2v 的源参考要保真，插值帧是假内容。
    """
    _need_av()
    path = _input_file_path(video, subfolder)
    start, end = float(start), float(end)
    if end <= start:
        raise ValueError("h3_scenedirector: 源片段时间窗非法（%.2f ~ %.2f）。" % (start, end))
    want = max(1, round((end - start) * fps))
    if max_frames:
        want = min(want, int(max_frames))
    targets = [start + i / fps for i in range(want)]

    frames = []
    ti = 0
    with av.open(path) as c:
        vs = next(s for s in c.streams if s.type == "video")
        c.seek(max(0, int(start * 1e6)), any_frame=False, backward=True)
        for packet in c.demux(vs):
            for frame in packet.decode():
                t = float(frame.pts * vs.time_base) if frame.pts is not None else 0.0
                if t < start - 1.0 / fps:
                    continue
                while ti < len(targets) and t >= targets[ti] - 0.5 / fps:
                    img = frame.to_ndarray(format="rgb24")
                    frames.append(torch.from_numpy(
                        np.asarray(img, dtype=np.float32) / 255.0))
                    ti += 1
                if ti >= len(targets):
                    break
            if ti >= len(targets):
                break
    if not frames:
        raise ValueError("h3_scenedirector: 源窗口 %.2f~%.2fs 没解出任何帧。" % (start, end))
    # 末尾目标时刻没对上时用最后一帧补齐（源末尾精度问题，不是冻结尾设计）
    while len(frames) < want:
        frames.append(frames[-1])
    return torch.stack(frames[:want], dim=0)


def extract_audio(video, subfolder, start, end, sample_rate=44100):
    """抽 [start, end) 秒的源音轨，返回 ComfyUI AUDIO dict。
    没有音轨时返回 None。"""
    _need_av()
    path = _input_file_path(video, subfolder)
    with av.open(path) as c:
        as_ = next((s for s in c.streams if s.type == "audio"), None)
        if as_ is None:
            return None
        rs = av.audio.resampler.AudioResampler(format="s16",
                                               layout="stereo",
                                               rate=sample_rate)
        chunks = []
        c.seek(max(0, int(start * 1e6)), any_frame=False, backward=True)
        for packet in c.demux(as_):
            for frame in packet.decode():
                t = float(frame.pts * as_.time_base) if frame.pts is not None else 0.0
                if t > end:
                    break
                for r in rs.resample(frame):
                    arr = r.to_ndarray()  # [C, L] int16
                    chunks.append(torch.from_numpy(
                        np.asarray(arr, dtype=np.float32) / 32768.0))
        if not chunks:
            return None
    wav = torch.cat(chunks, dim=-1).unsqueeze(0)  # [1, C, L]
    # 精确裁到请求窗口（seek 对齐的是包边界）
    n = int(round((end - start) * sample_rate))
    if wav.shape[-1] > n:
        wav = wav[..., :n]
    return {"waveform": wav, "sample_rate": sample_rate}
