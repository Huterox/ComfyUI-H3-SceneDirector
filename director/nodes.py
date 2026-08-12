"""SceneDirector 的 ComfyUI 节点类（薄壳，拒绝上帝节点）。

  H3SceneDirectorList          导演工作台（Director 时间线 UI）数据载体：
                               前端（js/minimax_timeline.js）把分镜状态写进
                               timeline_data(v4)，本节点翻译成载荷交给编码头
                               和链条
  H3SceneDirectorConditioning  文本侧：逐段条件编码，发生在明面上
  H3SceneDirectorChain         纯衔接：钉帧 -> 采样 -> 解码 -> 缓存 -> 拼接
  H3SceneDirectorLatentTemplate 统一渲染窗口的空 AV latent（给会校验
                               打包尺寸的采样器，如 MultiRate T8）

采样配置（model 补丁、sampler、sigmas、negative/cfg）全部走接线——
Spectrum 等加速节点即插即用。
"""

import json

from . import payload as P
from . import executor

_TASK_OPTIONS = [
    "t2v — 文生视频(Text to Video)",
    "i2v — 图生视频(Image to Video)",
    "fl2v — 首尾帧生视频(First-Last Frame)",
    "r2v — 参考主体生视频(Reference to Video)",
    "v2v — 视频转视频(Video to Video)",
    "rv2v — 参考素材改视频(Reference Video Edit)",
]


