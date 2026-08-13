"""SceneDirector 项目 agent 服务：pi-agent-core 驱动，session 按项目绑定。

一个项目 = 一条 agent session（SQLite：user/SceneDirector/agent_sessions.db，
pi-storage-sqlite 实现）。魔法棒「对话改写」与「AI 自动创作」共用同一条
session——全项目记忆：改提示词时 agent 记得先前创作时的设定与决策。

LLM 配置统一读工作室层服务配置（studio.load_config()）：
  api_format openai → openai-completions；anthropic → anthropic-messages。

提示词规范：系统提示内联 h3-prompt-writing 技能参考（vendor 在
director/skills/h3-prompt-writing/；base/ref 两篇都带上，agent 按目标
模式自选遵循）。

提案协议（前后端唯一契约）：
  agent 给出的最终版提示词放在 ```prompt 代码块中（块内只有提示词正文）；
  块外允许一两句改动说明；闲聊/提问不给代码块。
  历史消息按同协议还原出"展示文本 + 提案"。

上下文管理：每轮结束估算 token（chars/4 启发式），超过配置
context_window 的 80% 时调用 LLM 做 compaction，session 记 compaction
条目，agent 消息重建为摘要 + 保留尾部。

路由（POST 均为 JSON body）：

  POST /h3_scenedirector/agent/chat     {project, message, target?, assets?}
                                        → {reply, proposal, compacted}
  GET  /h3_scenedirector/agent/history  ?project=X → {messages: [...]}
  POST /h3_scenedirector/agent/reset    {project} → {ok}

模块可被离线单测导入：ComfyUI 专属依赖（server/folder_paths/studio）
全部延迟到函数内 import。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading

from aiohttp import web

from pi_ai import AssistantMessage, Model, TextContent, ToolResultMessage, UserMessage
from pi_agent_core import Agent, AgentOptions
from pi_agent_core.harness.compaction import (
    CompactionSettings,
    compact,
    estimate_context_tokens,
    should_compact,
)
from pi_agent_core.harness.session import Session
from pi_agent_core.types import MessageEndEvent
from pi_storage_sqlite import SqliteSessionRepo

try:  # ComfyUI 运行时才有 server；离线单测没有
    from server import PromptServer
except ImportError:  # pragma: no cover - 单测环境
    PromptServer = None

_LOG = logging.getLogger("h3_scenedirector.agent")

# ---------------------------------------------------------------------------
# 提案协议
# ---------------------------------------------------------------------------

#: 最终版提示词代码块（取最后一个——多轮修订以最新为准）
_PROMPT_BLOCK = re.compile(r"```prompt\s*\n(.*?)```", re.S)
#: 用户消息首行的目标标签 ⟦key⟧（历史按它分拣到各段对话线程）
_TARGET_TAG = re.compile(r"^⟦(.+?)⟧\n")
#: 工作台 agent 展示时从用户消息里提取"用户原话"的部分
_USER_ASK = re.compile(r"用户要求：(.*?)(?:\n\n改写目标：|$)", re.S)


def parse_proposal(text):
    """从回复里解析提案：最后一个 ```prompt 代码块正文；没有返回 None。"""
    blocks = _PROMPT_BLOCK.findall(text or "")
    if not blocks:
        return None
    return blocks[-1].strip() or None


def _extract_text(message):
    """assistant/user 消息 → 纯文本（拼接所有 TextContent 块）。"""
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.text for b in content if isinstance(b, TextContent))
    return ""


def compose_wand_message(target, message, assets=None):
    """魔法棒对话改写的用户消息：⟦目标⟧ 标签 + 用户要求 + 目标现状 + 资产清单。

    target: {key, name, task, duration, text}；assets: [{key, kind, pinned}]
    """
    lines = ["⟦" + str(target.get("key", "chat")) + "⟧",
             "用户要求：" + str(message), ""]
    lines.append("改写目标：%s（%s，%.1fs）" % (
        target.get("name", "目标"),
        target.get("task", ""),
        float(target.get("duration") or 5.0)))
    cur = str(target.get("text") or "").strip()
    if cur:
        lines += ["当前内容：", "<<<", cur, ">>>"]
    else:
        lines.append("当前内容：（空——请从零创作这一段）")
    if assets:
        desc = "、".join(
            "@" + str(a.get("key", "")) + "（" + str(a.get("kind", "image"))
            + ("，常驻" if a.get("pinned") else "") + "）"
            for a in assets if a.get("key"))
        if desc:
            lines += ["", "可用资产：" + desc]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 技能（h3-prompt-writing，vendor 进包自带）
# ---------------------------------------------------------------------------

_SKILL_DIR = os.path.join(os.path.dirname(__file__), "skills", "h3-prompt-writing")
_skill_cache: dict[str, str] = {}


def _read_skill_file(rel):
    if rel in _skill_cache:
        return _skill_cache[rel]
    try:
        with open(os.path.join(_SKILL_DIR, rel), "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    _skill_cache[rel] = text
    return text


def skill_guide():
    """技能参考全文：SKILL.md 正文 + base/ref 两篇模式指南（agent 按目标模式自选）。"""
    parts = []
    body = _read_skill_file("SKILL.md")
    # SKILL.md 带 frontmatter，只取正文
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            body = body[end + 4:].strip()
    if body:
        parts.append(body)
    for ref in ("references/base-en.txt", "references/ref-en.txt"):
        text = _read_skill_file(ref)
        if text:
            parts.append("【%s】\n%s" % (os.path.basename(ref), text))
    return "\n\n".join(parts)


def workbench_guide():
    """scenedirector-workbench 手册正文（自动创作 agent 的操作说明）。"""
    body = _read_skill_file("../scenedirector-workbench/SKILL.md")
    if body.startswith("---"):
        end = body.find("\n---", 3)
        if end != -1:
            body = body[end + 4:].strip()
    return body


_SYSTEM_TEMPLATE = """你是 SceneDirector 工作台的项目 agent——一位专业的 MiniMax H3 视频分镜提示词导演。
你有两种工作方式，整个项目共用你这一条会话：你记得本项目先前所有的设定、素材与创作/改写决策。

# 方式一：对话改写（默认）
用户给出「改写目标」时，帮用户打磨那一段提示词：
- 把最终版提示词完整放进 ```prompt 代码块（块内只有提示词正文，不要任何解说），代码块外最多两句改动说明。
- 用户只是提问/闲聊/征求意见时：直接回答，不要给 ```prompt 代码块。
- 与用户的对话用中文；提示词正文的语言与「当前内容」保持一致（当前为空时遵循技能规范）。
- 不要发明不存在的资产：引用用户提供的资产用 @键（如 @参考·沈青霜）；已有的 <Picture N>/<Subject N> 锚点保持原样、语义不变。
- 时间轴写法（0-1s: … / [Shot 1] At 00:04.000 …）与目标秒数对齐，不得超过目标时长。
- 每段结尾保留 Ending state / handoff 衔接描述（分镜链靠它做段间连续）。

# 方式二：自动创作（消息以 ⟦autoplan⟧ 开头）
你是总导演：按下方《SceneDirector 工作台操作手册》用工具把工作台布置好。
- 修改是全量覆盖语义；动手前先 get_workbench 看现状。
- 关键设定（题材/风格/时长/角色）不明就 ask_user 反问，不要瞎编。
- 完成后用中文一段话总结交付（故事梗概 + 分段结构 + 资产清单），不要给 ```prompt 代码块。

