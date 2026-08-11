"""SceneDirector 的后端路由：工作台前端 POST 当前分镜行，
拿回逐段缓存状态（哈希匹配 + latent 落盘情况）、级联点、
缩略图/段内回放的工件名。
"""

import json
import os

from aiohttp import web
from server import PromptServer

from . import payload as P
from . import cache as C


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
        # 徽标仍按哈希判定（cached=False），展示与缓存状态不冲突。
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
