"""SceneDirector 载荷层：schema、规范化、提示词拼装、哈希。

本模块只允许纯函数——不 import ComfyUI 的任何东西——这样
"什么改动会让缓存段失效"这条规则就可以离线单测。

载荷 schema v4（Director 1.1 工作台 JSON）：

  run           缓存目录名（一次 run = 一个场景）
  run_nonce     手动全链作废计数器
  global_prompt 设定表里的自由文本"通用"行
  globals       [{category, content}] 带标签的场景设定行
  assets        [{category, name, image, subfolder, note, kind}] 场景资产卡；
                kind ∈ image(默认)/video/audio；带文件的卡成为 H3 参考块
                注入每一段（身份锚），纯文本卡并入全局文本块
  segments      [{duration, prompt, nonce, assets, enabled, task,
                  first_frame, last_frame, source, audio_mode}]
                逐动作行。v4 新增（全部可选）：
                enabled     选择运行（默认 true；false = 用缓存填充）
                task        t2v/i2v/fl2v/r2v/v2v/rv2v（缺省按素材推断）
                first_frame {image, subfolder} 段级首帧（i2v/fl2v）
                last_frame  {image, subfolder} 段级尾帧（fl2v）
                source      {video, subfolder, start, end} v2v 源片段（秒）
                audio_mode  generate(默认)/original/mute（v2v 声音模式）

缓存哈希标签为 "sd5"：schema v4 的段字段进入段哈希。语义发生变化的
引擎修正会递进标签，旧缓存自动作废。
"""

import hashlib
import json
import os

import folder_paths

FPS = 24
SCHEMA = 4

TASK_KEYS = ("t2v", "i2v", "fl2v", "r2v", "v2v", "rv2v")
AUDIO_MODES = ("generate", "original", "mute")
ASSET_KINDS = ("image", "video", "audio")


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
    """规范化资产卡 {category, name, image, subfolder, note, kind}。
    文件、名、备注三者至少占一才算有效卡。kind: image(默认)/video/audio，
    image 字段同时充当文件名字段（历史命名，视频/音频卡也用它）。"""
    out = []
    for a in items or []:
        if not isinstance(a, dict):
            continue
        kind = str(a.get("kind", "") or "").strip().lower()
        if kind not in ASSET_KINDS:
            kind = "image"
        card = {
            "category": str(a.get("category", "") or "").strip() or fallback_category,
            "name": str(a.get("name", "") or "").strip(),
            "image": str(a.get("image", "") or "").strip(),
            "subfolder": str(a.get("subfolder", "") or "").strip(),
            "note": str(a.get("note", "") or "").strip(),
            "kind": kind,
        }
        if card["image"] or card["name"] or card["note"]:
            out.append(card)
    return out


def _norm_frame_ref(raw):
    """段级首/尾帧引用 {image, subfolder}；空值返回 None。"""
    if not isinstance(raw, dict):
        return None
    image = str(raw.get("image", "") or "").strip()
    if not image:
        return None
    return {"image": image,
            "subfolder": str(raw.get("subfolder", "") or "").strip()}


def _norm_source(raw):
    """v2v 源片段 {video, subfolder, start, end}（秒）；空值返回 None。"""
    if not isinstance(raw, dict):
        return None
    video = str(raw.get("video", "") or "").strip()
    if not video:
        return None
    try:
        start = max(0.0, float(raw.get("start", 0.0) or 0.0))
        end = float(raw.get("end", 0.0) or 0.0)
    except (TypeError, ValueError):
        return None
    if end <= start:
        return None
    return {"video": video,
            "subfolder": str(raw.get("subfolder", "") or "").strip(),
            "start": start, "end": end}


def infer_task(seg):
    """缺省任务推断：源片段→v2v（有参考资产则 rv2v）；首尾帧→fl2v；
    仅首帧→i2v；有文件资产→r2v；否则 t2v。"""
    explicit = str(seg.get("task", "") or "").strip().lower()
    if explicit in TASK_KEYS:
        return explicit
    has_refs = any(a.get("image") for a in seg.get("assets") or [])
    if seg.get("source"):
        return "rv2v" if has_refs else "v2v"
    if seg.get("first_frame") and seg.get("last_frame"):
        return "fl2v"
    if seg.get("last_frame"):
        return "fl2v"      # 官方支持只传尾帧
    if seg.get("first_frame"):
        return "i2v"
    return "r2v" if has_refs else "t2v"


