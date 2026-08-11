"""智能分镜：帧差切分点检测（零依赖，PyAV 解码）。

PySceneDetect（cv2）在本环境不可用，这里用缩略图 + 相邻帧平均绝对差
自适应阈值找切点——对硬切敏感、对运动镜头稳健。软切（叠化）不在
第一版范围，灵敏度三档可调。
"""

import numpy as np

try:
    import av
except ImportError:
    av = None

from .payload import _input_file_path

# 自适应阈值倍数：切点 = 中位数 + k × 绝对中位差。越大切点越少。
_SENSITIVITY_K = {"low": 10.0, "medium": 7.0, "high": 4.5}
_THUMB_W = 96       # 缩略图宽（检测速度与精度的平衡）
_SAMPLE_FPS = 4     # 检测采样率（每秒 4 帧足够抓硬切）


def detect_shots(video, subfolder="", sensitivity="medium", min_shot=1.0):
    """返回切点时间列表（秒，不含 0 与片尾）。
    min_shot: 两个切点的最小间隔（秒），过近的切点合并保留更强的一个。"""
    if av is None:
        raise ImportError("h3_scenedirector: 智能分镜需要 PyAV。")
    k = _SENSITIVITY_K.get(str(sensitivity or "medium"), 7.0)
    path = _input_file_path(video, subfolder)

    diffs, times = [], []
    prev = None
    with av.open(path) as c:
        vs = next((s for s in c.streams if s.type == "video"), None)
        if vs is None:
            raise ValueError("h3_scenedirector: %r 里没有视频流。" % video)
        src_fps = float(vs.average_rate or 24)
        step = max(1, round(src_fps / _SAMPLE_FPS))
        idx = -1
        for packet in c.demux(vs):
            for frame in packet.decode():
                idx += 1
                if idx % step:
                    continue
                img = frame.to_image().resize(
                    (_THUMB_W, max(1, round(_THUMB_W * frame.height / frame.width))))
                arr = np.asarray(img, dtype=np.float32).mean(axis=2) / 255.0
                t = float(frame.pts * vs.time_base) if frame.pts is not None \
                    else idx / src_fps
                if prev is not None:
                    diffs.append(float(np.abs(arr - prev).mean()))
                    times.append(t)
                prev = arr
    if len(diffs) < 2:
        return []

    d = np.asarray(diffs)
    thr = float(np.median(d) + k * np.median(np.abs(d - np.median(d))) + 1e-6)
    cuts = [(times[i], float(d[i])) for i in range(len(d)) if d[i] >= thr]

    # 合并过近切点（保留更强的）
    merged = []
    for t, s in cuts:
        if merged and t - merged[-1][0] < float(min_shot):
            if s > merged[-1][1]:
                merged[-1] = (t, s)
        else:
            merged.append((t, s))
    return [round(t, 3) for t, _s in merged]
