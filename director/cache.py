"""SceneDirector 运行缓存：每段的工件落在
``output/h3_scenedirector/<run>/``。

每个渲染完的段会持久化三样东西：无损 AV latent（``seg_XXXX.safetensors``，
同时充当下一段运动上下文的来源）、可看的 mp4、工作台海报图，外加驱动
增量重渲的 ``meta.json``（全局哈希 + 逐段哈希、seed、trim）。
"""

import json
import os
import time
from fractions import Fraction

import torch
import torch.nn.functional as F
from PIL import Image
from safetensors.torch import load_file as _st_load, save_file as _st_save

import folder_paths
from comfy_api.latest import InputImpl, Types

from ..core.motion_context import streams_from_av
from .payload import FPS

CACHE_ROOT = "h3_scenedirector"


def run_dir(run):
    return os.path.join(folder_paths.get_output_directory(), CACHE_ROOT, run)


def latent_path(run_dir_, index):
    return os.path.join(run_dir_, "seg_%04d.safetensors" % (index + 1))


def load_meta(run_dir_):
    try:
        with open(os.path.join(run_dir_, "meta.json"), "r", encoding="utf-8") as f:
            meta = json.load(f)
        return meta if isinstance(meta, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_meta(run_dir_, meta):
    tmp = os.path.join(run_dir_, "meta.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(run_dir_, "meta.json"))


def save_segment(run_dir_, index, out_latent, images, audio, poster_only=False):
    """持久化一个渲染完的段：无损 AV latent、可看的 mp4、工作台海报。
    ``poster_only`` 跳过 latent（缓存修复路径保留原有 latent）。"""
    base = "seg_%04d" % (index + 1)
    posters = os.path.join(run_dir_, "posters")
    os.makedirs(posters, exist_ok=True)

    if not poster_only:
        parts = streams_from_av(out_latent)
        _st_save({"video": parts[0].cpu().contiguous(),
                  "audio": parts[1].cpu().contiguous()},
                 latent_path(run_dir_, index),
                 metadata={"format": "h3_motion_context_av_v1"})

        video_obj = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio,
                                  frame_rate=Fraction(FPS)))
        video_obj.save_to(os.path.join(run_dir_, base + ".mp4"),
                          format=Types.VideoContainer("mp4"))

    mid = images[images.shape[0] // 2]
    arr = (mid * 255).clamp(0, 255).byte().cpu().numpy()
    Image.fromarray(arr).save(os.path.join(posters, base + ".jpg"), quality=85)


def load_segment_latent(run_dir_, index):
    data = _st_load(latent_path(run_dir_, index))
    # 普通 list 对，不是 NestedTensor：既能被 decode_av 解码，
    # 也能被运动上下文的 context_latent 路径接受
    return {"samples": [data["video"], data["audio"]]}


def new_meta(run, g_hash, global_prompt, globals_rows, assets_fps,
             base_seed, seg_meta):
    """组装 meta.json 的内容；assets_fps 由调用方（引擎）算好传入。"""
    return {
        "version": 2, "schema": 4, "run": run, "global_hash": g_hash,
        "global_prompt": global_prompt, "globals": globals_rows,
        "assets_fp": assets_fps,
        "base_seed": base_seed, "updated": time.time(),
        "segments": seg_meta,
    }


def contact_sheet(all_images, columns=8, thumb_w=320):
    """每段取一帧中帧，拼成一张网格 IMAGE [1,H,W,3]。"""
    thumbs = []
    for imgs in all_images:
        mid = imgs[imgs.shape[0] // 2]  # [H,W,C]
        t = mid.movedim(-1, 0).unsqueeze(0).float()  # [1,C,H,W]
        h = max(1, round(t.shape[2] * thumb_w / t.shape[3]))
        t = F.interpolate(t, size=(h, thumb_w), mode="bilinear", align_corners=False)
        thumbs.append(t[0].movedim(0, -1).cpu())
    n = len(thumbs)
    cols = min(columns, n)
    rows = (n + cols - 1) // cols
    th, tw = thumbs[0].shape[0], thumbs[0].shape[1]
    canvas = torch.zeros(rows * th, cols * tw, 3)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        canvas[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = t
    return canvas.unsqueeze(0)
