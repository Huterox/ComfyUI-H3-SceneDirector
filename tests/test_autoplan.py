"""autoplan 离线单测：帧网格 / 草稿与工具 / faux 作业流（含 ask_user 挂起-回复）。

    python tests/test_autoplan.py
"""

import asyncio
import json
import os
import sys
import tempfile
import types

# --- stub ComfyUI 依赖（studio/imagen 延迟 import 会碰到它们） --------------
TMP = tempfile.mkdtemp(prefix="h3sd_autoplan_test_")
_fp = types.ModuleType("folder_paths")
_fp.get_user_directory = lambda: TMP
_fp.get_input_directory = lambda: TMP
sys.modules["folder_paths"] = _fp
_srv = types.ModuleType("server")


class _FakeRoutes:
    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


_srv.PromptServer = types.SimpleNamespace(
    instance=types.SimpleNamespace(routes=_FakeRoutes()))
sys.modules["server"] = _srv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "vendor"))  # vendored pi 运行时

from pi_ai import ToolCall  # noqa: E402
from pi_ai.providers.faux import FAUX_MODEL, FauxScript, clear_scripts, push_script  # noqa: E402
from pi_agent_core.harness.session import InMemorySessionStorage, Session  # noqa: E402

from director import agent_svc as A  # noqa: E402
from director import autoplan as AP  # noqa: E402
from director import imagen  # noqa: E402

PASS = []


def check(name, cond, extra=""):
    PASS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("  " + str(extra) if extra and not cond else ""))


# ---------------------------------------------------------------------------
# 帧网格
# ---------------------------------------------------------------------------

def test_grid():
    check("snap_120", AP.snap_frames(120) == 124, AP.snap_frames(120))
    check("snap_5", AP.snap_frames(1) == 5)
    check("snap_cap", AP.duration_to_frames(60) <= AP.MAX_FRAMES)
    check("grid_5s", AP.duration_to_frames(5.0) == 124)
    check("grid_5s_back", AP.frames_to_duration(124) == 5.1)
    check("grid_roundtrip",
          AP.duration_to_frames(AP.frames_to_duration(192)) == 192)
    # 与前端已知档位一致：8.0s = 192 帧
    check("grid_8s", AP.frames_to_duration(192) == 8.0)


# ---------------------------------------------------------------------------
# 草稿与工具
# ---------------------------------------------------------------------------

def _find_tool(tools, name):
    return next(t for t in tools if t.name == name)


def test_tools():
    proj = "__t_tools__"
    AP._DRAFTS.pop(proj, None)
    tools = make = AP.make_tools(proj)
    names = sorted(t.name for t in tools)
    check("tools_full", names == ["add_asset", "ask_user", "generate_image",
                                  "get_workbench", "set_global_prompt",
                                  "set_mode", "set_segments"], names)

    async def go():
        # set_mode
        r = await _find_tool(tools, "set_mode").execute("c1", {"mode": "r2v"})
        assert "r2v" in r.content[0].text
        # set_global_prompt
        await _find_tool(tools, "set_global_prompt").execute(
            "c2", {"text": "武侠水墨电影感"})
        # add_asset 两张：同名自动加（2）
        await _find_tool(tools, "add_asset").execute(
            "c3", {"name": "沈青霜", "category": "角色", "note": "青衫女剑客"})
        r2 = await _find_tool(tools, "add_asset").execute(
            "c4", {"name": "沈青霜", "category": "角色"})
        assert "沈青霜（2）" in r2.content[0].text
        # set_segments：贴网格 + libRefs 校验
        segs = [
            {"durationSec": 5.0, "prompt": "开场", "libRefs": ["角色·沈青霜"]},
            {"durationSec": 8.0, "prompt": "对打"},
        ]
        r3 = await _find_tool(tools, "set_segments").execute(
            "c5", {"segments": segs})
        assert "2 段" in r3.content[0].text
        # get_workbench 摘要
        r4 = await _find_tool(tools, "get_workbench").execute("c6", {})
        brief = json.loads(r4.content[0].text)
        assert brief["mode"] == "r2v" and brief["segment_count"] == 2
        assert brief["global_prompt"] == "武侠水墨电影感"
        return brief

    brief = asyncio.run(go())
    draft = AP.get_draft(proj)
    check("draft_segments", len(draft["segments"]) == 2)
    check("draft_seg_grid", draft["segments"][0]["frameCount"] == 124
          and draft["segments"][1]["frameCount"] == 192,
          [s["frameCount"] for s in draft["segments"]])
    check("draft_seg_refs", draft["segments"][0]["libRefs"] == ["角色·沈青霜"])
    check("draft_unique_name", any(c["name"] == "沈青霜（2）"
                                   for c in draft["library"]))
    check("draft_brief", brief["library"][0]["key"] == "角色·沈青霜")

    # 错误路径：引用不存在的资产
    async def bad():
        try:
            await _find_tool(tools, "set_segments").execute(
                "c7", {"segments": [{"durationSec": 5, "prompt": "x",
                                     "libRefs": ["角色·不存在"]}]})
            return None
        except ValueError as e:
            return str(e)
    err = asyncio.run(bad())
    check("tool_bad_ref", err and "不存在" in err, err)


