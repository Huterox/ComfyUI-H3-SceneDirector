"""载荷共存补丁（SceneDirector 自研实现）。

要解决的问题：ComfyUI 的 `MiniMaxH3.extra_conds` 用两个独立的 if 分支
填充 DiT 载荷——关键帧分支写入 `cond_video_latents` 后，参考块分支会把
它**覆盖**掉：

    if keyframes is not None:
        payload["cond_video_latents"] = [kf["latent"] for kf in keyframes]
    if refs is not None:
        payload["cond_video_latents"] = [r["latent"] for r in refs ...]
        payload["cond_audio_latents"] = [...]

于是"钉帧 + 音频参考"同时存在时，关键帧的视频内容被抹掉（纯音频参考块
没有 "latent" 键，列表变空，布局建好的 cond 行没有内容可填）。

布局本身是兼容两者的（cond 行在前、参考行在后、目标行最后，与前向
写入永不去噪槽位的顺序一致），碍事的只有这一处赋值。补丁方式：包一层
extra_conds，在原版结果上把两份内容**拼接**回去（关键帧在前，与行序
一致）。只用单一机制的图不受影响。
"""

import logging

import comfy.model_base as model_base

_LOG = logging.getLogger("h3_scenedirector")

_orig_extra_conds = None
_applied = False


def _patched_extra_conds(self, **kwargs):
    out = _orig_extra_conds(self, **kwargs)

    keyframes = kwargs.get("minimax_keyframes", None)
    refs = kwargs.get("minimax_refs", None)
    if not keyframes or not refs:
        return out  # 只有一种机制在场，官方行为本来就是对的

    cond = out.get("minimax_payload", None)
    payload = getattr(cond, "cond", None) if cond is not None else None
    if not isinstance(payload, dict):
        _LOG.warning("h3_scenedirector: 够不到 H3 载荷，关键帧 latent 可能"
                     "已被参考块覆盖")
        return out

    kf_video = [kf["latent"] for kf in keyframes if "latent" in kf]
    ref_video = [r["latent"] for r in refs if "latent" in r]
    payload["cond_video_latents"] = kf_video + ref_video
    payload["cond_audio_latents"] = [r["audio_latent"] for r in refs
                                     if r.get("audio_latent") is not None]
    # 只在确实有值时写 frame_count：本包装对任何"关键帧+参考块"的图都会
    # 触发，不带 minimax_frame_count 的图可能已有合法值，写 None 会弄坏
    # 下游的尾帧锚定分支
    fc = kwargs.get("minimax_frame_count", None)
    if fc is not None:
        payload["frame_count"] = fc
    return out


def apply_patch():
    """应用载荷补丁。若同生态补丁已在位（另一份拷贝先应用），认领养复用
    ——包装器每次都从入参重算合并结果，叠加虽幂等但没有意义。"""
    global _orig_extra_conds, _applied
    if _applied:
        return True
    cls = getattr(model_base, "MiniMaxH3", None)
    if cls is None or not hasattr(cls, "extra_conds"):
        _LOG.warning("h3_scenedirector: 找不到 MiniMaxH3.extra_conds，"
                     "关键帧与参考块无法共存")
        return False
    if getattr(cls.extra_conds, "__name__", "") == "_patched_extra_conds":
        _applied = True
        _LOG.info("h3_scenedirector: 载荷补丁已在位（另一份拷贝应用），认领养复用")
        return True
    _orig_extra_conds = cls.extra_conds
    cls.extra_conds = _patched_extra_conds
    _applied = True
    _LOG.info("h3_scenedirector: 关键帧/参考块共存已启用")
    return True


def is_applied():
    return _applied
