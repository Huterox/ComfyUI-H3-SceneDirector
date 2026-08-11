"""LLM 提示词增强：OpenAI 兼容 / Anthropic 端点，按任务类型的模板。

纯 urllib 实现，零新依赖。模板自己写（参照官方提示词指南的结构：
三字段 + 逐秒节拍 + 镜头运动三要素）。支持：
  * 视觉附件：参考图随消息发给视觉模型（OpenAI image_url / Anthropic image block）
  * 输出语言、角色特征细节、自定义模板覆盖
  * 用后卸载（Ollama keep_alive=0）
"""

import base64
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

MAX_VISION_IMAGES = 4      # 视觉附件上限（与 Director 对齐）

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

_LANG_DIRECTIVES = {
    "中文": "Write the whole rewrite in Chinese (dialogue stays in its original language).",
    "English": "Write the whole rewrite in English (dialogue stays in its original language).",
}

_CHARACTER_DETAIL = (
    "Additionally, describe the main subject's visual identity in precise detail "
    "(face, hairstyle, eyes, outfit, colors, key accessories) so the same "
    "subject can be reproduced consistently across segments.")


def _template(task, duration, output_language=None, character_detail=False,
              custom_template=None):
    """组装 system 模板：自定义 > 任务模板 + 语言/角色细节指令。"""
    if custom_template and str(custom_template).strip():
        base = str(custom_template).strip()
    else:
        base = _TEMPLATES.get(task or "t2v", _TEMPLATES["t2v"]).format(duration=duration)
    lang = _LANG_DIRECTIVES.get(str(output_language or "").strip())
    if lang:
        base += " " + lang
    if character_detail:
        base += " " + _CHARACTER_DETAIL
    return base


def _norm_images(images):
    """统一视觉附件为 (media_type, base64) 列表，限 MAX_VISION_IMAGES 张。"""
    out = []
    for item in (images or [])[:MAX_VISION_IMAGES]:
        if not isinstance(item, str) or not item.strip():
            continue
        s = item.strip()
        if s.startswith("data:"):
            head, _, data = s.partition(",")
            mt = head[5:].split(";")[0] or "image/jpeg"
            out.append((mt, data))
        else:
            out.append(("image/jpeg", s))
    return out


def _post(url, body, headers, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise RuntimeError("LLM 端点不可达（%s）：%s" % (url, e))


def _openai_user_content(prompt, images):
    if not images:
        return str(prompt or "")
    content = [{"type": "text", "text": str(prompt or "")}]
    for mt, data in images:
        content.append({"type": "image_url",
                        "image_url": {"url": "data:%s;base64,%s" % (mt, data)}})
    return content


def _anthropic_user_content(prompt, images):
    if not images:
        return str(prompt or "")
    content = [{"type": "image",
                "source": {"type": "base64", "media_type": mt, "data": data}}
               for mt, data in images]
    content.append({"type": "text", "text": str(prompt or "")})
    return content


def _unload_ollama(api_url, model, timeout=10):
    """Ollama 用后卸载（keep_alive=0）。尽力而为，失败静默。"""
    try:
        base = (api_url or DEFAULT_OLLAMA_URL).rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        _post(base + "/api/generate",
              {"model": model, "keep_alive": 0},
              {"Content-Type": "application/json"}, timeout)
    except Exception:
        pass


def enhance(prompt, task="t2v", duration=5.0, api_url=DEFAULT_OLLAMA_URL,
            model=DEFAULT_MODEL, api_key="", timeout=120,
            api_format=FORMAT_OPENAI_COMPAT, images=None,
            output_language=None, character_detail=False,
            custom_template=None, unload_after=False):
    """增强一段提示词，返回文本。api_format: OpenAI Compatible / Anthropic。"""
    system = _template(task, duration, output_language, character_detail,
                       custom_template)
    imgs = _norm_images(images)
    fmt = str(api_format or "").strip().lower()

    if fmt == "anthropic":
        url = (api_url or DEFAULT_ANTHROPIC_URL).rstrip("/") + "/v1/messages"
        headers = {"Content-Type": "application/json",
                   "anthropic-version": "2023-06-01"}
        if api_key:
            headers["x-api-key"] = api_key
        data = _post(url, {
            "model": model or DEFAULT_ANTHROPIC_MODEL,
            "max_tokens": 4096,
            "system": system,
            "messages": [{"role": "user",
                          "content": _anthropic_user_content(prompt, imgs)}],
        }, headers, timeout)
        text = ""
        for block in data.get("content") or []:
            if block.get("type") == "text" and str(block.get("text", "")).strip():
                text = block["text"].strip()
                break
    else:
        url = (api_url or DEFAULT_OLLAMA_URL).rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = "Bearer " + api_key
        data = _post(url, {
            "model": model or DEFAULT_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": _openai_user_content(prompt, imgs)},
            ],
            "temperature": 0.7,
            "stream": False,
        }, headers, timeout)
        choices = data.get("choices") or []
        text = ""
        if choices:
            text = (choices[0].get("message") or {}).get("content", "").strip()

    if unload_after:
        _unload_ollama(api_url, model or DEFAULT_MODEL)
    if not text:
        raise RuntimeError("LLM 返回空内容。")
    _LOG.info("提示词增强: task=%s, fmt=%s, 图 %d, %d 字 -> %d 字",
              task, api_format, len(imgs), len(prompt or ""), len(text))
    return text