def test_generate_image_tool():
    proj = "__t_img__"
    AP._DRAFTS.pop(proj, None)
    tools = AP.make_tools(proj)
    # monkeypatch 生图链路（不发网络），完事恢复，别污染后面的用例
    orig_gen, orig_save = imagen.generate_image_b64, imagen.save_image_b64
    imagen.generate_image_b64 = lambda cfg, prompt, size=None: "aGVsbG8="
    calls = {}
    def fake_save(input_dir, b64, name_hint="asset"):
        calls["dir"] = input_dir
        calls["name"] = name_hint
        return "scenedirector/fake.png"
    imagen.save_image_b64 = fake_save
    try:
        # studio.load_config 走 stub 的 user dir（空配置也无所谓，生图已被 patch）
        async def go():
            return await _find_tool(tools, "generate_image").execute(
                "c1", {"name": "沈青霜", "category": "角色",
                       "prompt": "青衫女剑客，水墨风", "pinned": True})
        r = asyncio.run(go())
        text = r.content[0].text
        check("genimg_text", "角色·沈青霜" in text and "scenedirector/fake.png" in text,
              text)
        card = AP.get_draft(proj)["library"][0]
        check("genimg_card", card["imageFile"] == "scenedirector/fake.png"
              and card["pinned"] is True and card["kind"] == "image")
        # 第二次同名：换图不新增
        asyncio.run(_find_tool(tools, "generate_image").execute(
            "c2", {"name": "沈青霜", "category": "角色", "prompt": "再来一张"}))
        check("genimg_upsert", len(AP.get_draft(proj)["library"]) == 1)
    finally:
        imagen.generate_image_b64, imagen.save_image_b64 = orig_gen, orig_save


