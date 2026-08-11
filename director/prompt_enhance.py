"""LLM 提示词增强：Ollama / OpenAI 兼容端点，按任务类型的模板。

纯 urllib 实现，零新依赖。模板自己写（参照官方提示词指南的结构：
三字段 + 逐秒节拍 + 镜头运动三要素），不抄任何第三方模板文本。
"""

import json
import logging
import urllib.error
import urllib.request

_LOG = logging.getLogger("h3_scenedirector.enhance")

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1"
DEFAULT_MODEL = "qwen3"

FORMAT_OPENAI_COMPAT = "OpenAI Compatible"
FORMAT_ANTHROPIC = "Anthropic"
DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"

# 任务模板：system 指令。要求模型输出 H3 三字段结构，正文英文、
# 台词保留原语言、节拍覆盖整段时长。
_TEMPLATES = {
    "t2v": (
        "You are a prompt writer for the MiniMax H3 video model. Rewrite the "
        "user's idea into the H3 prompt format with EXACTLY these three fields "
        "in this order: integrated_multimodal_description / overall_soundscape "
        "/ non_diegetic_music. Body text in English; keep any dialogue verbatim "
        "in its original language inside <d>[Language] ...</d>. Cover the full "
        "{duration}s with per-second beats (0-1s: ..., 1-2s: ...), camera moves "
        "written with amplitude and speed. No plot summaries, no markdown, "
        "output the prompt text only."),
    "fl2v": (
        "You are a prompt writer for the MiniMax H3 video model in "
        "first+last-frame mode. Describe the CONTINUOUS motion path between the "
        "pinned first frame and the pinned last frame: opening state, observable "
        "intermediate changes, convergence to the last frame. Same three-field "
        "format and language rules as t2v. Output the prompt text only."),
    "r2v": (
        "You are a prompt writer for the MiniMax H3 video model in "
        "reference-subject mode. Keep every <Picture N>/<Video K>/<Audio J> "
        "label in the user's text intact and used at the exact point where the "
        "referenced subject appears. Same three-field format and language rules "
        "as t2v. Output the prompt text only."),
    "v2v": (
        "You are a prompt writer for the MiniMax H3 video model in "
        "video-editing mode. The source clip is bound as <Video 1>. Describe "
        "the edit: what stays from the source and what changes, beat by beat "
        "over {duration}s. Same three-field format and language rules as t2v. "
        "Output the prompt text only."),
}


def _template(task, duration):
    return _TEMPLATES.get(task or "t2v", _TEMPLATES["t2v"]).format(duration=duration)


def enhance(prompt, task="t2v", duration=5.0, api_url=DEFAULT_OLLAMA_URL,
            model=DEFAULT_MODEL, api_key="", timeout=120,
            api_format=FORMAT_OPENAI_COMPAT):
    """增强一段提示词。api_format: OpenAI Compatible / Anthropic。"""
    if str(api_format).strip().lower() == "anthropic":
        return _enhance_anthropic(prompt, task, duration, api_url, model,
                                  api_key, timeout)
    return _enhance_openai(prompt, task, duration, api_url, model,
                           api_key, timeout)


def _enhance_anthropic(prompt, task, duration, api_url, model, api_key, timeout):
    """Anthropic /v1/messages 格式。"""
    url = (api_url or DEFAULT_ANTHROPIC_URL).rstrip("/") + "/v1/messages"
    body = {
        "model": model or DEFAULT_ANTHROPIC_MODEL,
        "max_tokens": 4096,
        "system": _template(task, duration),
        "messages": [{"role": "user", "content": str(prompt or "")}],
    }
    headers = {"Content-Type": "application/json",
               "anthropic-version": "2023-06-01"}
    if api_key:
        headers["x-api-key"] = api_key
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError("Anthropic 端点不可达（%s）：%s" % (url, e))
    for block in data.get("content") or []:
        if block.get("type") == "text" and str(block.get("text", "")).strip():
            text = block["text"].strip()
            _LOG.info("提示词增强(Anthropic): task=%s, %d 字 -> %d 字",
                      task, len(prompt or ""), len(text))
            return text
    raise RuntimeError("Anthropic 返回空内容。")


def _enhance_openai(prompt, task, duration, api_url, model, api_key, timeout):
    """调用 OpenAI 兼容 chat/completions 增强一段提示词。返回增强文本。"""
    url = (api_url or DEFAULT_OLLAMA_URL).rstrip("/") + "/chat/completions"
    body = {
        "model": model or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": _template(task, duration)},
            {"role": "user", "content": str(prompt or "")},
        ],
        "temperature": 0.7,
        "stream": False,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError("提示词增强端点不可达（%s）：%s" % (url, e))
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("提示词增强端点返回空结果。")
    text = (choices[0].get("message") or {}).get("content", "").strip()
    if not text:
        raise RuntimeError("提示词增强端点返回空内容。")
    _LOG.info("提示词增强: task=%s, %d 字 -> %d 字", task, len(prompt or ""), len(text))
    return text
