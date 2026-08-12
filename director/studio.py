"""SceneDirector 工作室层：服务配置与项目库的存储和路由。

存储位置（ComfyUI 用户目录下，随 comfyui 走，不进仓库不进工作流）：

  user/SceneDirector/config.json        服务配置（LLM + 生图服务，含 key）
  user/SceneDirector/projects/<名>.json 项目快照（工作台全量状态，前端自定义结构）

config.json 永远不进项目文件、不进工作流 JSON——example 工作流没有
key 泄露风险。项目文件只存工作台状态（模式/资产库/分段/输出开关），
key 的引用方式是"用服务端那份"。

路由（POST 均为 JSON body）：

  GET  /h3_scenedirector/config          读配置（key 原样返回：本机工具）
  POST /h3_scenedirector/config          存配置（部分字段合并）
  POST /h3_scenedirector/config/test     连通性测试 {"kind": "llm"|"image"}
  GET  /h3_scenedirector/projects        项目列表 [{name, updated}]
  POST /h3_scenedirector/project/save    {name, state} 保存/另存（覆盖同名）
  POST /h3_scenedirector/project/load    {name} -> {name, state}
  POST /h3_scenedirector/project/delete  {name}
"""

import json
import logging
import os
import re
import time
import urllib.request
import urllib.error

from aiohttp import web
from server import PromptServer

import folder_paths

_LOG = logging.getLogger("h3_scenedirector.studio")

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._\-()一-鿿]+")

DEFAULT_CONFIG = {
    "llm": {
        "api_format": "openai",       # openai | anthropic
        "base_url": "",
        "api_key": "",
        "model": "",
        "context_window": 200000,
        "max_tokens": 8192,
    },
    "image": {
        "provider": "disabled",       # seedream | nanobanana | disabled
        "base_url": "",
        "api_key": "",
        "model": "",                  # 缺省按厂商内置（seedream-4-x / gemini-2.5-flash-image）
        "size": "2048x2048",
    },
}


def _root():
    base = os.path.join(folder_paths.get_user_directory(), "SceneDirector")
    os.makedirs(base, exist_ok=True)
    return base


def _projects_dir():
    d = os.path.join(_root(), "projects")
    os.makedirs(d, exist_ok=True)
    return d


def _safe_name(name):
    """项目名即文件名（也是 run 缓存目录名）：剔路径字符，限长。"""
    name = str(name or "").strip().replace("/", "_").replace("\\", "_").lstrip(".")
    name = _SAFE_NAME.sub("_", name).strip("._")
    return name[:64]


# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