def test_imagen_parsers():
    # seedream 回包解析
    b64 = imagen._extract_b64_seedream({"data": [{"b64_json": "QUJD"}]})
    check("imagen_seedream", b64 == "QUJD")
    # nanobanana 三种形态
    d1 = {"choices": [{"message": {"images": [{"b64_json": "QUJD"}]}}]}
    d2 = {"choices": [{"message": {"content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}]}}]}
    d3 = {"choices": [{"message": {"content": "这里是图 data:image/png;base64,QUJD 完"}}]}
    check("imagen_nano1", imagen._extract_b64_nanobanana(d1) == "QUJD")
    check("imagen_nano2", imagen._extract_b64_nanobanana(d2) == "QUJD")
    check("imagen_nano3", imagen._extract_b64_nanobanana(d3) == "QUJD")
    # 服务未启用
    try:
        imagen.generate_image_b64({"image": {"provider": "disabled"}}, "x")
        check("imagen_disabled", False)
    except RuntimeError as e:
        check("imagen_disabled", "未启用" in str(e))


# ---------------------------------------------------------------------------
# 作业流（faux provider）
# ---------------------------------------------------------------------------

def _make_faux_agent(project):
    """造一个 faux 后端的 ProjectAgent 塞进池子（绕过真实 LLM）。"""
    # 池子入口要读服务配置：写一份假配置（model/base_url 占位，实际走 faux）
    cfg_dir = os.path.join(TMP, "SceneDirector")
    os.makedirs(cfg_dir, exist_ok=True)
    with open(os.path.join(cfg_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"llm": {"api_format": "openai", "base_url": "http://faux.local",
                            "api_key": "x", "model": "faux",
                            "context_window": 1000000, "max_tokens": 4096},
                   "image": {"provider": "disabled"}}, f)
    pa = A.ProjectAgent(project, Session(InMemorySessionStorage()),
                        FAUX_MODEL, api_key="", tools=AP.make_tools(project))
    # 指纹对齐，get_project_agent 直接命中缓存
    from director import studio
    pa.fingerprint = A._config_fingerprint(studio.load_config())
    A._AGENTS[project] = pa
    return pa


def test_job_flow():
    proj = "__t_job__"
    clear_scripts()
    AP._DRAFTS.pop(proj, None)
    AP._JOBS.pop(proj, None)
    pa = _make_faux_agent(proj)

    push_script(FauxScript(tool_calls=[
        ToolCall(id="c1", name="set_global_prompt",
                 arguments={"text": "雨夜都市，赛博朋克"}),
        ToolCall(id="c2", name="set_segments", arguments={"segments": [
            {"durationSec": 5, "prompt": "开场：霓虹雨夜"},
            {"durationSec": 5, "prompt": "追逐：楼顶跑酷"},
        ]}),
    ]))
    push_script(FauxScript(text="创作完成：两段式跑酷短片。"))

    async def go():
        job = AP.start_job(proj, "拍个雨夜跑酷", "t2v", None)
        assert job is not None
        for _ in range(200):
            await asyncio.sleep(0.02)
            if job["status"] != "running":
                break
        return job

    job = asyncio.run(go())
    check("job_done", job["status"] == "done", job["status"])
    check("job_reply", "跑酷" in (job["reply"] or ""), job["reply"])
    draft = AP.get_draft(proj)
    check("job_draft", draft["global"]["prompt"] == "雨夜都市，赛博朋克"
          and len(draft["segments"]) == 2)
    check("job_steps", any("set_segments" in s["text"] for s in job["steps"]),
          [s["text"] for s in job["steps"]])
    check("job_session", len(pa.session.get_entries()) >= 4,
          len(pa.session.get_entries()))
    # 快照
    snap = AP.job_snapshot(proj)
    check("job_snapshot", snap["status"] == "done" and snap["draft"]["mode"] == "t2v")


def test_ask_user_flow():
    proj = "__t_ask__"
    clear_scripts()
    AP._DRAFTS.pop(proj, None)
    AP._JOBS.pop(proj, None)
    _make_faux_agent(proj)

    push_script(FauxScript(tool_calls=[
        ToolCall(id="c1", name="ask_user",
                 arguments={"question": "想要什么风格？"}),
    ]))
    push_script(FauxScript(text="明白了，水墨风，马上开拍。"))

    async def go():
        job = AP.start_job(proj, "拍个短片", "r2v", None)
        for _ in range(200):
            await asyncio.sleep(0.02)
            if job["status"] != "running":
                break
        assert job["status"] == "waiting_user", job["status"]
        assert job["question"] == "想要什么风格？"
        # 用户回答 → 继续
        AP.reply_job(proj, "水墨风")
        for _ in range(200):
            await asyncio.sleep(0.02)
            if job["status"] != "running":
                break
        return job

    job = asyncio.run(go())
    check("ask_done", job["status"] == "done", job["status"])
    check("ask_reply", "水墨风" in (job["reply"] or ""))
    check("ask_steps", any(s["icon"] == "❓" for s in job["steps"]))
    check("ask_question_cleared", job["question"] is None)


def test_task_message():
    msg = AP._compose_task_message("竹林对决")
    check("task_tag", msg.startswith("⟦autoplan⟧"))
    check("task_idea", "竹林对决" in msg)


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    test_grid()
    test_tools()
    test_generate_image_tool()
    test_imagen_parsers()
    test_job_flow()
    test_ask_user_flow()
    test_task_message()
    bad = [n for n, ok in PASS if not ok]
    print("---- %d/%d 通过 ----" % (len(PASS) - len(bad), len(PASS)))
    if bad:
        sys.exit(1)