def parse_payload(raw):
    """接受裸段列表（旧格式）或工作台载荷对象。

    返回 (run_name, run_nonce, global_prompt, globals_rows, assets, segments)。
    prompt 为空的段直接丢弃（v2v 段允许只带源片段）。段的任务模式在
    规范化时一并推断写入 seg["task"]。
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
        seg = {"duration": dur, "prompt": prompt, "nonce": nonce,
               "assets": norm_assets(item.get("assets"),
                                     fallback_category="场景"),
               "enabled": bool(item.get("enabled", True)),
               "first_frame": _norm_frame_ref(item.get("first_frame")),
               "last_frame": _norm_frame_ref(item.get("last_frame")),
               "source": _norm_source(item.get("source"))}
        am = str(item.get("audio_mode", "") or "").strip().lower()
        seg["audio_mode"] = am if am in AUDIO_MODES else "generate"
        seg["task"] = infer_task(seg)
        if prompt or seg["source"]:
            segments.append(seg)
    return run, run_nonce, global_prompt, globals_rows, assets, segments


# ---------------------------------------------------------------------------
# 提示词拼装
# ---------------------------------------------------------------------------

def compose_global(global_prompt, globals_rows, assets):
    """场景级文本块：先是自由文本"通用"行，再是带标签的设定行，
    最后是资产清单——让提示词明确说明每个参考素材是什么。
    图片编 <Picture N>，视频编 <Video K>，音频编 <Audio J>（官方序号）。"""
    lines = []
    if global_prompt:
        lines.append(global_prompt.strip())
    for g in globals_rows or []:
        lines.append("%s：%s" % (g["category"], g["content"]))
    block = "\n".join(lines)
    roster, _ = _asset_roster(assets or [], (0, 0, 0))
    if roster:
        block = (block + "\n" if block else "") + "资产清单：" + roster
    return block


def _asset_roster(assets, offsets):
    """资产清单文本与下一组序号。labels 按 kind 分别编号。"""
    pic, vid, aud = offsets
    labels = []
    for a in assets:
        label = "·".join(x for x in (a["category"], a["name"]) if x)
        if a["image"]:
            kind = a.get("kind", "image")
            if kind == "video":
                vid += 1
                label = "<Video %d>=%s" % (vid, label)
            elif kind == "audio":
                aud += 1
                label = "<Audio %d>=%s" % (aud, label)
            else:
                pic += 1
                label = "<Picture %d>=%s" % (pic, label)
        if a["note"]:
            label += "（%s）" % a["note"]
        labels.append(label)
    return "；".join(labels), (pic, vid, aud)


def compose_seg_extra(seg_assets, offsets):
    """段级清单行；序号接在全局素材之后。offsets = (pic, vid, aud)。"""
    roster, _ = _asset_roster(seg_assets, offsets)
    return ("本段资产：" + roster) if roster else ""


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
    """内容指纹：文件卡取 sha1，纯文本卡取文本内容。"""
    fps = []
    for a in assets or []:
        if a["image"]:
            fps.append(a.get("kind", "image") + ":" +
                       _file_sha1(a["image"], a["subfolder"]))
        else:
            fps.append("text:" + "|".join((a["category"], a["name"], a["note"])))
    return fps


def seg_hash(index, seg):
    """单段内容的身份标识（含段级资产与 v4 任务字段）。
    enabled（选择运行）不入哈希——它决定跑不跑，不改变内容。"""
    parts = ["sd5", index, seg["duration"], seg["prompt"], seg["nonce"],
             seg.get("task", "t2v"), seg.get("audio_mode", "generate")]
    if seg.get("assets"):
        parts.append([[a["category"], a["name"], a["note"], a.get("kind", "image")]
                      for a in seg["assets"]])
        parts.extend(assets_fp(seg["assets"]))
    for key in ("first_frame", "last_frame"):
        ref = seg.get(key)
        if ref:
            parts.append([key, _file_sha1(ref["image"], ref["subfolder"])])
    if seg.get("source"):
        s = seg["source"]
        parts.append(["source", _file_sha1(s["video"], s["subfolder"]),
                      s["start"], s["end"]])
    return hashlib.sha1(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()


def global_hash(run_nonce, width, height, context_length, audio_context_length,
                encode_mode, anchor_mode, audio_mode, crop,
                global_prompt="", globals_rows=None, assets=None, sampling_fp="",
                cache_tag="", seed=-1, continuity=True, seam_blend=True):
    """会改变每一段结果的所有因素。cache_tag 是显式的手动逃生门：
    模型/LoRA 的身份无法被指纹化（ModelPatcher 没有稳定的内容标识），
    所以换了 UNET 或 LoRA 之后改一下这个 tag，缓存就不会误发旧条目。
    seed 只在显式指定（>=0）时入指纹；-1（随机/沿用 meta 的 base_seed）
    不入，否则每次运行都会无谓地全链重渲。
    continuity/seam_blend 改变交付结果，入指纹；vram 清理不改变内容，不入。"""
    parts = ["sd5", run_nonce, width, height, context_length, audio_context_length,
             encode_mode, anchor_mode, audio_mode, crop,
             bool(continuity), bool(seam_blend)]
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


# ---------------------------------------------------------------------------
# Director 时间轴（timeline_data v4）-> 本包载荷 的翻译层
# ---------------------------------------------------------------------------

def _task_key_from_label(value):
    """'t2v — 文生视频(Text to Video)' -> 't2v'（对齐他们的 resolve_task_key）。"""
    v = str(value or "").split(",[object Object]", 1)[0].strip()
    if " · " in v:
        v = v.split(" · ", 1)[0].strip()
    for sep in (" — ", " —— ", " - ", " – "):
        if sep in v:
            return v.split(sep, 1)[0].strip()
    return v or "t2v"


def _d_ref_to_asset(item, kind, seen):
    """Director 参考条目 {imageFile|videoFile|audioFile, subfolder} -> 资产卡。"""
    if not isinstance(item, dict):
        return None
    rel = str(item.get("imageFile") or item.get("videoFile")
               or item.get("audioFile") or item.get("fileName") or "").strip()
    if not rel:
        return None
    card = {"category": "参考", "name": str(item.get("name", "") or "").strip()
            or rel.rsplit("/", 1)[-1].rsplit(".", 1)[0],
            "image": rel.replace("\\", "/"),
            "subfolder": "", "note": "", "kind": kind}
    # imageFile 带相对路径时拆出 subfolder（与输入目录约定一致）
    if "/" in card["image"]:
        card["subfolder"], card["image"] = card["image"].rsplit("/", 1)
    key = (kind, card["subfolder"], card["image"])
    if key in seen:
        return None
    seen.add(key)
    return card


def _d_frame_ref(item):
    """Director 首尾帧引用 {imageFile, subfolder} -> {image, subfolder}。"""
    if not isinstance(item, dict):
        return None
    rel = str(item.get("imageFile") or item.get("fileName") or "").strip()
    if not rel:
        return None
    rel = rel.replace("\\", "/")
    if "/" in rel:
        sub, name = rel.rsplit("/", 1)
        return {"image": name, "subfolder": sub}
    return {"image": rel, "subfolder": ""}


def parse_run_options(raw):
    """run 级可选覆盖：continuity / context_length / audio_mode。
    工作台（Director UI）写进载荷的控制项；None = 跟随 Chain 节点 widget。"""
    try:
        data = json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    cont = data.get("continuity", None)
    ctx = data.get("context_length", None)
    try:
        ctx = int(ctx) if ctx is not None else None
    except (TypeError, ValueError):
        ctx = None
    am = str(data.get("audio_mode", "") or "").strip().lower()
    try:
        sd = int(data.get("seed")) if data.get("seed") is not None else None
        if sd is not None and sd < 0:
            sd = None
    except (TypeError, ValueError):
        sd = None
    try:
        cf = float(data.get("cfg")) if data.get("cfg") is not None else None
    except (TypeError, ValueError):
        cf = None
    return {
        "continuity": None if cont is None else bool(cont),
        "context_length": ctx,
        "audio_mode": am if am in AUDIO_MODES else None,
        "seed": sd,
        "cfg": cf,
    }


def parse_director(timeline_data, task_type, global_prompt, run):
    """把 Director UI 的 timeline_data(v4) 翻译成载荷段列表。

    返回 (global_prompt_out, assets, segments, options)。
    options = {"continuity","context_length","audio_mode"}（同 parse_run_options）。
    """
    try:
        tl = json.loads(timeline_data or "{}")
    except (json.JSONDecodeError, TypeError):
        tl = {}
    if not isinstance(tl, dict):
        tl = {}
    fps = float(tl.get("frameRate") or tl.get("frame_rate") or FPS)
    g = tl.get("global") or {}
    out = tl.get("output") or {}

    gp = str(g.get("prompt", "") or "").strip() or str(global_prompt or "").strip()
    task = _task_key_from_label(g.get("taskType") or task_type)

    seen = set()
    assets = []
    for item in g.get("refs") or []:
        card = _d_ref_to_asset(item, "image", seen)
        if card:
            assets.append(card)

    # v2v 源视频：单源（video.fileName）或多段 videoClips
    vid = tl.get("video") or {}
    src_video = str(vid.get("fileName") or vid.get("videoFile") or "").strip()
    clips = tl.get("videoClips") or []

    segments = []
    run_sel = out.get("runSelection")
    run_sel_on = bool(tl.get("runSelectEnabled") or out.get("runSelectEnabled"))

    def _enabled(i, sid):
        if not run_sel_on or run_sel is None:
            return True
        return (i in run_sel) or (sid in run_sel)

    # fl2v：优先 shots[]（startImage/endImage/durationSec）
    shots = tl.get("shots") or []
    if shots:
        for i, sh in enumerate(shots):
            if not isinstance(sh, dict):
                continue
            try:
                dur = float(sh.get("durationSec") or sh.get("duration") or 5.0)
            except (TypeError, ValueError):
                dur = 5.0
            seg = {"duration": dur, "prompt": str(sh.get("prompt", "") or "").strip(),
                   "nonce": str(sh.get("id", "") or ""),
                   "assets": [], "enabled": _enabled(i, sh.get("id")),
                   "first_frame": _d_frame_ref(sh.get("startImage")),
                   "last_frame": _d_frame_ref(sh.get("endImage")),
                   "source": None, "audio_mode": None, "task": "fl2v"}
            for item in sh.get("refs") or []:
                card = _d_ref_to_asset(item, "image", seen)
                if card:
                    seg["assets"].append(card)
            segments.append(seg)

    if not segments:
        for i, s in enumerate(tl.get("segments") or []):
            if not isinstance(s, dict):
                continue
            try:
                dur = float(s.get("durationSec")
                            or (int(s.get("frameCount", 0)) / fps)
                            or 5.0)
            except (TypeError, ValueError):
                dur = 5.0
            st = _task_key_from_label(s.get("taskType") or task)
            seg = {"duration": round(dur, 3), "prompt": str(s.get("prompt", "") or "").strip(),
                   "nonce": str(s.get("id", "") or ""),
                   "assets": [], "enabled": _enabled(i, s.get("id")),
                   "first_frame": _d_frame_ref(s.get("genImage")),
                   "last_frame": None, "source": None,
                   "audio_mode": None, "task": st}
            for item in s.get("refs") or []:
                card = _d_ref_to_asset(item, "image", seen)
                if card:
                    seg["assets"].append(card)
            for item in s.get("refAudios") or []:
                card = _d_ref_to_asset(item, "audio", seen)
                if card:
                    seg["assets"].append(card)
            for item in s.get("refVideos") or []:
                card = _d_ref_to_asset(item, "video", seen)
                if card:
                    seg["assets"].append(card)
            # v2v/rv2v：段映射到源时间轴 [start, start+length) 帧 -> 秒
            if st in ("v2v", "rv2v"):
                vfile = src_video
                lstart, lend = 0, 0
                if clips:
                    clip = clips[min(i, len(clips) - 1)]
                    vfile = vfile or str(clip.get("videoFile") or clip.get("fileName") or "").strip()
                    lstart = float(clip.get("logicalStart", 0) or 0)
                    lend = float(clip.get("logicalEnd", 0) or 0)
                else:
                    lstart = float(s.get("start", 0) or 0)
                    lend = lstart + float(s.get("length", 0) or 0)
                if lend <= lstart:
                    lend = lstart + dur * fps
                if vfile:
                    seg["source"] = {"video": vfile, "subfolder": "",
                                     "start": round(lstart / fps, 3),
                                     "end": round(lend / fps, 3)}
            segments.append(seg)

    am = str(out.get("audioMode") or out.get("audio_mode") or "").strip().lower()
    if am == "source":
        am = "original"
    options = {
        "continuity": bool(out.get("continuityEnabled")) if "continuityEnabled" in out else None,
        "context_length": (min(39, int(out.get("continuityOverlapFrames")))
                           if out.get("continuityOverlapFrames") else None),
        "audio_mode": am if am in AUDIO_MODES else None,
    }
    return gp, assets, segments, options
