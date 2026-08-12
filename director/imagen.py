"""生图后端：Seedream（主力）/ nanobanana（备用）。

配置统一读工作室层服务配置（studio.load_config() 的 image 节）：
  {provider: seedream|nanobanana|disabled, base_url, api_key, model, size}

- seedream：OpenAI images 协议 POST {base}/images/generations，
  响应 data[0].b64_json（火山方舟/兼容网关通用）。
- nanobanana：OpenAI chat 协议 POST {base}/chat/completions，
  图片藏在 message 里，兼容三种常见回包：
  content 为 data-url 字符串 / content 列表带 image_url / message.images[]。

生成的图落 ComfyUI 输入目录的 scenedirector/ 子目录，卡片 imageFile
记相对路径（与上传图片同一寻址口径）。

模块可被离线单测导入：HTTP 走 _post_json（单测 monkeypatch 它）。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request

_LOG = logging.getLogger("h3_scenedirector.imagen")

DEFAULT_MODELS = {
    "seedream": "doubao-seedream-4-0-250828",
    "nanobanana": "gemini-2.5-flash-image",
}


def _post_json(url, headers, payload, timeout=120):
    """POST JSON，返回解析后的 dict。失败抛 RuntimeError（带可读信息）。"""
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise RuntimeError("HTTP %d：%s" % (e.code, body or e.reason)) from e
    except Exception as e:
        raise RuntimeError(str(e)) from e


def _extract_b64_seedream(data):
    for item in (data or {}).get("data") or []:
        b64 = item.get("b64_json")
        if b64:
            return b64
        url = item.get("url")  # 有的网关只回 URL，顺手下载
        if url:
            with urllib.request.urlopen(url, timeout=60) as resp:
                return base64.b64encode(resp.read()).decode("ascii")
    raise RuntimeError("响应里没有图片数据")


_DATA_URL = re.compile(r"data:image/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)")


def _extract_b64_nanobanana(data):
    choices = (data or {}).get("choices") or []
    if not choices:
        raise RuntimeError("响应里没有 choices")
    msg = choices[0].get("message") or {}
    # 形态一：images 字段（部分网关）
    for img in msg.get("images") or []:
        b64 = img.get("b64_json") or img.get("b64")
        if b64:
            return b64
        url = img.get("image_url") or img.get("url")
        if isinstance(url, dict):
            url = url.get("url")
        if isinstance(url, str) and url.startswith("data:"):
            m = _DATA_URL.search(url)
            if m:
                return m.group(1)
    content = msg.get("content")
    # 形态二：content 是列表（multimodal 块）
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            iu = block.get("image_url")
            if isinstance(iu, dict):
                iu = iu.get("url")
            if isinstance(iu, str) and iu.startswith("data:"):
                m = _DATA_URL.search(iu)
                if m:
                    return m.group(1)
            if block.get("b64_json"):
                return block["b64_json"]
    # 形态三：content 是 data-url 字符串
    if isinstance(content, str):
        m = _DATA_URL.search(content)
        if m:
            return m.group(1)
    raise RuntimeError("响应里解析不出图片（网关回包格式不认识）")


def generate_image_b64(cfg, prompt, size=None):
    """按服务配置生图，返回 base64。未启用/失败抛 RuntimeError。"""
    img = ((cfg or {}).get("image") or {})
    provider = img.get("provider", "disabled")
    if provider == "disabled":
        raise RuntimeError("生图服务未启用：在「服务配置」里选 Seedream 或 nanobanana")
    if not img.get("base_url") or not img.get("api_key"):
        raise RuntimeError("生图服务未配置 base_url / api_key")
    base = img["base_url"].rstrip("/")
    model = img.get("model") or DEFAULT_MODELS.get(provider, "")
    size = size or img.get("size") or "2048x2048"
    headers = {"Authorization": "Bearer " + img["api_key"]}
    if provider == "seedream":
        data = _post_json(base + "/images/generations", headers, {
            "model": model, "prompt": prompt, "size": size,
            "response_format": "b64_json", "watermark": False,
        })
        return _extract_b64_seedream(data)
    if provider == "nanobanana":
        data = _post_json(base + "/chat/completions", headers, {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        })
        return _extract_b64_nanobanana(data)
    raise RuntimeError("未知的生图服务商: " + str(provider))


_SAFE = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")


def save_image_b64(input_dir, b64, name_hint="asset"):
    """落盘到输入目录的 scenedirector/ 子目录，返回相对路径（imageFile 口径）。"""
    sub = os.path.join(input_dir, "scenedirector")
    os.makedirs(sub, exist_ok=True)
    stem = _SAFE.sub("_", str(name_hint or "asset")).strip("._")[:40] or "asset"
    fname = "%s-%s.png" % (time.strftime("%Y%m%d-%H%M%S"), stem)
    with open(os.path.join(sub, fname), "wb") as f:
        f.write(base64.b64decode(b64))
    return "scenedirector/" + fname


__all__ = ["generate_image_b64", "save_image_b64", "DEFAULT_MODELS"]
