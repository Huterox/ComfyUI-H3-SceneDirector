"""SceneDirector 自动创作（autoplan）：ReAct agent + 工具集 + 作业管理。

与魔法棒「对话改写」共用同一条项目 session（全项目记忆）——区别只在
入口消息与工具：自动创作的入口是「【自动创作任务】」，agent 按
scenedirector-workbench 手册用工具把工作台布置好。

作业模型（前端抽屉轮询）：
  start → running →（ask_user）→ waiting_user → reply → running → …→ done
  任何时刻可 cancel。job.steps 记录工具调用流水（给抽屉的步骤流）。

草稿（draft）：agent 读写的是工作台副本，不直接动用户的工作台；
用户在前端点「应用到工作台」才落进去（P6）。

路由（POST 均为 JSON body）：
  POST /h3_scenedirector/agent/autoplan         {project, idea, mode, workbench}
  POST /h3_scenedirector/agent/autoplan/reply   {project, message}
  GET  /h3_scenedirector/agent/autoplan/status  ?project=X
  POST /h3_scenedirector/agent/autoplan/cancel  {project}

模块可被离线单测导入：ComfyUI 依赖（folder_paths/studio）延迟到函数内。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
import uuid

from aiohttp import web

from pi_ai import TextContent
from pi_agent_core.types import (
    AgentToolResult,
    MessageEndEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
)

from . import agent_svc

try:  # ComfyUI 运行时才有 server；离线单测没有
    from server import PromptServer
except ImportError:  # pragma: no cover - 单测环境
    PromptServer = None

_LOG = logging.getLogger("h3_scenedirector.autoplan")

# ---------------------------------------------------------------------------
# 时长帧网格（与前端 util.js 同一公式：17k+5，24fps，上限 512）
# ---------------------------------------------------------------------------

MAX_FRAMES = 512


def snap_frames(n):
    n = max(5, int(n or 5))
    while n % 17 != 5:
        n += 1
    return n


def duration_to_frames(seconds, fps=24):
    a = max(0.1, float(seconds or 0.1))
    n = snap_frames(max(5, round(a * fps)))
    if n > MAX_FRAMES:
        n = MAX_FRAMES - ((MAX_FRAMES - 5) % 17)
    return n


def frames_to_duration(frames, fps=24):
    import math
    sec = math.floor(frames / fps * 10) / 10
    while sec > 0.1 and duration_to_frames(sec, fps) > frames:
        sec = round((sec - 0.1) * 10) / 10
    while duration_to_frames(round((sec + 0.1) * 10) / 10, fps) <= frames:
        sec = round((sec + 0.1) * 10) / 10
    return sec


# ---------------------------------------------------------------------------
# 草稿（工作台副本）
# ---------------------------------------------------------------------------

MODES = ("t2v", "i2v", "r2v", "fl2v", "v2v", "rv2v")

_DRAFTS: dict[str, dict] = {}


def _new_draft(mode="r2v"):
    return {
        "mode": mode if mode in MODES else "r2v",
        "frameRate": 24,
        "global": {"prompt": ""},
        "library": [],
        "segments": [],
        "shots": [],
        "output": {},
    }


def get_draft(project):
    """项目草稿（没有就建空草稿）。"""
    if project not in _DRAFTS:
        _DRAFTS[project] = _new_draft()
    return _DRAFTS[project]


def begin_draft(project, mode, workbench):
    """自动创作开工：草稿从当前工作台快照初始化（没有就给空草稿）。"""
    draft = _new_draft(mode)
    if isinstance(workbench, dict):
        tl = workbench.get("timeline") if isinstance(workbench.get("timeline"), dict) \
            else workbench
        for key in ("global", "library", "segments", "shots", "output", "frameRate"):
            if tl.get(key) is not None:
                draft[key] = copy.deepcopy(tl[key])
        if isinstance(workbench.get("mode"), str) and workbench["mode"] in MODES:
            draft["mode"] = workbench["mode"]
    _DRAFTS[project] = draft
    return draft


def _card_key(card):
    return str(card.get("category") or "参考") + "·" + str(card.get("name") or "")


def _unique_card_name(library, category, name):
    """同名自动加（2）（3）……（与前端 uniqueCardName 同规则）。"""
    taken = {str(c.get("name")) for c in library
             if str(c.get("category") or "参考") == category}
    if name not in taken:
        return name
    i = 2
    while ("%s（%d）" % (name, i)) in taken:
        i += 1
    return "%s（%d）" % (name, i)


def normalize_segments(raw, mode, library, fps=24):
    """set_segments 入参 → 工作台分段结构（贴帧网格、libRefs 校验）。"""
    if not isinstance(raw, list) or not raw:
        raise ValueError("segments 必须是非空数组")
    lib_keys = {_card_key(c) for c in library}
    segs = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError("第 %d 段不是对象" % (i + 1))
        frames = duration_to_frames(item.get("durationSec", 5.0), fps)
        refs = item.get("libRefs")
        refs = [str(k) for k in refs if isinstance(k, str)] if isinstance(refs, list) else []
        bad = [k for k in refs if k not in lib_keys]
        if bad:
            raise ValueError("第 %d 段引用了不存在的资产：%s" % (i + 1, "、".join(bad)))
        segs.append({
            "id": uuid.uuid4().hex[:12],
            "durationSec": frames_to_duration(frames, fps),
            "frameCount": frames,
            "prompt": str(item.get("prompt") or "").strip(),
            "taskType": str(item.get("taskType") or mode),
            "refs": [], "refAudios": [], "refVideos": [],
            "libRefs": refs,
            "genImage": {"imageFile": ""},
        })
    return segs


def _draft_brief(draft):
    """给模型看的草稿摘要（省 token，别甩全量提示词）。"""
    lib = [{ "key": _card_key(c), "kind": c.get("kind", "image"),
             "pinned": c.get("pinned") is not False,
             "hasFile": bool(c.get("imageFile"))} for c in draft.get("library") or []]
    segs = [{"i": i + 1, "durationSec": s.get("durationSec"),
             "prompt": (s.get("prompt") or "")[:80]} 
            for i, s in enumerate(draft.get("segments") or [])]
    return {"mode": draft.get("mode"),
            "global_prompt": (draft.get("global") or {}).get("prompt", ""),
            "library": lib, "segments": segs,
            "segment_count": len(segs)}


# ---------------------------------------------------------------------------
# 作业
# ---------------------------------------------------------------------------

_JOBS: dict[str, dict] = {}


def _job_step(job, icon, text):
    job["steps"].append({"t": time.time(), "icon": icon, "text": text})
    if len(job["steps"]) > 300:
        job["steps"] = job["steps"][-300:]


def _args_brief(args, limit=90):
    try:
        s = json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        s = str(args)
    return s if len(s) <= limit else s[:limit] + "…"


# ---------------------------------------------------------------------------
# 工具集
# ---------------------------------------------------------------------------

class _Tool:
    """pi-agent-core AgentTool 的简单实现（绑项目上下文）。"""

    execution_mode = None
    label = ""

    def __init__(self, project, name, description, parameters, fn):
        self.project = project
        self.name = name
        self.description = description
        self.parameters = parameters
        self._fn = fn

    async def execute(self, tool_call_id, params, cancel_event=None, on_update=None):
        # fn 返回 str → 包成文本结果；返回 AgentToolResult（ask_user）→ 原样透传。
        # 抛异常 = 失败（循环捕获转成 error result，让模型自己纠错重试）。
        out = await self._fn(params or {})
        if isinstance(out, AgentToolResult):
            return out
        return AgentToolResult(content=[TextContent(text=str(out))])


def _obj(**props):
    return {"type": "object", "properties": props}


def make_tools(project):
    """项目级工具集（绑该项目的草稿与作业）。"""

    async def fn_get_workbench(_p):
        return json.dumps(_draft_brief(get_draft(project)), ensure_ascii=False, indent=1)

    async def fn_set_mode(p):
        mode = str(p.get("mode") or "")
        if mode not in MODES:
            raise ValueError("mode 必须是 " + "/".join(MODES))
        get_draft(project)["mode"] = mode
        return "已切到 " + mode

    async def fn_set_global_prompt(p):
        text = str(p.get("text") or "").strip()
        if not text:
            raise ValueError("text 为空")
        get_draft(project)["global"]["prompt"] = text
        return "全局提示词已写入（%d 字）" % len(text)

    async def fn_add_asset(p):
        name = str(p.get("name") or "").strip()
        if not name:
            raise ValueError("name 为空")
        draft = get_draft(project)
        cat = str(p.get("category") or "参考").strip() or "参考"
        card = {
            "id": uuid.uuid4().hex[:12],
            "category": cat,
            "name": _unique_card_name(draft["library"], cat, name),
            "kind": str(p.get("kind") or "image"),
            "imageFile": "",
            "note": str(p.get("note") or "").strip(),
            "pinned": bool(p.get("pinned", True)),
        }
        draft["library"].append(card)
        return "已加入资产库：@" + _card_key(card) + "（%s）" % (
            "常驻" if card["pinned"] else "按需")

    async def fn_generate_image(p):
        prompt = str(p.get("prompt") or "").strip()
        name = str(p.get("name") or "").strip()
        if not prompt or not name:
            raise ValueError("prompt / name 都不能为空")
        from . import imagen, studio  # 延迟 import（离线单测无 ComfyUI）
        import folder_paths
        cfg = studio.load_config()
        b64 = await asyncio.to_thread(imagen.generate_image_b64, cfg, prompt,
                                      p.get("size"))
        rel = await asyncio.to_thread(imagen.save_image_b64,
                                      folder_paths.get_input_directory(), b64, name)
        draft = get_draft(project)
        cat = str(p.get("category") or "参考").strip() or "参考"
        # 同名卡：有就换图，没有就新建
        hit = next((c for c in draft["library"]
                    if c.get("name") == name and str(c.get("category") or "参考") == cat), None)
        if hit:
            hit["imageFile"] = rel
            if p.get("note"):
                hit["note"] = str(p["note"])
            card = hit
        else:
            card = {
                "id": uuid.uuid4().hex[:12], "category": cat,
                "name": _unique_card_name(draft["library"], cat, name),
                "kind": "image", "imageFile": rel,
                "note": str(p.get("note") or "").strip(),
                "pinned": bool(p.get("pinned", True)),
            }
            draft["library"].append(card)
        return "图片已生成并入库：@" + _card_key(card) + " → " + rel

    async def fn_set_segments(p):
        draft = get_draft(project)
        segs = normalize_segments(p.get("segments"), draft["mode"], draft["library"],
                                  int(draft.get("frameRate") or 24))
        empty = [i + 1 for i, s in enumerate(segs) if not s["prompt"]]
        if empty:
            raise ValueError("第 %s 段提示词为空" % "、".join(map(str, empty)))
        draft["segments"] = segs
        total = sum(s["durationSec"] for s in segs)
        return "分镜已落定：%d 段，总长 %.1fs" % (len(segs), total)

    async def fn_ask_user(p):
        q = str(p.get("question") or "").strip()
        if not q:
            raise ValueError("question 为空")
        job = _JOBS.get(project)
        if job is not None:
            job["status"] = "waiting_user"
            job["question"] = q
            _job_step(job, "❓", q)
        # terminate：本轮到此为止，等用户回答（reply 路由继续）
        return AgentToolResult(
            content=[TextContent(text="已向用户提问，等待回答。不要继续调用工具。")],
            terminate=True)

    return [
        _Tool(project, "get_workbench",
              "读取当前工作台草稿（模式/全局提示词/资产库/分段摘要）",
              _obj(), fn_get_workbench),
        _Tool(project, "set_mode",
              "切换工作台模式（无素材的创作默认 r2v）",
              _obj(mode={"type": "string", "enum": list(MODES)}), fn_set_mode),
        _Tool(project, "set_global_prompt",
              "写全局提示词（风格/基调/统一设定，拼接到每一段）",
              _obj(text={"type": "string"}), fn_set_global_prompt),
        _Tool(project, "add_asset",
              "加一张无文件的文本设定卡（纯文字描述角色/道具时用；有图需求用 generate_image）",
              _obj(name={"type": "string"}, category={"type": "string"},
                   kind={"type": "string", "enum": ["image", "audio", "video"]},
                   note={"type": "string"}, pinned={"type": "boolean"}),
              fn_add_asset),
        _Tool(project, "generate_image",
              "生成参考图并入库（主角/主场景必做，pinned=true；返回 @键 与文件名）",
              _obj(name={"type": "string"}, prompt={"type": "string"},
                   category={"type": "string"}, note={"type": "string"},
                   pinned={"type": "boolean"}, size={"type": "string"}),
              fn_generate_image),
        _Tool(project, "set_segments",
              "全量落定分镜链（时长自动贴 17k+5 网格；libRefs 必须是已存在的资产键）",
              _obj(segments={"type": "array", "items": _obj(
                  durationSec={"type": "number"}, prompt={"type": "string"},
                  taskType={"type": "string"},
                  libRefs={"type": "array", "items": {"type": "string"}})}),
              fn_set_segments),
        _Tool(project, "ask_user",
              "关键设定不明确时反问用户（题材/风格/时长/角色），挂起等回答",
              _obj(question={"type": "string"}), fn_ask_user),
    ]


# 注册进 agent_svc：项目 agent 建工具时走这里（wand 与 autoplan 同一 agent）
agent_svc.register_tool_factory(make_tools)


def _reset_hook(project):
    _DRAFTS.pop(project, None)
    _JOBS.pop(project, None)


agent_svc.register_reset_hook(_reset_hook)


# ---------------------------------------------------------------------------
# 作业执行
# ---------------------------------------------------------------------------

def _compose_task_message(idea):
    return ("⟦autoplan⟧\n【自动创作任务】\n用户想法：%s\n\n"
            "请按 scenedirector-workbench 手册的流程创作：先规划结构，再备素材，"
            "写全局与分镜，最后总结交付。关键设定不明就 ask_user 反问。" % idea)


async def _run_job(project, user_text):
    job = _JOBS.get(project)
    if job is None:
        return
    try:
        pa = agent_svc.get_project_agent(project)
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        return

    def on_event(event, _cancel):
        if isinstance(event, ToolExecutionStartEvent):
            _job_step(job, "🔧", "%s %s" % (event.tool_name,
                                            _args_brief(event.args)))
        elif isinstance(event, ToolExecutionEndEvent):
            if event.is_error:
                _job_step(job, "✗", "%s 失败" % event.tool_name)
            else:
                _job_step(job, "✓", event.tool_name)
        elif isinstance(event, MessageEndEvent):
            text = agent_svc._extract_text(event.message)
            if getattr(event.message, "role", "") == "assistant" and text.strip():
                job["reply"] = text

    unsub = pa.agent.subscribe(on_event)
    try:
        _reply, _compacted, err = await pa.chat(user_text)
        if err:
            job["status"] = "error"
            job["error"] = str(err)
        elif job["status"] != "waiting_user":
            job["status"] = "done"
            _job_step(job, "🏁", "创作完成")
    except Exception as e:
        _LOG.exception("autoplan 执行失败")
        job["status"] = "error"
        job["error"] = str(e)
    finally:
        unsub()


def start_job(project, idea, mode, workbench):
    """开新作业；已有运行中/等待中的作业返回 None（前端先 cancel 或 reply）。"""
    old = _JOBS.get(project)
    if old and old["status"] in ("running", "waiting_user"):
        return None
    begin_draft(project, mode, workbench)
    job = {"status": "running", "steps": [], "question": None, "reply": None,
           "error": None, "idea": idea, "started": time.time()}
    _JOBS[project] = job
    _job_step(job, "🎬", "开拍：%s" % idea[:80])
    asyncio.get_event_loop().create_task(_run_job(project, _compose_task_message(idea)))
    return job


def reply_job(project, message):
    """用户回答/追改：waiting_user/done/error 状态下继续对话。"""
    job = _JOBS.get(project)
    if job is None or job["status"] == "running":
        return None
    job["status"] = "running"
    job["question"] = None
    job["error"] = None
    _job_step(job, "🗣", message[:80])
    asyncio.get_event_loop().create_task(
        _run_job(project, "⟦autoplan⟧\n%s" % message))
    return job


def job_snapshot(project):
    job = _JOBS.get(project)
    if job is None:
        return {"status": "idle", "steps": []}
    return {"status": job["status"], "steps": job["steps"],
            "question": job["question"], "reply": job["reply"],
            "error": job["error"], "idea": job.get("idea"),
            "draft": get_draft(project)}


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

if PromptServer is not None:

    @PromptServer.instance.routes.post("/h3_scenedirector/agent/autoplan")
    async def autoplan_start(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "非法 JSON"}, status=400)
        body = body or {}
        project = agent_svc._safe_project(body.get("project"))
        idea = str(body.get("idea") or "").strip()
        if not idea:
            return web.json_response({"error": "想法为空"}, status=400)
        job = start_job(project, idea, body.get("mode"), body.get("workbench"))
        if job is None:
            return web.json_response(
                {"error": "已有进行中的自动创作：先回复或取消"}, status=409)
        return web.json_response({"ok": True, "status": job["status"]})

    @PromptServer.instance.routes.post("/h3_scenedirector/agent/autoplan/reply")
    async def autoplan_reply(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "非法 JSON"}, status=400)
        body = body or {}
        project = agent_svc._safe_project(body.get("project"))
        message = str(body.get("message") or "").strip()
        if not message:
            return web.json_response({"error": "消息为空"}, status=400)
        job = reply_job(project, message)
        if job is None:
            return web.json_response({"error": "没有可回复的作业"}, status=409)
        return web.json_response({"ok": True, "status": job["status"]})

    @PromptServer.instance.routes.get("/h3_scenedirector/agent/autoplan/status")
    async def autoplan_status(request):
        project = agent_svc._safe_project(request.query.get("project"))
        return web.json_response(job_snapshot(project))

    @PromptServer.instance.routes.post("/h3_scenedirector/agent/autoplan/cancel")
    async def autoplan_cancel(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "非法 JSON"}, status=400)
        project = agent_svc._safe_project((body or {}).get("project"))
        job = _JOBS.get(project)
        pa = agent_svc._AGENTS.get(project)
        if pa is not None and pa.agent.is_running:
            pa.agent.abort()
        if job is not None:
            job["status"] = "cancelled"
            _job_step(job, "⏹", "用户取消")
        return web.json_response({"ok": True})


__all__ = [
    "snap_frames", "duration_to_frames", "frames_to_duration",
    "get_draft", "begin_draft", "normalize_segments", "make_tools",
    "start_job", "reply_job", "job_snapshot",
]
