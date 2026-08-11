"""SceneDirector 载荷层：schema、规范化、提示词拼装、哈希。

本模块只允许纯函数——不 import ComfyUI 的任何东西——这样
"什么改动会让缓存段失效"这条规则就可以离线单测。

载荷 schema v3（工作台 JSON）：

  run           缓存目录名（一次 run = 一个场景）
  run_nonce     手动全链作废计数器
  global_prompt 设定表里的自由文本"通用"行
  globals       [{category, content}] 带标签的场景设定行
  assets        [{category, name, image, subfolder, note}] 场景资产卡；
                带图的卡会成为 H3 参考块注入每一段（身份锚），
                纯文本卡并入全局文本块
  segments      [{duration, prompt, nonce, assets}] 逐动作行；
                段级资产的 <Picture> 序号排在全局图之后

缓存哈希标签当前为 "sd4"：SceneDirector 的哈希规则与旧包 H3-Motion-Context
的 story chain（标签 "v2"）一致，但两个包即使缓存根目录被指到同一个
文件夹也绝不能共享缓存条目，所以标签刻意不同。语义发生变化的引擎
修正会递进标签（sd3 -> sd4：连续性锚点改到交付尾部），旧缓存自动作废。
"""

import hashlib
import json
import os

import folder_paths

FPS = 24
SCHEMA = 3


# ---------------------------------------------------------------------------
# 帧网格
# ---------------------------------------------------------------------------

def align_frame_count(n):
    """H3 视频 VAE 的网格：帧数必须是 17k+5。"""
    while n % 17 != 5:
        n += 1
    return n


def base_length(duration):
    """一段请求的帧数，向上对齐到 VAE 网格。第一段之后的各段由链条
    在此基础上加钉帧跨度的补偿，所以段 1 的长度在两侧都是这个值。"""
    return align_frame_count(max(5, round(float(duration) * FPS)))


# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------

def sanitize_run(name):
    name = str(name or "").strip().replace("/", "_").replace("\\", "_").lstrip(".")
    if name.startswith(("{", "[")):  # 把整个 payload 误粘进 run 名栏的情况
        return "story"
    return (name[:64] or "story")


def norm_globals(items):
    """规范化场景设定行 {category, content}，content 为空的行丢弃。"""
    out = []
    for g in items or []:
        if not isinstance(g, dict):
            continue
        row = {
            "category": str(g.get("category", "") or "").strip() or "通用",
            "content": str(g.get("content", "") or "").strip(),
        }
        if row["content"]:
            out.append(row)
    return out


def norm_assets(items, fallback_category="角色"):
    """规范化资产卡 {category, name, image, subfolder, note}。
    图、名、备注三者至少占一才算有效卡。"""
    out = []
    for a in items or []:
        if not isinstance(a, dict):
            continue
        card = {
            "category": str(a.get("category", "") or "").strip() or fallback_category,
            "name": str(a.get("name", "") or "").strip(),
            "image": str(a.get("image", "") or "").strip(),
            "subfolder": str(a.get("subfolder", "") or "").strip(),
            "note": str(a.get("note", "") or "").strip(),
        }
        if card["image"] or card["name"] or card["note"]:
            out.append(card)
    return out


def parse_payload(raw):
    """接受裸段列表（旧格式）或工作台载荷对象。

    返回 (run_name, run_nonce, global_prompt, globals_rows, assets, segments)。
    prompt 为空的段直接丢弃。
    """
    try:
        data = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        data = []
    if isinstance(data, list):
        data = {"segments": data}
    if not isinstance(data, dict):
        data = {}
    run = sanitize_run(data.get("run"))
    try:
        run_nonce = int(data.get("run_nonce", 0) or 0)
    except (TypeError, ValueError):
        run_nonce = 0
    global_prompt = str(data.get("global_prompt", "") or "").strip()
    globals_rows = norm_globals(data.get("globals"))
    assets = norm_assets(data.get("assets"))
    segments = []
    for item in data.get("segments") or []:
        if not isinstance(item, dict):
            continue
        try:
            dur = float(item.get("duration", 5.0) or 5.0)
        except (TypeError, ValueError):
            dur = 5.0
        prompt = str(item.get("prompt", "") or "").strip()
        nonce = str(item.get("nonce", "") or "")
        if prompt:
            segments.append({"duration": dur, "prompt": prompt, "nonce": nonce,
                             "assets": norm_assets(item.get("assets"),
                                                   fallback_category="场景")})
    return run, run_nonce, global_prompt, globals_rows, assets, segments


# ---------------------------------------------------------------------------
# 提示词拼装
# ---------------------------------------------------------------------------