class H3SceneDirectorList:
    """导演工作台。widget 面与 Director 对齐（前端时间线 UI 按名查找），
    run_name 是本包缓存目录命名，两个 BDGROUP 是前端自定义分组头控件。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "task_type": (_TASK_OPTIONS, {"default": _TASK_OPTIONS[0]}),
                "global_prompt": ("STRING", {"default": "", "multiline": True}),
                "frame_rate": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0,
                                         "step": 0.01}),
                "width": ("INT", {"default": 864, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 480, "min": 32, "max": 8192, "step": 32}),
                "ref_max_size": ("INT", {"default": 864, "min": 32, "max": 8192,
                                         "step": 32}),
                "total_frames": ("INT", {"default": 124, "min": 5, "max": 100000}),
                "timeline_data": ("STRING", {"default": "", "multiline": True}),
                # 本包自有：缓存目录名（output/h3_scenedirector/ 下）
                "run_name": ("STRING", {"default": "story"}),
                # 增强器配置持久化（前端隐藏，syncToWidgets 的落点）
                "llm_api_format": ("STRING", {"default": "OpenAI Compatible"}),
                "llm_openai_compat_mode": ("STRING", {"default": "标准"}),
                "llm_url": ("STRING", {"default": "http://127.0.0.1:11434/v1"}),
                "llm_api_key": ("STRING", {"default": ""}),
                "llm_model": ("STRING", {"default": "qwen3"}),
                "llm_output_language": ("STRING", {"default": "中文"}),
                "llm_character_feature_enhance": ("BOOLEAN", {"default": False}),
                "llm_auto_enhance": ("BOOLEAN", {"default": False}),
                "llm_unload_after": ("BOOLEAN", {"default": False}),
                "llm_custom_template": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("SEGMENTS",)
    RETURN_NAMES = ("segments",)
    FUNCTION = "make_list"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("导演工作台：分镜时间线（Director UI）→ 载荷，"
                   "输出给编码头和链条。")

    def make_list(self, task_type, global_prompt, frame_rate, width, height,
                  ref_max_size, total_frames, timeline_data, run_name, **_llm):
        gp, assets, segs, options = P.parse_director(
            timeline_data, task_type, global_prompt, P.sanitize_run(run_name))
        if not segs:
            # UI 还没写时间线时给一段空白 t2v，避免空载荷报错
            segs = [{"duration": max(1.0, round(total_frames / max(1.0, frame_rate), 2)),
                     "prompt": "", "nonce": "", "assets": [], "enabled": True,
                     "first_frame": None, "last_frame": None, "source": None,
                     "audio_mode": "generate", "task": P._task_key_from_label(task_type)}]
        payload = {"run": P.sanitize_run(run_name), "run_nonce": 0,
                   "global_prompt": gp, "globals": [], "assets": assets,
                   "segments": segs}
        if options.get("continuity") is not None:
            payload["continuity"] = options["continuity"]
        if options.get("context_length") is not None:
            payload["context_length"] = options["context_length"]
        if options.get("audio_mode") is not None:
            payload["audio_mode"] = options["audio_mode"]
        if options.get("color_lock") is not None:
            payload["color_lock"] = options["color_lock"]
        if options.get("luma_lock") is not None:
            payload["luma_lock"] = options["luma_lock"]
        return (json.dumps(payload, ensure_ascii=False),)


class H3SceneDirectorConditioning:
    """逐段文本/参考素材条件，在衔接引擎之外构建，文本编码器侧保持可hack。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "segments": ("SEGMENTS",),
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
            },
            "optional": {
                "audio_vae": ("VAE",),
                "first_frame": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STORY_COND",)
    RETURN_NAMES = ("story_cond",)
    FUNCTION = "encode"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("在衔接引擎之外，用接进来的 CLIP/VAE 编码每一段的条件"
                   "（场景表 + 资产参考 + 段提示词 + 首尾帧/源片段）。")

    def encode(self, clip, vae, segments, width, height,
               audio_vae=None, first_frame=None):
        return (executor.encode_story(clip, vae, audio_vae or vae, segments,
                                      width, height, first_frame=first_frame),)


class H3SceneDirectorChain:
    """特征上下文窗口衔接 + 增量重渲驱动。刻意只是衔接：

      * KSamplerSelect  -> sampler  (SAMPLER)
      * BasicScheduler  -> sigmas   (SIGMAS)
      * MODEL 补丁（Spectrum 等）接在 model 之前
      * 可选 negative (CONDITIONING) + cfg widget 做引导采样

    缓存：每段落盘 output/h3_scenedirector/<run>/，只从第一个变动段
    起级联重渲；选择运行关闭的段用缓存填充。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "segments": ("SEGMENTS",),
                "story_cond": ("STORY_COND",),
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 0xffffffffffffffff}),
                "context_length": ("INT", {"default": 22, "min": 1, "max": 39}),
                "audio_context_length": ("INT", {"default": 22, "min": 0, "max": 240}),
                "encode_mode": (["video", "frames"], {"default": "video"}),
                "anchor_mode": (["head", "before"], {"default": "head"}),
                "audio_mode": (["timeline", "ref"], {"default": "timeline"}),
                "crop": (["disabled", "center"], {"default": "disabled"}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1}),
                "cache_tag": ("STRING", {"default": ""}),
                "continuity": ("BOOLEAN", {"default": True}),
                "seam_blend": ("BOOLEAN", {"default": True}),
                "uniform_window": ("BOOLEAN", {"default": False}),
                "color_lock": ("BOOLEAN", {"default": False}),
                "luma_lock": ("BOOLEAN", {"default": False}),
                "vram_cleanup": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "negative": ("CONDITIONING",),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "IMAGE", "STRING")
    RETURN_NAMES = ("images", "audio", "contact_sheet", "info")
    FUNCTION = "chain"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("特征上下文窗口衔接（运动上下文）+ 增量重渲 + 选择运行。"
                   "每段缓存到 output/h3_scenedirector/<run>/，"
                   "只从第一个变动段起重渲。")

    def chain(self, model, vae, audio_vae, segments, story_cond, sampler, sigmas,
              width, height, seed, context_length, audio_context_length,
              encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
              continuity=True, seam_blend=True, uniform_window=False,
              color_lock=False, luma_lock=False, vram_cleanup=False,
              negative=None, unique_id=None):
        return executor.run_chain(
            model, vae, audio_vae, segments, story_cond, sampler, sigmas,
            width, height, seed, context_length, audio_context_length,
            encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
            uniform_window=uniform_window, color_lock=color_lock,
            negative=negative, continuity=continuity, seam_blend=seam_blend,
            vram_cleanup=vram_cleanup, node_id=unique_id,
            luma_lock=luma_lock)


class H3SceneDirectorLatentTemplate:
    """与链条逐段渲染窗口一致的空 AV latent（MultiRate T8 类采样器用）。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "duration": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 60.0, "step": 0.1}),
                "context_length": ("INT", {"default": 39, "min": 1, "max": 39}),
            },
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("av_latent",)
    FUNCTION = "make"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("生成与链条统一渲染窗口一致的空 AV latent，"
                   "供校验打包尺寸的采样器（MultiRate T8）使用。")

    def make(self, width, height, duration, context_length):
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent
        from ..core.motion_context import VIDEO_RUN_GRID
        want = max(5, round(float(duration) * P.FPS))
        span = next((g for g in VIDEO_RUN_GRID if g <= int(context_length)), 1)
        latent, frame_count = _empty_av_latent(width, height,
                                               P.align_frame_count(want + span))
        return (latent,)


NODE_CLASS_MAPPINGS = {
    "H3SceneDirectorList": H3SceneDirectorList,
    "H3SceneDirectorConditioning": H3SceneDirectorConditioning,
    "H3SceneDirectorChain": H3SceneDirectorChain,
    "H3SceneDirectorLatentTemplate": H3SceneDirectorLatentTemplate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3SceneDirectorList": "H3 Scene Director List (工作台)",
    "H3SceneDirectorConditioning": "H3 Scene Director Conditioning",
    "H3SceneDirectorChain": "H3 Scene Director Chain",
    "H3SceneDirectorLatentTemplate": "H3 Scene Director Latent Template",
}