def load_config():
    """读服务配置；缺文件/缺字段用 DEFAULT_CONFIG 补齐。"""
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    path = os.path.join(_root(), "config.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            saved = json.load(f)
    except (OSError, json.JSONDecodeError):
        saved = {}
    for sect in ("llm", "image"):
        if isinstance(saved.get(sect), dict):
            cfg[sect].update({k: v for k, v in saved[sect].items()
                              if k in cfg[sect]})
    return cfg


def save_config(patch):
    """合并写入（只认已知字段），返回落盘后的完整配置。"""
    cfg = load_config()
    for sect in ("llm", "image"):
        incoming = (patch or {}).get(sect)
        if isinstance(incoming, dict):
            for k, v in incoming.items():
                if k in cfg[sect]:
                    cfg[sect][k] = v
    try:
        cfg["llm"]["context_window"] = max(4096, int(cfg["llm"]["context_window"]))
    except (TypeError, ValueError):
        cfg["llm"]["context_window"] = DEFAULT_CONFIG["llm"]["context_window"]
    path = os.path.join(_root(), "config.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return cfg


# ---------------------------------------------------------------------------
# 项目读写
# ---------------------------------------------------------------------------

def list_projects():
    out = []
    for fn in sorted(os.listdir(_projects_dir())):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(_projects_dir(), fn)
        try:
            with open(path, "r", encoding="utf-8") as f:
                head = json.load(f)
            out.append({"name": head.get("name") or fn[:-5],
                        "updated": head.get("updated", 0)})
        except (OSError, json.JSONDecodeError):
            continue
    out.sort(key=lambda p: p.get("updated", 0), reverse=True)
    return out


def save_project(name, state):
    name = _safe_name(name)
    if not name:
        raise ValueError("项目名为空")
    doc = {"name": name,
           "created": int(time.time()),
           "updated": int(time.time()),
           "state": state if isinstance(state, dict) else {}}
    path = os.path.join(_projects_dir(), name + ".json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                doc["created"] = int(json.load(f).get("created", doc["created"]))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return doc


def load_project(name):
    name = _safe_name(name)
    path = os.path.join(_projects_dir(), name + ".json")
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, dict) or "state" not in doc:
        raise ValueError("项目文件损坏")
    return doc


def delete_project(name):
    name = _safe_name(name)
    path = os.path.join(_projects_dir(), name + ".json")
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


# ---------------------------------------------------------------------------
# 连通性测试
# ---------------------------------------------------------------------------

def _http_json(url, headers, timeout=20):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8", "replace"))


def test_connection(cfg, kind):
    """轻量连通测试：只列模型（免费），不真生成烧钱。"""
    if kind == "llm":
        llm = cfg["llm"]
        if not llm["base_url"] or not llm["api_key"]:
            return False, "LLM 未配置 base_url / api_key"
        base = llm["base_url"].rstrip("/")
        try:
            if llm["api_format"] == "anthropic":
                status, _ = _http_json(
                    base + "/v1/models",
                    {"x-api-key": llm["api_key"],
                     "anthropic-version": "2023-06-01"})
            else:
                status, _ = _http_json(
                    base + "/models",
                    {"Authorization": "Bearer " + llm["api_key"]})
            return (status < 400), ("HTTP %d" % status)
        except urllib.error.HTTPError as e:
            return False, "HTTP %d：%s" % (e.code, e.reason)
        except Exception as e:
            return False, str(e)
    if kind == "image":
        img = cfg["image"]
        if img["provider"] == "disabled":
            return False, "生图服务未启用"
        if not img["base_url"] or not img["api_key"]:
            return False, "生图服务未配置 base_url / api_key"
        base = img["base_url"].rstrip("/")
        try:
            status, _ = _http_json(
                base + "/models",
                {"Authorization": "Bearer " + img["api_key"]})
            return (status < 400), ("HTTP %d" % status)
        except urllib.error.HTTPError as e:
            return False, "HTTP %d：%s" % (e.code, e.reason)
        except Exception as e:
            return False, str(e)
    return False, "未知的测试类型"


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/h3_scenedirector/config")
async def get_config(request):
    return web.json_response(load_config())


@PromptServer.instance.routes.post("/h3_scenedirector/config")
async def post_config(request):
    try:
        patch = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "非法 JSON"}, status=400)
    cfg = save_config(patch if isinstance(patch, dict) else {})
    return web.json_response(cfg)


@PromptServer.instance.routes.post("/h3_scenedirector/config/test")
async def post_config_test(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        body = {}
    kind = str((body or {}).get("kind", "llm"))
    # 允许前端拿"未保存的草稿配置"直接测：body 里带 config 就用它
    cfg = body.get("config") if isinstance(body.get("config"), dict) else None
    cfg = save_config(cfg) if cfg else load_config()
    ok, detail = await asyncio_to_thread(test_connection, cfg, kind)
    return web.json_response({"ok": ok, "detail": detail})


async def asyncio_to_thread(fn, *args):
    """小工具：同步阻塞调用丢线程池，别冻事件循环（enhance 卡死的教训）。"""
    import asyncio
    return await asyncio.to_thread(fn, *args)


@PromptServer.instance.routes.get("/h3_scenedirector/projects")
async def get_projects(request):
    return web.json_response({"projects": list_projects()})


@PromptServer.instance.routes.post("/h3_scenedirector/project/save")
async def post_project_save(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "非法 JSON"}, status=400)
    try:
        doc = save_project((body or {}).get("name"), (body or {}).get("state"))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"name": doc["name"], "updated": doc["updated"]})


@PromptServer.instance.routes.post("/h3_scenedirector/project/load")
async def post_project_load(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "非法 JSON"}, status=400)
    try:
        doc = load_project((body or {}).get("name"))
    except FileNotFoundError:
        return web.json_response({"error": "项目不存在"}, status=404)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    return web.json_response({"name": doc["name"], "state": doc["state"],
                              "updated": doc["updated"]})


@PromptServer.instance.routes.post("/h3_scenedirector/project/delete")
async def post_project_delete(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "非法 JSON"}, status=400)
    ok = delete_project((body or {}).get("name"))
    return web.json_response({"ok": ok})
