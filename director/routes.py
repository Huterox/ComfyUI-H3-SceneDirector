"""SceneDirector 的后端路由。

  POST /h3_scenedirector/status        逐段缓存状态/级联点/工件名
  POST /h3_scenedirector/probe         源视频元信息（v2v）
  POST /h3_scenedirector/upload_video  源视频分块上传（大文件）
  POST /h3_scenedirector/smart_split   智能分镜切点检测
  POST /h3_scenedirector/enhance       LLM 提示词增强
"""

import json
import logging
import os

from aiohttp import web
from server import PromptServer

import folder_paths

from . import payload as P
from . import cache as C
from . import video_io
from . import shot_detect
from . import prompt_enhance

_LOG = logging.getLogger("h3_scenedirector.routes")


@PromptServer.instance.routes.post("/h3_scenedirector/status")
async def status(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    run = P.sanitize_run(body.get("run"))
    rd = C.run_dir(run)
    meta = C.load_meta(rd)

    cached = meta.get("segments") or []
    rows = body.get("segments") or []
    # 改了全局设定或场景资产 => 全链作废（它们进了每一段的条件）
    global_prompt = str(body.get("global_prompt", "") or "").strip()
    globals_rows = P.norm_globals(body.get("globals"))
    afp = P.assets_fp(P.norm_assets(body.get("assets")))
    global_changed = bool(meta) and (
        (meta.get("global_prompt") or "") != global_prompt
        or (meta.get("globals") or []) != globals_rows
        or (meta.get("assets_fp") or []) != afp)
    statuses = []
    first_dirty = 0 if global_changed else None
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            row = {}
        m = cached[i] if i < len(cached) else None
        ok = bool(m) and m.get("hash") == P.seg_hash(i, row) \
            and os.path.isfile(C.latent_path(rd, i))
        if not ok and first_dirty is None:
            first_dirty = i
        # 工件名：meta 里没条目时（比如本次 run 还在渲染中段），
        # 直接看磁盘——海报/mp4 是每段渲完就落盘的，让前端能边渲边显示。
        base = "seg_%04d" % (i + 1)
        poster = (m or {}).get("poster_file")
        if not poster and os.path.isfile(os.path.join(rd, "posters", base + ".jpg")):
            poster = base + ".jpg"
        mp4 = (m or {}).get("mp4_file")
        if not mp4 and os.path.isfile(os.path.join(rd, base + ".mp4")):
            mp4 = base + ".mp4"
        statuses.append({
            "index": i,
            "cached": ok,
            "will_render": False,  # 下面统一填
            "frames": (m or {}).get("frames"),
            "seed": (m or {}).get("seed"),
            "poster_file": poster,
            "mp4_file": mp4,
        })
    for i, st in enumerate(statuses):
        st["will_render"] = first_dirty is not None and i >= first_dirty

    return web.json_response({
        "run": run,
        "base_seed": meta.get("base_seed"),
        "updated": meta.get("updated"),
        "global_changed": global_changed,
        "rendered": 0 if global_changed else sum(1 for s in statuses if s["cached"]),
        "total": len(statuses),
        "first_dirty": first_dirty,
        "statuses": statuses,
    })


@PromptServer.instance.routes.post("/h3_scenedirector/probe")
async def probe(request):
    """源视频元信息：时长/帧率/宽高/音轨（v2v 面板用）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    try:
        info = video_io.probe_video(str(body.get("video", "") or ""),
                                    str(body.get("subfolder", "") or ""))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response(info)


@PromptServer.instance.routes.post("/h3_scenedirector/upload_video")
async def upload_video(request):
    """分块上传源视频：{name, chunk( base64 ), offset, total}。
    全部块到齐后写入输入目录。返回 {name, done, received}。"""
    import base64
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    name = os.path.basename(str(body.get("name", "") or ""))
    if not name:
        return web.json_response({"error": "缺少文件名"}, status=400)
    try:
        offset = int(body.get("offset", 0))
        total = int(body.get("total", 0))
    except (TypeError, ValueError):
        return web.json_response({"error": "offset/total 非法"}, status=400)
    chunk = base64.b64decode(body.get("chunk", "") or "")

    tmp = os.path.join(folder_paths.get_temp_directory(), "h3sd_upload_" + name)
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    mode = "r+b" if os.path.isfile(tmp) else "wb"
    with open(tmp, mode) as f:
        f.seek(offset)
        f.write(chunk)
    received = offset + len(chunk)
    done = total > 0 and received >= total
    if done:
        dst = os.path.join(folder_paths.get_input_directory(), name)
        # 同名已存在则加时间戳后缀，避免覆盖用户已有素材
        if os.path.isfile(dst):
            import time
            stem, ext = os.path.splitext(name)
            name = "%s_%d%s" % (stem, int(time.time()), ext)
            dst = os.path.join(folder_paths.get_input_directory(), name)
        os.replace(tmp, dst)
        _LOG.info("源视频上传完成: %s（%d 字节）", name, received)
    return web.json_response({"name": name, "done": done, "received": received})


@PromptServer.instance.routes.post("/h3_scenedirector/smart_split")
async def smart_split(request):
    """智能分镜：返回切点时间列表（秒）。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    try:
        cuts = shot_detect.detect_shots(
            str(body.get("video", "") or ""),
            str(body.get("subfolder", "") or ""),
            sensitivity=str(body.get("sensitivity", "medium") or "medium"),
            min_shot=float(body.get("min_shot", 1.0) or 1.0))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"cuts": cuts})


@PromptServer.instance.routes.post("/h3_scenedirector/enhance")
async def enhance(request):
    """LLM 提示词增强：{prompt, task, duration, api_url, model, api_key}。"""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    try:
        text = prompt_enhance.enhance(
            str(body.get("prompt", "") or ""),
            task=str(body.get("task", "t2v") or "t2v"),
            duration=float(body.get("duration", 5.0) or 5.0),
            api_url=str(body.get("api_url", "") or prompt_enhance.DEFAULT_OLLAMA_URL),
            model=str(body.get("model", "") or prompt_enhance.DEFAULT_MODEL),
            api_key=str(body.get("api_key", "") or ""))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"prompt": text})
