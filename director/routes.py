"""SceneDirector 的后端路由。

两组端点：
  /minimax/director/*      与 Director 前端（js/minimax_timeline.js）对齐的
                           形状——上传/探测/分镜/增强/抽帧，用本包 PyAV 库实现
  /h3_scenedirector/*      本包自有（缓存状态查询）
"""

import base64
import asyncio
import io
import json
import logging
import os
import re
import shutil

from aiohttp import web
from server import PromptServer

import folder_paths

from . import payload as P
from . import cache as C
from . import video_io
from . import shot_detect
from . import prompt_enhance

_LOG = logging.getLogger("h3_scenedirector.routes")

CHUNK_ROOT = os.path.join(folder_paths.get_temp_directory(), "h3sd_upload_chunks")
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-()\u4e00-\u9fff]+")


def _safe_basename(name):
    base = os.path.basename(str(name or "video.mp4").replace("\\", "/"))
    base = _SAFE_NAME.sub("_", base).strip("._")
    return base or "video.mp4"


# ---------------------------------------------------------------------------
# Director 形状端点
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.post("/minimax/director/upload_chunk")
async def upload_chunk(request):
    """分块上传（multipart）：upload_id/filename/chunk/chunk_index/total_chunks。"""
    try:
        post = await request.post()
    except Exception as exc:
        return web.Response(status=400, text="Invalid upload: %s" % exc)
    upload_id = str(post.get("upload_id") or "").strip()
    filename = _safe_basename(post.get("filename"))
    chunk_field = post.get("chunk")
    if not upload_id or chunk_field is None:
        return web.Response(status=400, text="Missing upload_id or chunk.")
    if ".." in upload_id or "/" in upload_id or "\\" in upload_id:
        return web.Response(status=400, text="Invalid upload_id.")
    try:
        chunk_index = int(post.get("chunk_index", 0))
        total_chunks = int(post.get("total_chunks", 1))
    except (TypeError, ValueError):
        return web.Response(status=400, text="Invalid chunk index.")
    if total_chunks < 1 or chunk_index < 0 or chunk_index >= total_chunks:
        return web.Response(status=400, text="Chunk index out of range.")

    session_dir = os.path.join(CHUNK_ROOT, upload_id)
    os.makedirs(session_dir, exist_ok=True)
    part_path = os.path.join(session_dir, "%06d.part" % chunk_index)
    with open(part_path, "wb") as out:
        while True:
            block = chunk_field.file.read(1024 * 1024)
            if not block:
                break
            out.write(block)

    if chunk_index + 1 < total_chunks:
        return web.json_response({"status": "ok", "chunk_index": chunk_index})

    input_dir = folder_paths.get_input_directory()
    out_path = os.path.join(input_dir, filename)
    if os.path.exists(out_path):
        stem, ext = os.path.splitext(filename)
        for n in range(1, 1000):
            cand = "%s_%d%s" % (stem, n, ext)
            if not os.path.exists(os.path.join(input_dir, cand)):
                out_path = os.path.join(input_dir, cand)
                filename = cand
                break
    with open(out_path, "wb") as out:
        for i in range(total_chunks):
            part = os.path.join(session_dir, "%06d.part" % i)
            if not os.path.isfile(part):
                shutil.rmtree(session_dir, ignore_errors=True)
                return web.Response(status=400, text="Missing chunk %d." % i)
            with open(part, "rb") as src:
                shutil.copyfileobj(src, out)
    shutil.rmtree(session_dir, ignore_errors=True)
    _LOG.info("源视频上传完成: %s", filename)
    return web.json_response({"name": filename, "subfolder": "", "type": "input"})


async def _probe(request):
    try:
        if request.can_read_body and request.content_type == "application/json":
            body = await request.json()
        else:
            body = dict(request.query)
    except Exception as exc:
        return web.Response(status=400, text="Invalid request: %s" % exc)
    video_file = str(body.get("videoFile") or body.get("video_file") or "").strip()
    if not video_file:
        return web.Response(status=400, text="Missing videoFile.")
    try:
        info = video_io.probe_video(video_file, str(body.get("subfolder") or ""))
    except Exception as exc:
        return web.Response(status=400, text=str(exc))
    dur = float(info["duration"])
    fps = float(info["fps"]) or 24.0
    return web.json_response({
        "width": info["width"], "height": info["height"],
        "duration": dur, "native_fps": fps,
        "frame_count": max(1, int(round(dur * fps))),
        "probe_method": "pyav",
    })


PromptServer.instance.routes.post("/minimax/director/probe_video")(_probe)
PromptServer.instance.routes.get("/minimax/director/probe_video")(_probe)


