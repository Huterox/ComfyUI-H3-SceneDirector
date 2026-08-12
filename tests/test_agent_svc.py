"""agent_svc 离线单测：提案解析 / 消息组装 / 模型映射 / faux 全链路
（对话 → session 落盘 → 重建恢复 → 历史视图）。

    python tests/test_agent_svc.py
"""

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pi_ai.providers.faux import FAUX_MODEL, FauxScript, clear_scripts, push_script
from pi_agent_core.harness.session import InMemorySessionStorage, Session

from director import agent_svc as A  # noqa: E402

PASS = []


def check(name, cond, extra=""):
    PASS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("  " + str(extra) if extra and not cond else ""))


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

def test_parse_proposal():
    check("proposal_none", A.parse_proposal("随便聊聊") is None)
    check("proposal_basic",
          A.parse_proposal('说明\n```prompt\n0-1s: 晨雾。\n```\n尾') == "0-1s: 晨雾。")
    multi = '```prompt\n第一版\n```\n中间话\n```prompt\n第二版\n```'
    check("proposal_last", A.parse_proposal(multi) == "第二版")
    check("proposal_empty_block", A.parse_proposal("```prompt\n   \n```") is None)


def test_compose_wand_message():
    t = {"key": "2", "name": "片段 2", "task": "r2v", "duration": 8.0,
         "text": "旧提示词"}
    msg = A.compose_wand_message(t, "改成夜景", [{"key": "参考·沈青霜",
                                                  "kind": "image", "pinned": True}])
    check("wand_tag", msg.startswith("⟦2⟧"))
    check("wand_ask", "用户要求：改成夜景" in msg)
    check("wand_target", "改写目标：片段 2（r2v，8.0s）" in msg)
    check("wand_current", "<<<\n旧提示词\n>>>" in msg)
    check("wand_assets", "@参考·沈青霜（image，常驻）" in msg)
    t2 = {"key": "global", "name": "全局提示词", "task": "t2v", "duration": 5, "text": ""}
    check("wand_empty", "（空——请从零创作这一段）"
          in A.compose_wand_message(t2, "写点啥"))


def test_model_from_config():
    m = A.model_from_config({"llm": {"api_format": "openai", "base_url": "http://x",
                                      "model": "gpt-x", "context_window": 128000,
                                      "max_tokens": 4096}})
    check("model_openai", m.api == "openai-completions" and m.context_window == 128000)
    m2 = A.model_from_config({"llm": {"api_format": "anthropic", "base_url": "http://y",
                                       "model": "claude-x"}})
    check("model_anthropic", m2.api == "anthropic-messages" and m2.max_tokens == 8192)


def test_system_prompt():
    sp = A.system_prompt()
    check("sys_has_guide", "h3-prompt-writing" in sp and "integrated_multimodal_description" in sp)
    check("sys_has_contract", "```prompt" in sp and "⟦autoplan⟧" in sp)
    check("sys_has_manual", "工作台操作手册" in sp and "17k+5" in sp)


def test_history_view():
    user = A.compose_wand_message(
        {"key": "0", "name": "片段 1", "task": "r2v", "duration": 5, "text": "旧"},
        "改短一点") 
    from pi_ai import UserMessage, AssistantMessage, TextContent
    msgs = [
        UserMessage(content="[Previous conversation summary]\n旧摘要"),
        UserMessage(content=user),
        AssistantMessage(content=[TextContent(text='改好了：\n```prompt\n新版提示词\n```')],
                         api="faux", provider="faux", model="faux"),
        UserMessage(content="没有标签的闲聊"),
        AssistantMessage(content=[TextContent(text="好的")],
                         api="faux", provider="faux", model="faux"),
    ]
    view = A.history_view(msgs)
    check("hist_len", len(view) == 4, view)
    check("hist_skip_summary", all("Previous conversation" not in v["text"] for v in view))
    check("hist_target", view[0]["target"] == "0")
    check("hist_disp", view[0]["text"] == "改短一点", view[0])
    check("hist_proposal", view[1]["proposal"] == "新版提示词")
    check("hist_plain", view[2]["target"] is None and view[2]["text"] == "没有标签的闲聊")


# ---------------------------------------------------------------------------
# faux 全链路：对话 → 落盘 → 重建恢复
# ---------------------------------------------------------------------------

def test_chat_flow():
    clear_scripts()
    storage = InMemorySessionStorage(metadata={"project": "t"})
    pa = A.ProjectAgent("t", Session(storage), FAUX_MODEL, api_key="")

    push_script(FauxScript(text='改成夜景了：\n```prompt\n夜景版\n```'))
    reply, compacted, err = asyncio.run(pa.chat("⟦0⟧\n用户要求：改成夜景"))
    check("chat_err_none", err is None)
    check("chat_reply", "夜景版" in A._extract_text(reply))
    check("chat_not_compacted", compacted is False)
    # 落盘：user + assistant 两条
    entries = storage.get_entries()
    check("chat_persisted", len(entries) == 2, len(entries))

    # 第二轮：agent 记得第一轮（faux 不回上下文，但 session 里应有 4 条）
    push_script(FauxScript(text="再短一点版本：\n```prompt\n夜景短版\n```"))
    asyncio.run(pa.chat("⟦0⟧\n用户要求：再短一点"))
    check("chat_persisted2", len(storage.get_entries()) == 4)
    check("chat_memory", len(pa.agent.state.messages) == 4)

    # 重建：新实例从 session 恢复
    pa2 = A.ProjectAgent("t", Session(storage), FAUX_MODEL, api_key="")
    check("chat_rehydrated", len(pa2.agent.state.messages) == 4)
    view = A.history_view(pa2.session.build_context())
    check("chat_history_view", len(view) == 4
          and view[-1]["proposal"] == "夜景短版", view)

    # 错误路径：faux error → err 传出
    push_script(FauxScript(error="boom"))
    _r, _c, err2 = asyncio.run(pa.chat("再来"))
    check("chat_error", err2 == "boom", err2)
    clear_scripts()


def test_compaction():
    clear_scripts()
    storage = InMemorySessionStorage()
    pa = A.ProjectAgent("c", Session(storage), FAUX_MODEL, api_key="")
    # 人为把窗口压小触发 compaction；消息要大到超过保留尾（8k token）
    pa.agent.state.model = FAUX_MODEL.model_copy(update={"context_window": 100})
    push_script(FauxScript(text="第一轮回复"))      # chat 回复
    push_script(FauxScript(text="摘要：聊了改写"))  # compaction 的 summary 调用
    big = "超长上下文。" * 8000   # ~4.8 万字符 ≈ 1.2 万 token > 保留尾 8000
    _r, compacted, err = asyncio.run(pa.chat(big))
    check("compact_triggered", compacted is True, err)
    kinds = [e.type for e in storage.get_entries()]
    check("compact_entry", "compaction" in kinds, kinds)
    # agent 消息已重建：摘要 user + 保留尾
    check("compact_rebuilt", len(pa.agent.state.messages) < 10,
          len(pa.agent.state.messages))
    clear_scripts()


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    test_parse_proposal()
    test_compose_wand_message()
    test_model_from_config()
    test_system_prompt()
    test_history_view()
    test_chat_flow()
    test_compaction()
    bad = [n for n, ok in PASS if not ok]
    print("---- %d/%d 通过 ----" % (len(PASS) - len(bad), len(PASS)))
    if bad:
        sys.exit(1)