def compose_global(global_prompt, globals_rows, assets):
    """场景级文本块：先是自由文本"通用"行，再是带标签的设定行，
    最后是资产清单——让提示词明确说明每张 <Picture> 是什么。"""
    lines = []
    if global_prompt:
        lines.append(global_prompt.strip())
    for g in globals_rows or []:
        lines.append("%s：%s" % (g["category"], g["content"]))
    roster = []
    pic = 0
    for a in assets or []:
        label = "·".join(x for x in (a["category"], a["name"]) if x)
        if a["image"]:
            pic += 1
            label = "<Picture %d>=%s" % (pic, label)
        if a["note"]:
            label += "（%s）" % a["note"]
        roster.append(label)
    block = "\n".join(lines)
    if roster:
        block = (block + "\n" if block else "") + "资产清单：" + "；".join(roster)
    return block


def compose_seg_extra(seg_assets, pic_offset):
    """段级清单行；序号接在全局图之后。"""
    roster = []
    pic = pic_offset
    for a in seg_assets:
        label = "·".join(x for x in (a["category"], a["name"]) if x)
        if a["image"]:
            pic += 1
            label = "<Picture %d>=%s" % (pic, label)
        if a["note"]:
            label += "（%s）" % a["note"]
        roster.append(label)
    return ("本段资产：" + "；".join(roster)) if roster else ""


def compose_prompt(*parts):
    return "\n".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# 指纹
# ---------------------------------------------------------------------------

def _input_file_path(image, subfolder=""):
    base = folder_paths.get_input_directory()
    return os.path.join(base, subfolder, image) if subfolder else os.path.join(base, image)


def _file_sha1(image, subfolder=""):
    path = _input_file_path(image, subfolder)
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except OSError:
        return "missing:" + image


def assets_fp(assets):
    """内容指纹：图片文件取 sha1，纯文本卡取文本内容。"""
    fps = []
    for a in assets or []:
        if a["image"]:
            fps.append(_file_sha1(a["image"], a["subfolder"]))
        else:
            fps.append("text:" + "|".join((a["category"], a["name"], a["note"])))
    return fps


def seg_hash(index, seg):
    """单段内容的身份标识（含段级资产卡）。"""
    parts = [index, seg["duration"], seg["prompt"], seg["nonce"]]
    if seg.get("assets"):
        parts.append([[a["category"], a["name"], a["note"]] for a in seg["assets"]])
        parts.extend(assets_fp(seg["assets"]))
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()


def global_hash(run_nonce, width, height, context_length, audio_context_length,
                encode_mode, anchor_mode, audio_mode, crop,
                global_prompt="", globals_rows=None, assets=None, sampling_fp="",
                cache_tag="", seed=-1):
    """会改变每一段结果的所有因素。cache_tag 是显式的手动逃生门：
    模型/LoRA 的身份无法被指纹化（ModelPatcher 没有稳定的内容标识），
    所以换了 UNET 或 LoRA 之后改一下这个 tag，缓存就不会误发旧条目。
    seed 只在显式指定（>=0）时入指纹；-1（随机/沿用 meta 的 base_seed）
    不入，否则每次运行都会无谓地全链重渲。"""
    parts = ["sd4", run_nonce, width, height, context_length, audio_context_length,
             encode_mode, anchor_mode, audio_mode, crop]
    if globals_rows or assets:
        parts.append(compose_global(global_prompt, globals_rows, assets))
        parts.extend(assets_fp(assets))
    elif global_prompt:
        parts.append(global_prompt)
    parts.append(sampling_fp)
    if cache_tag:
        parts.append(str(cache_tag))
    if seed is not None and int(seed) >= 0:
        parts.append(int(seed))
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()


def cond_digest(cond):
    """CONDITIONING 列表的内容指纹（遍历每个条目里的每个张量），
    接了不同的 negative 就会让磁盘缓存失效。"""
    import numpy as np
    import torch
    h = hashlib.sha1()
    for entry in cond or []:
        try:
            h.update(np.asarray(entry[0].detach().float().cpu().numpy()).tobytes())
            for v in (entry[1] or {}).values():
                if torch.is_tensor(v):
                    h.update(np.asarray(v.detach().float().cpu().numpy()).tobytes())
        except Exception:
            h.update(repr(entry)[:200].encode("utf-8", "replace"))
    return h.hexdigest()[:16]


def sampling_fp(sampler, sigmas, negative=None, cfg=1.0):
    """采样配置指纹。步数/调度器/采样器类型都是接线进来的（不是 widget），
    但它们改变每一段的结果——没有它磁盘缓存会愉快地发出另一套采样配置
    渲染的段。negative/cfg 只在非默认时追加。"""
    import numpy as np
    fn = getattr(sampler, "sampler_function", None)
    name = getattr(fn, "__name__", type(sampler).__name__)
    try:
        digest = hashlib.sha1(
            np.asarray(sigmas.detach().cpu().numpy()).tobytes()).hexdigest()[:16]
    except Exception:
        digest = "?"
    fp = "%s:%s" % (name, digest)
    if negative is not None:
        fp += "|neg:" + cond_digest(negative)
    if abs(float(cfg) - 1.0) > 1e-9:
        fp += "|cfg:%g" % float(cfg)
    return fp