@PromptServer.instance.routes.post("/minimax/director/detect_shots")
async def detect_shots(request):
    """智能分镜：帧差切点 -> 逻辑帧号（含 0 与 totalFrames）。"""
    try:
        body = await request.json()
    except Exception as exc:
        return web.Response(status=400, text="Invalid JSON: %s" % exc)
    video_file = ""
    clips = body.get("clips")
    if isinstance(clips, list) and clips:
        video_file = str(clips[0].get("videoFile") or clips[0].get("video_file") or "")
    video_file = video_file or str(body.get("videoFile") or body.get("video_file") or "")
    if not video_file.strip():
        return web.Response(status=400, text="Missing clips[] or videoFile.")
    try:
        frame_rate = float(body.get("frameRate") or body.get("frame_rate") or 24)
        total_frames = int(body.get("totalFrames") or body.get("total_frames") or 0)
        min_shot = float(body.get("minShotFrames") or 12) / frame_rate
    except (TypeError, ValueError):
        return web.Response(status=400, text="Invalid frameRate/totalFrames.")
    try:
        secs = shot_detect.detect_shots(
            video_file.strip(), str(body.get("subfolder") or ""),
            sensitivity=str(body.get("sensitivity") or "medium"),
            min_shot=max(0.2, min_shot))
    except Exception as exc:
        return web.Response(status=400, text=str(exc))
    cut_frames = sorted({0} | {max(1, round(s * frame_rate)) for s in secs}
                        | ({total_frames} if total_frames > 0 else set()))
    return web.json_response({
        "cutFrames": cut_frames,
        "shotCount": max(1, len(cut_frames) - 1),
        "method": "framediff_adaptive",
        "warnings": [],
    })


@PromptServer.instance.routes.post("/minimax/director/extract_frames")
async def extract_frames(request):
    """时间轴缩略图：均匀抽 N 帧返回 JPEG base64。"""
    try:
        body = await request.json()
    except Exception as exc:
        return web.Response(status=400, text="Invalid JSON: %s" % exc)
    video_file = str(body.get("videoFile") or body.get("video_file") or "").strip()
    if not video_file:
        return web.Response(status=400, text="Missing videoFile.")
    try:
        count = max(1, min(48, int(body.get("count", 12) or 12)))
        info = video_io.probe_video(video_file, str(body.get("subfolder") or ""))
        dur = float(info["duration"])
        frames = []
        from PIL import Image
        step = dur / (count + 1)
        for k in range(1, count + 1):
            t0 = step * k
            fr = video_io.decode_frames(video_file, str(body.get("subfolder") or ""),
                                        t0, min(dur, t0 + 1.0 / 24), fps=24, max_frames=1)
            img = Image.fromarray((fr[0].numpy() * 255).astype("uint8"))
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=70)
            frames.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    except Exception as exc:
        return web.Response(status=400, text=str(exc))
    return web.json_response({"frames": frames})


@PromptServer.instance.routes.post("/minimax/director/image_b64")
async def image_b64(request):
    """输入目录图片 -> base64（缩略图用）。"""
    try:
        body = await request.json()
    except Exception as exc:
        return web.Response(status=400, text="Invalid JSON: %s" % exc)
    name = str(body.get("imageFile") or body.get("filename")
               or body.get("name") or "").strip()
    if not name:
        return web.Response(status=400, text="Missing imageFile.")
    path = P._input_file_path(name, str(body.get("subfolder") or ""))
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as exc:
        return web.Response(status=400, text=str(exc))
    return web.json_response({"image_b64": base64.b64encode(data).decode("ascii")})


@PromptServer.instance.routes.post("/minimax/director/enhance_models")
async def enhance_models(request):
    """LLM 增强可用模型列表（探测本地 Ollama，失败给默认）。"""
    import urllib.request
    models = []
    try:
        with urllib.request.urlopen(
                prompt_enhance.DEFAULT_OLLAMA_URL.rstrip("/") + "/tags", timeout=2) as r:
            data = json.loads(r.read().decode("utf-8"))
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
    except Exception:
        pass
    if not models:
        models = [prompt_enhance.DEFAULT_MODEL]
    return web.json_response({"models": models})


