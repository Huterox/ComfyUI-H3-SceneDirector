"""SceneDirector 条件编码：把每段的提示词与参考图编成 CONDITIONING。

这一层刻意独立于衔接引擎存在——文本编码发生在明面上（节点图里），
任何 CLIP 层的补丁或自定义编码节点都能插进来。
"""

import math
import os

import numpy as np
import torch
from PIL import Image

import node_helpers
import folder_paths

from comfy_extras.nodes_minimax_h3 import _empty_av_latent, _resize, CANVAS_MULTIPLE

from .payload import _input_file_path

MAX_REFS = 6  # 每个参考块都占条件行；载荷要保持精简


def build_cond(clip, vae, prompt, width, height, length,
               first_frame=None, last_frame=None, ref_items=None, ref_blocks=None):
    """对齐官方 H3 条件节点的行为：提示词（+可选关键帧和/或参考图）
    -> conditioning + AV latent。

    注意官方 tokenizer 二选一：有 minimax_ref_items 就只呈现参考图
    （参考图优先）。因此有参考图时 first_frame 只通过 minimax_keyframes
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


def encode_refs(vae, gen_w, gen_h, images):
    """图片张量 -> (tokenizer 用的 ref_items, DiT 载荷用的 ref_blocks)。
    严格遵循官方 MiniMaxH3ReferenceToVideo 的配比（"match" 尺寸：
    按生成面积等比缩小）。"""
    items, blocks = [], []
    for img in images:
        h, w = img.shape[1], img.shape[2]
        scale = min(1.0, math.sqrt((gen_w * gen_h) / (w * h)))
        tw = max(CANVAS_MULTIPLE, round(w * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        th = max(CANVAS_MULTIPLE, round(h * scale / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
        resized = _resize(img[:1], tw, th, "disabled")
        z = vae.encode(resized)
        items.append({"type": "image", "data": resized})
        blocks.append({"kind": "image", "latent_h": th // 16,
                       "latent_w": tw // 16, "latent": z})
    return items, blocks
