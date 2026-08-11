"""SceneDirector 条件编码：把每段的提示词与参考素材编成 CONDITIONING。

这一层刻意独立于衔接引擎存在——文本编码发生在明面上（节点图里），
任何 CLIP 层的补丁或自定义编码节点都能插进来。

参考素材支持 图片/视频/音频 三类，编码规则对齐官方
MiniMaxH3ReferenceToVideo。
"""

import math
import os

import numpy as np
import torch
from PIL import Image

import node_helpers

from comfy_extras.nodes_minimax_h3 import (_empty_av_latent, _resize,
                                           CANVAS_MULTIPLE, adapt_canvas, FPS)

from .payload import _input_file_path

MAX_REFS = 6      # 每个参考块都占条件行；载荷要保持精简
MAX_VIDEO_FRAMES = 361   # 官方参考视频上限 15s（17k+5 网格内取 361）


def build_cond(clip, vae, prompt, width, height, length,
               first_frame=None, last_frame=None, ref_items=None, ref_blocks=None):
    """对齐官方 H3 条件节点的行为：提示词（+可选关键帧和/或参考素材）
    -> conditioning + AV latent。

    注意官方 tokenizer 二选一：有 minimax_ref_items 就只呈现参考素材
    （参考优先）。因此有参考时 first_frame 只通过 minimax_keyframes
    钉住第 0 帧，不占用 <Picture> 序号——资产卡的编号和工作台显示的一致。
    """
    latent, frame_count = _empty_av_latent(width, height, length)
    images, keyframes = [], []
    if first_frame is not None:
        img = _resize(first_frame[:1], width, height, "disabled")
        images.append(img)
        keyframes.append({"resolved_frame_index": 0, "image": img})
    if last_frame is not None:
        img = _resize(last_frame[:1], width, height, "center")
        images.append(img)
        keyframes.append({"resolved_frame_index": frame_count - 1, "image": img})
    if ref_items:
        tokens = clip.tokenize(prompt, minimax_ref_items=ref_items)
    else:
        tokens = clip.tokenize(prompt, images=images)
    cond = clip.encode_from_tokens_scheduled(tokens)
    values = {}
    if keyframes:
        for kf in keyframes:
            kf["latent"] = vae.encode(kf.pop("image"))
        values["minimax_keyframes"] = keyframes
        values["minimax_frame_count"] = frame_count
    if ref_blocks:
        values["minimax_refs"] = ref_blocks
    if values:
        cond = node_helpers.conditioning_set_values(cond, values)
    return cond, latent


def load_ref_image(image, subfolder=""):
    """从输入目录读一张参考图，转成 [1,H,W,3] 的 float 张量。"""
    path = _input_file_path(image, subfolder)
    if not os.path.isfile(path):
        raise FileNotFoundError(
            "h3_scenedirector: 参考图 %r 不存在（查找路径 %s）。"
            "请通过工作台的资产卡上传。" % (image, path))
    img = Image.open(path).convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _encode_image_ref(vae, gen_w, gen_h, img):
    """图片 -> (ref_item, ref_block)。配比遵循官方"match"尺寸。"""
    h, w = img.shape[1], img.shape[2]
    scale = min(1.0, math.sqrt((gen_w * gen_h) / (w * h)))
    tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    resized = _resize(img[:1], tw, th, "disabled")
    z = vae.encode(resized)
    return ({"type": "image", "data": resized},
            {"kind": "image", "latent_h": th // 16, "latent_w": tw // 16, "latent": z})


def _encode_audio_ref(audio_vae, audio):
    """AUDIO dict -> (ref_item, ref_block)：重采样到 VAE 采样率后编码。"""
    import torchaudio
    waveform = audio["waveform"]
    sr = audio["sample_rate"]
    vae_sr = getattr(audio_vae, "audio_sample_rate", 32000)
    if sr != vae_sr:
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    z = audio_vae.encode(waveform[:1].movedim(1, -1))  # [1, 32, 2, T]
    return {"type": "audio"}, {"kind": "audio", "ref_audio_t": int(z.shape[-1]),
                               "audio_latent": z}


def encode_video_ref(vae, gen_w, gen_h, frames):
    """视频帧序列 -> (ref_item, ref_block)。对齐官方：画布自适应、
    17k+5 网格、Qwen 侧按 2fps 带时间戳呈现。"""
    vh, vw = frames.shape[1], frames.shape[2]
    cw, ch = adapt_canvas(vw, vh)
    if vw * vh < cw * ch:
        cw = max(CANVAS_MULTIPLE, round(vw / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        ch = max(CANVAS_MULTIPLE, round(vh / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    frames = _resize(frames, cw, ch, "disabled")
    n = min(int(frames.shape[0]), MAX_VIDEO_FRAMES)
    while n % 17 != 5:
        n -= 1
    if n < 5:
        raise ValueError("h3_scenedirector: 参考视频至少 5 帧（~0.2s）。")
    frames = frames[:n]
    z = vae.encode(frames)
    sample_idx = list(range(0, n, FPS // 2))
    item = {"type": "video", "data": frames[sample_idx],
            "timestamps": [i / 2.0 for i in range(len(sample_idx))]}
    block = {"kind": "video", "latent_t": int(z.shape[2]),
             "latent_h": ch // 16, "latent_w": cw // 16,
             "ref_audio_t": 0, "latent": z, "audio_latent": None}
    return item, block


def encode_refs(vae, gen_w, gen_h, images):
    """图片张量列表 -> (ref_items, ref_blocks)（兼容旧调用）。"""
    items, blocks = [], []
    for img in images:
        item, block = _encode_image_ref(vae, gen_w, gen_h, img)
        items.append(item)
        blocks.append(block)
    return items, blocks


def encode_asset_refs(vae, audio_vae, gen_w, gen_h, cards,
                      video_loader=None, audio_loader=None):
    """资产卡 -> (ref_items, ref_blocks)，按 kind 分派 图片/视频/音频。

    video_loader(audio_loader) 由调用方注入（engine 层绑了 video_io），
    保持本模块不碰 PyAV。无文件的卡跳过（纯文本卡只进提示词清单）。
    """
    items, blocks = [], []
    for a in cards:
        if not a.get("image"):
            continue
        kind = a.get("kind", "image")
        if kind == "video":
            if video_loader is None:
                raise ValueError("h3_scenedirector: 视频资产需要 video_loader。")
            frames = video_loader(a["image"], a["subfolder"])
            item, block = encode_video_ref(vae, gen_w, gen_h, frames)
        elif kind == "audio":
            if audio_loader is None:
                raise ValueError("h3_scenedirector: 音频资产需要 audio_loader。")
            audio = audio_loader(a["image"], a["subfolder"])
            if audio is None:
                continue
            item, block = _encode_audio_ref(audio_vae, audio)
        else:
            item, block = _encode_image_ref(
                vae, gen_w, gen_h, load_ref_image(a["image"], a["subfolder"]))
        items.append(item)
        blocks.append(block)
    return items, blocks