# 提示词规范（h3-prompt-writing 技能）
{guide}

# SceneDirector 工作台操作手册
{manual}
"""


def system_prompt():
    return (_SYSTEM_TEMPLATE
            .replace("{guide}", skill_guide())
            .replace("{manual}", workbench_guide()))


# ---------------------------------------------------------------------------
# 模型与配置
# ---------------------------------------------------------------------------

def model_from_config(cfg):
    """服务配置 → pi-ai Model。api_format: openai → openai-completions，
    anthropic → anthropic-messages。"""
    llm = (cfg or {}).get("llm") or {}
    fmt = llm.get("api_format", "openai")
    api = "anthropic-messages" if fmt == "anthropic" else "openai-completions"
    return Model(
        id=llm.get("model") or "",
        name=llm.get("model") or "",
        api=api,
        provider=fmt,
        base_url=llm.get("base_url") or "",
        reasoning=False,
        input=["text"],
        context_window=int(llm.get("context_window") or 200000),
        max_tokens=int(llm.get("max_tokens") or 8192),
    )


def _config_fingerprint(cfg):
    llm = (cfg or {}).get("llm") or {}
    return (llm.get("api_format"), llm.get("base_url"),
            llm.get("model"), llm.get("api_key"),
            llm.get("context_window"), llm.get("max_tokens"))


# ---------------------------------------------------------------------------
# 项目 agent
# ---------------------------------------------------------------------------

class ProjectAgent:
    """一个项目的 agent：pi Agent + SQLite session + 串行锁。

    session 是唯一事实源：agent 进程内缓存可从 session 重建（配置变更/
    服务重启都不丢对话）。
    """

    def __init__(self, project, session, model, api_key="", sys_prompt="", tools=None):
        self.project = project
        self.session = session
        self.lock = asyncio.Lock()
        self.fingerprint = None     # 由池子填：配置指纹，变了就重建
        self._api_key = api_key
        self._hydrating = False
        opts = AgentOptions(
            initial_state={
                "system_prompt": sys_prompt or system_prompt(),
                "model": model,
                "tools": list(tools or []),
            },
            get_api_key=lambda provider: self._api_key,
        )
        self.agent = Agent(opts)
        self.agent.subscribe(self._on_event)
        self._hydrate()

    # -- session 同步 --------------------------------------------------------

    def _hydrate(self):
        """从 session 重建 agent 消息（启动/compaction 后）。"""
        self._hydrating = True
        try:
            self.agent.state.messages = list(self.session.build_context())
        finally:
            self._hydrating = False

    def _on_event(self, event, _cancel):
        # 消息落盘：loop 里每完成一条（user/assistant/toolResult）就追加
        if self._hydrating:
            return
        if isinstance(event, MessageEndEvent):
            try:
                self.session.append_message(event.message)
            except Exception as e:  # 落盘失败不挡对话
                _LOG.warning("session 落盘失败: %s", e)

    # -- 对话 ----------------------------------------------------------------

    async def chat(self, text):
        """跑一轮对话，返回 (assistant_reply, compacted, error)。"""
        async with self.lock:
            await self.agent.prompt(text)
            reply = None
            for m in reversed(self.agent.state.messages):
                if isinstance(m, AssistantMessage):
                    reply = m
                    break
            err = self.agent.state.error_message
            if reply is not None and getattr(reply, "error_message", None):
                err = err or reply.error_message
            compacted = False
            if not err:
                compacted = await self._maybe_compact()
            return reply, compacted, err

    async def _maybe_compact(self):
        window = int(getattr(self.agent.state.model, "context_window", 0) or 0)
        settings = CompactionSettings(enabled=True)
        messages = self.agent.state.messages
        if not should_compact(estimate_context_tokens(messages), window, settings):
            return False
        try:
            result = await compact(self.agent.state.model, messages, settings,
                                   api_key=self._api_key or None)
        except Exception as e:
            _LOG.warning("compaction 失败（保持原上下文）: %s", e)
            return False
        if not result.removed_count:
            return False
        self.session.append_compaction(result.summary, result.retained_tail)
        self._hydrate()
        return True


# ---------------------------------------------------------------------------
# agent 池（进程内缓存；session 在 SQLite，重启不丢）
# ---------------------------------------------------------------------------

_AGENTS: dict[str, ProjectAgent] = {}
_REPO = None
_REPO_LOCK = threading.Lock()
#: 工作台快照缓存（前端随请求推上来，P5 的 agent 工具从这里读工作台）
_WORKBENCH: dict[str, dict] = {}
#: 工具工厂（autoplan 注册）：project -> [AgentTool...]
_TOOL_FACTORY = None
#: 项目重置钩子（autoplan 注册：清草稿与作业）
_RESET_HOOKS: list = []


def register_tool_factory(fn):
    """注册项目级工具工厂（autoplan.py 导入时调用）。"""
    global _TOOL_FACTORY
    _TOOL_FACTORY = fn


def register_reset_hook(fn):
    """注册项目重置钩子（autoplan.py 导入时调用）。"""
    _RESET_HOOKS.append(fn)


def _db_path():
    from . import studio  # 延迟 import：离线单测没有 ComfyUI
    return os.path.join(studio._root(), "agent_sessions.db")


def _repo():
    global _REPO
    with _REPO_LOCK:
        if _REPO is None:
            _REPO = SqliteSessionRepo(_db_path())
    return _REPO


def _session_for(project):
    """按项目名找 session（metadata.project）；没有就新建。"""
    repo = _repo()
    for meta in repo.list():
        if (meta.get("metadata") or {}).get("project") == project:
            return meta["id"], Session(repo.open(meta["id"]))
    sid, storage = repo.create(cwd="scenedirector", metadata={"project": project})
    return sid, Session(storage)


def get_project_agent(project, cfg=None):
    """取（或建）项目 agent。LLM 未配置抛 RuntimeError。"""
    from . import studio
    cfg = cfg or studio.load_config()
    llm = cfg.get("llm") or {}
    if not llm.get("base_url") or not llm.get("model"):
        raise RuntimeError("LLM 未配置：点「⚙ 服务配置」（工作台全局设置区头部 / AI 自动创作视图头部都有入口）填 Base URL / 模型 / Key")
    fp = _config_fingerprint(cfg)
    cached = _AGENTS.get(project)
    if cached and cached.fingerprint == fp:
        return cached
    # 首次或配置变更：session 不变，agent 重建（消息从 session 恢复）
    _sid, session = _session_for(project)
    tools = _TOOL_FACTORY(project) if _TOOL_FACTORY else []
    pa = ProjectAgent(project, session, model_from_config(cfg),
                      api_key=llm.get("api_key") or "", tools=tools)
    pa.fingerprint = fp
    _AGENTS[project] = pa
    return pa


def history_view(messages):
    """session 消息 → 前端气泡 [{role, target, text, proposal}]。

    - 跳过 toolResult 与 compaction 摘要占位消息；
    - 用户消息剥掉 ⟦target⟧ 标签，展示文本只留"用户原话"。
    """
    out = []
    for m in messages:
        role = getattr(m, "role", "")
        if isinstance(m, ToolResultMessage):
            continue
        if role == "user":
            text = _extract_text(m)
            if text.startswith("[Previous conversation summary]"):
                continue
            target = None
            mt = _TARGET_TAG.match(text)
            if mt:
                target = mt.group(1)
                text = text[mt.end():]
            mq = _USER_ASK.search(text)
            disp = mq.group(1).strip() if mq else text.strip()
            if disp:
                out.append({"role": "user", "target": target, "text": disp})
        elif role == "assistant":
            text = _extract_text(m)
            if not text.strip():
                continue
            out.append({"role": "assistant", "target": None,
                        "text": text, "proposal": parse_proposal(text)})
    return out


def reset_project(project):
    """删 session + 清池（项目本身的存档不动）。"""
    repo = _repo()
    victim = None
    for meta in repo.list():
        if (meta.get("metadata") or {}).get("project") == project:
            victim = meta["id"]
            break
    _AGENTS.pop(project, None)
    _WORKBENCH.pop(project, None)
    for hook in _RESET_HOOKS:
        try:
            hook(project)
        except Exception as e:
            _LOG.warning("重置钩子失败: %s", e)
    if victim:
        repo.delete(victim)
        return True
    return False


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

def _safe_project(name):
    from . import studio
    return studio._safe_name(name) or "__current__"


if PromptServer is not None:

    @PromptServer.instance.routes.post("/h3_scenedirector/agent/chat")
    async def agent_chat(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "非法 JSON"}, status=400)
        body = body or {}
        project = _safe_project(body.get("project"))
        message = str(body.get("message") or "").strip()
        if not message:
            return web.json_response({"error": "消息为空"}, status=400)
        if isinstance(body.get("workbench"), dict):
            _WORKBENCH[project] = body["workbench"]
        target = body.get("target") if isinstance(body.get("target"), dict) else None
        assets = body.get("assets") if isinstance(body.get("assets"), list) else None
        user_text = (compose_wand_message(target, message, assets)
                     if target else message)
        try:
            pa = get_project_agent(project)
        except RuntimeError as e:
            return web.json_response({"error": str(e)}, status=400)
        except Exception as e:  # session 损坏等
            _LOG.exception("agent 初始化失败")
            return web.json_response({"error": "agent 初始化失败: %s" % e}, status=500)
        if pa.lock.locked():
            return web.json_response({"error": "agent 正在思考中，稍等"}, status=409)
        try:
            reply, compacted, err = await pa.chat(user_text)
        except Exception as e:
            _LOG.exception("agent 对话失败")
            return web.json_response({"error": "对话失败: %s" % e}, status=500)
        if err:
            return web.json_response({"error": str(err)}, status=502)
        text = _extract_text(reply) if reply is not None else ""
        if not text.strip():
            return web.json_response({"error": "模型返回为空"}, status=502)
        return web.json_response({
            "reply": text,
            "proposal": parse_proposal(text),
            "compacted": bool(compacted),
        })

    @PromptServer.instance.routes.get("/h3_scenedirector/agent/history")
    async def agent_history(request):
        project = _safe_project(request.query.get("project"))
        try:
            repo = _repo()
            sid = None
            for meta in repo.list():
                if (meta.get("metadata") or {}).get("project") == project:
                    sid = meta["id"]
                    break
            if not sid:
                return web.json_response({"messages": []})
            session = Session(repo.open(sid))
            return web.json_response({"messages": history_view(session.build_context())})
        except Exception as e:
            _LOG.exception("历史读取失败")
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/h3_scenedirector/agent/reset")
    async def agent_reset(request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response({"error": "非法 JSON"}, status=400)
        project = _safe_project((body or {}).get("project"))
        try:
            return web.json_response({"ok": reset_project(project)})
        except Exception as e:
            _LOG.exception("agent 重置失败")
            return web.json_response({"error": str(e)}, status=500)


__all__ = [
    "ProjectAgent",
    "parse_proposal",
    "compose_wand_message",
    "model_from_config",
    "system_prompt",
    "skill_guide",
    "workbench_guide",
    "history_view",
    "get_project_agent",
    "reset_project",
    "register_tool_factory",
    "register_reset_hook",
]