@PromptServer.instance.routes.post("/minimax/director/get_template")
async def get_template(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    task = P._task_key_from_label(body.get("task_type") or body.get("task") or "t2v")
    return web.json_response({
        "template": prompt_enhance._template(
            task, float(body.get("duration", 5) or 5),
            output_language=str(body.get("output_language", "") or "")),
        "task_type": task})


@PromptServer.instance.routes.post("/minimax/director/enhance")
async def enhance(request):
    try:
        body = await request.json()
    except Exception as exc:
        return web.json_response({"error": "Invalid JSON: %s" % exc}, status=400)
    model = str(body.get("model") or body.get("llm_model") or "").strip()
    if not model:
        return web.json_response({"error": "No model selected"}, status=400)
    prompt = str(body.get("prompt", "") or "").strip()
    if not prompt:
        return web.json_response({"error": "Empty prompt"}, status=400)
    task = P._task_key_from_label(body.get("task_type") or body.get("task") or "t2v")
    detail = bool(body.get("character_feature_enhance")
                  if body.get("character_feature_enhance") is not None
                  else body.get("llm_character_feature_enhance"))
    try:
        # prompt_enhance 是同步 urllib——直接调会把整个 ComfyUI 事件循环
        # 冻结到 LLM 返回为止（所有 HTTP 排队，界面看起来就是"没反应"）。
        # 扔进线程池，LLM 慢也不挡队列/进度事件/其他请求。
        text = await asyncio.to_thread(
            prompt_enhance.enhance,
            prompt,
            task=task,
            duration=float(body.get("duration", 5.0) or 5.0),
            api_url=str(body.get("llm_url", "") or body.get("api_url", "")
                        or prompt_enhance.DEFAULT_OLLAMA_URL),
            model=model,
            api_key=str(body.get("api_key", "") or body.get("llm_api_key") or ""),
            api_format=str(body.get("api_format", "") or body.get("llm_api_format") or ""),
            images=body.get("images"),
            output_language=str(body.get("output_language", "")
                                or body.get("llm_output_language") or ""),
            character_detail=detail,
            custom_template=str(body.get("custom_template", "") or ""),
            unload_after=bool(body.get("unload_ollama") or body.get("llm_unload_after")))
    except Exception as exc:
        _LOG.exception("enhance 调用失败")
        return web.json_response({"error": "%s: %s" % (type(exc).__name__, exc)},
                                 status=502)
    han_count = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    # 上游同名字段：前端的状态条要读 han_count / detailed_mode / detail_target_han
    node_id = body.get("node") or body.get("node_id")
    if node_id:
        try:
            PromptServer.instance.send_sync("minimax_director_enhanced", {
                "node": node_id, "text": text,
                "segment_index": body.get("segment_index"),
                "field": str(body.get("field", "global") or "global")})
        except Exception:
            pass
    return web.json_response({
        "response": text,
        "han_count": han_count,
        "detailed_mode": bool(detail),
        "character_feature_enhance": bool(detail),
        "detail_target_han": 300 if detail else None,
    })


@PromptServer.instance.routes.post("/minimax/director/unload_model")
async def unload_model(request):
    return web.json_response({"status": "ok"})


@PromptServer.instance.routes.post("/minimax/director/unload_ollama")
async def unload_ollama(request):
    return web.json_response({"status": "ok"})


# ---------------------------------------------------------------------------
# 本包自有端点
# ---------------------------------------------------------------------------

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
        try:
            row_hash = P.seg_hash(i, row)
        except KeyError:
            # 畸形行（缺 duration 等字段，比如旧前端缓存页的轮询）：
            # 按未缓存处理，绝不让状态路由 500
            row_hash = None
        ok = bool(m) and row_hash is not None and m.get("hash") == row_hash \
            and os.path.isfile(C.latent_path(rd, i))
        if not ok and first_dirty is None:
            first_dirty = i
        base = "seg_%04d" % (i + 1)
        poster = (m or {}).get("poster_file")
        if not poster and os.path.isfile(os.path.join(rd, "posters", base + ".jpg")):
            poster = base + ".jpg"
        mp4 = (m or {}).get("mp4_file")
        if not mp4 and os.path.isfile(os.path.join(rd, base + ".mp4")):
            mp4 = base + ".mp4"
        statuses.append({
            "index": i, "cached": ok, "will_render": False,
            "frames": (m or {}).get("frames"), "seed": (m or {}).get("seed"),
            "poster_file": poster, "mp4_file": mp4,
        })
    for i, st in enumerate(statuses):
        st["will_render"] = first_dirty is not None and i >= first_dirty

    return web.json_response({
        "run": run, "base_seed": meta.get("base_seed"),
        "updated": meta.get("updated"), "global_changed": global_changed,
        "rendered": 0 if global_changed else sum(1 for s in statuses if s["cached"]),
        "total": len(statuses), "first_dirty": first_dirty, "statuses": statuses,
    })


# ---------------------------------------------------------------------------
# 显存读数（日志条调试 / 前端轮询备用）
# ---------------------------------------------------------------------------

async def _vram(request):
    from .status import _vram as snap
    used, free, total = snap()
    return web.json_response({"used_gb": used, "free_gb": free,
                              "total_gb": total})


PromptServer.instance.routes.get("/h3_scenedirector/vram")(_vram)
