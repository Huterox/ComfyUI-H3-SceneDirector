"""StoryDirector 的 ComfyUI 节点类（薄壳）。

设计原则：不做上帝节点。
  H3StoryDirectorList          工作台数据载体（载荷 -> SEGMENTS）
  H3StoryDirectorConditioning  文本侧：逐段条件编码，发生在明面上
  H3StoryDirectorChain         纯循环：钉帧 -> 采样 -> 解码 -> 缓存 -> 拼接
  H3StoryDirectorLatentTemplate 统一渲染窗口的空 AV latent（给会校验
                               打包尺寸的采样器，如 MultiRate T8）

采样配置（model 补丁、sampler、sigmas、negative/cfg）全部走接线。
"""

import json

from . import payload as P
from . import engine


def _default_payload():
    """默认的 3 段"无畏机甲 vs 兽人"场景，按承接句协议书写：
    场景表里有固定的走位/机位行，每段开头声明继承的状态、结尾交代
    移交的状态——跨段的运动逻辑活在文本里，因为钉帧只带约 1 秒的
    运动记忆。"""
    return {
        "run": "story",
        "run_nonce": 0,
        "global_prompt": (
            "主角设定（全片一致）：一台古代无畏机甲——石棺式重型机身、灰黑色战痕涂装、"
            "右臂重型爆弹炮、左臂巨大动力拳、腰间链锯剑；敌人为绿色皮肤的兽人潮。"),
        "globals": [
            {"category": "视觉风格", "content": "3D CG 电影感，冷峻暗黑基调，硝烟与火光的体积光"},
            {"category": "世界观", "content": "灰烬与硝烟弥漫的废墟战场，一条笔直的废墟大道，远处残垣与火光"},
            {"category": "走位与机位", "content": "机甲全程沿大道向画面右前方稳步推进，镜头固定在机甲左侧前方低角度跟拍，机位方向全片不变；兽人从画面右前方（大道深处）出现，向右方深处溃逃"},
            {"category": "音乐基调", "content": "沉重战鼓与低音铜管，随战况升温"},
        ],
        "assets": [],
        "segments": [
            {"duration": 5.0, "nonce": "dread1", "assets": [], "prompt": (
                "integrated_multimodal_description: [Shot 1] 开场：硝烟弥漫的废墟大道，无畏机甲从画面左方入画，"
                "沿大道向画面右前方稳步推进，右臂爆弹炮向右前方深处的兽人潮持续点射，炮口火舌喷吐。 "
                "[Shot 2] At 00:02.500 机甲脚步不停继续向右前方推进，弹壳抛落，"
                "兽人从瓦砾后嚎叫着涌出迎面扑来。收尾状态：机甲面朝右前方行进中，机位不变。\n"
                "overall_soundscape: 爆弹轰鸣、兽人嘶吼、沉重脚步声、远处爆炸。\n"
                "non_diegetic_music: 战鼓渐强，紧张气氛升温。")},
            {"duration": 5.0, "nonce": "dread2", "assets": [], "prompt": (
                "integrated_multimodal_description: [Shot 1] 承接上段：机甲面朝右前方推进中，机位不变。"
                "兽人扑到近前，机甲左臂动力拳横扫将它们砸飞，脚步不停。 [Shot 2] At 00:02.500 "
                "机甲边行进边挥拳，又一拳击碎一头跃起的兽人，火花与血雾迸溅，继续向右前方推进。"
                "收尾状态：机甲仍在行进，兽人攻势减弱。\n"
                "overall_soundscape: 金属撞击、重拳闷响、兽人哀嚎、液压轰鸣。\n"
                "non_diegetic_music: 凶猛打击乐，持续激战节奏。")},
            {"duration": 5.0, "nonce": "dread3", "assets": [], "prompt": (
                "integrated_multimodal_description: [Shot 1] 承接上段：机甲向右前方推进，机位不变。"
                "兽人潮在重火力与重拳下溃散，转身向画面右方深处奔逃，机甲踏着燃烧的残骸继续前进，"
                "爆弹炮向逃敌点射。 [Shot 2] At 00:02.500 大道前方渐渐清空，硝烟与火光映红天际，"
                "机甲保持节奏向右前方推进。收尾状态：机甲行进中，大道渐空。\n"
                "overall_soundscape: 巨大爆炸轰鸣、噼啪火焰、溃逃兽人呼喊、回荡战号。\n"
                "non_diegetic_music: 凯旋战鼓与铜管号角，强拍收尾。")},
        ],
    }


class H3StoryDirectorList:
    """导演工作台的数据载体。js/workbench 前端把载荷渲染成分镜时间线
    （场景设定表、资产卡、逐段缩略图/状态/重摇/资产图钉）；本节点把
    run 名钉进去，把载荷交给编码头和链条。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # 工作台载荷：{"run","run_nonce","global_prompt","globals",
                # "assets","segments"}；也兼容裸的 [{duration,prompt}] 列表
                "segments": ("STRING", {
                    "multiline": True,
                    "default": json.dumps(_default_payload(), ensure_ascii=False),
                    "tooltip": "导演工作台载荷（由 js/workbench 前端扩展渲染）",
                }),
                "run_name": ("STRING", {
                    "default": "story",
                    "tooltip": "本次 run 的缓存目录名（output/h3_storydirector/ 下）。"
                               "一次 run = 一个场景；换名即开新场景。",
                }),
            }
        }

    RETURN_TYPES = ("SEGMENTS",)
    RETURN_NAMES = ("segments",)
    FUNCTION = "make_list"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("导演工作台：场景设定表 + 资产卡 + 分镜时间线，"
                   "输出 run 载荷给编码头和链条。")

    def make_list(self, segments, run_name="story"):
        run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments)
        run = P.sanitize_run(run_name) if str(run_name or "").strip() else run
        if not segs:
            raise ValueError("H3StoryDirectorList: 至少加一段带提示词的分镜")
        payload = {"run": run, "run_nonce": run_nonce, "global_prompt": global_prompt,
                   "globals": globals_rows, "assets": assets, "segments": segs}
        return (json.dumps(payload, ensure_ascii=False),)


class H3StoryDirectorConditioning:
    """逐段文本/参考图条件，在循环之外构建，文本编码器侧保持可hack。

    每段拼出完整提示词（场景设定表 + 资产清单 + 段提示词 + 段级资产
    图钉），用接进来的 CLIP 编码——任何 CLIP 补丁或自定义编码都能插在
    它前面；资产参考图用接进来的视频 VAE 按官方 r2v 配比编码。
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                # 接喂链条的同一个 StoryList
                "segments": ("SEGMENTS",),
                # 与链条的画布一致：参考图按它配比，链条会交叉校验
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
            },
            "optional": {
                # 钉为段 1 的第 0 帧关键帧（i2v 开场）
                "first_frame": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("STORY_COND",)
    RETURN_NAMES = ("story_cond",)
    FUNCTION = "encode"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("在链条循环之外，用接进来的 CLIP/VAE 编码每一段的条件"
                   "（场景表 + 资产参考 + 段提示词）。")

    def encode(self, clip, vae, segments, width, height, first_frame=None):
        return (engine.encode_story(clip, vae, segments, width, height,
                                    first_frame=first_frame),)


class H3StoryDirectorChain:
    """增量循环 + 运动上下文链接驱动。刻意只是循环：

      * KSamplerSelect  -> sampler  (SAMPLER)
      * BasicScheduler  -> sigmas   (SIGMAS)
      * MODEL 补丁（Spectrum 等）接在 model 之前
      * 可选 negative (CONDITIONING) + cfg widget 做引导采样
        （不接 negative 时保持官方 H3 的仅正条件行为）

    缓存：每段落盘 output/h3_storydirector/<run>/，只从第一个变动段
    起级联重渲。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                # 接 StoryList……
                "segments": ("SEGMENTS",),
                # ……和同源的编码头
                "story_cond": ("STORY_COND",),
                # 标准采样节点接这里
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                # 宽高是 widget（对齐 MiniMaxH3ImageToVideo 的序列化），
                # 从 ResolutionSelector 接线
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "seed": ("INT", {"default": -1, "min": -1, "max": 0xffffffffffffffff}),
                "context_length": ("INT", {"default": 22, "min": 1, "max": 39}),
                "audio_context_length": ("INT", {"default": 22, "min": 0, "max": 240}),
                "encode_mode": (["video", "frames"], {"default": "video"}),
                "anchor_mode": (["head", "before"], {"default": "head"}),
                "audio_mode": (["timeline", "ref"], {"default": "timeline"}),
                "crop": (["disabled", "center"], {"default": "disabled"}),
                "cfg": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1,
                    "tooltip": "CFG 强度，仅当接了 negative 条件时生效。"
                               "不接 negative 就是仅正条件（官方 H3 行为）。"}),
                "cache_tag": ("STRING", {
                    "default": "",
                    "tooltip": "手动缓存作废标签。磁盘缓存无法指纹化你接进来的 "
                               "UNET/LoRA，换模型或加速器后改一下这个标签"
                               "（比如 'turbo4'）即可强制全链重渲。"}),
                "uniform_window": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "每段（含段 1）都按统一窗口渲染（时长+钉帧跨度）。"
                               "校验打包 latent 尺寸的采样器（MultiRate T8）需要它；"
                               "开启后所有段时长必须相等。"}),
            },
            "optional": {
                "negative": ("CONDITIONING",),
            },
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "IMAGE", "STRING")
    RETURN_NAMES = ("images", "audio", "contact_sheet", "info")
    FUNCTION = "chain"
    CATEGORY = "conditioning/minimax"
    DESCRIPTION = ("增量逐段循环 + H3 运动上下文链接。每段缓存到 "
                   "output/h3_storydirector/<run>/，只从第一个变动段起重渲。")

    def chain(self, model, vae, audio_vae, segments, story_cond, sampler, sigmas,
              width, height, seed, context_length, audio_context_length,
              encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
              uniform_window=False, negative=None):
        return engine.run_chain(
            model, vae, audio_vae, segments, story_cond, sampler, sigmas,
            width, height, seed, context_length, audio_context_length,
            encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
            uniform_window=uniform_window, negative=negative)


class H3StoryDirectorLatentTemplate:
    """与链条逐段渲染窗口一致的空 AV latent。

    会按模板校验打包 latent 尺寸的采样器（MultiRate T8 在尺寸不符时
    直接报错）需要接一个。链条开 uniform_window、且所有段时长一致时，
    每次采样调用都与本模板精确匹配（宽高/时长/context_length 要与
    链条镜像）。"""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "width": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "duration": ("FLOAT", {"default": 5.0, "min": 0.2, "max": 60.0, "step": 0.1,
                                       "tooltip": "段时长（秒），必须与工作台载荷里每段一致。"}),
                "context_length": ("INT", {"default": 39, "min": 1, "max": 39,
                                           "tooltip": "镜像链条的 context_length：渲染窗口"
                                                      "按钉帧跨度加大。"}),
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
    "H3StoryDirectorList": H3StoryDirectorList,
    "H3StoryDirectorConditioning": H3StoryDirectorConditioning,
    "H3StoryDirectorChain": H3StoryDirectorChain,
    "H3StoryDirectorLatentTemplate": H3StoryDirectorLatentTemplate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3StoryDirectorList": "H3 Story Director List (工作台)",
    "H3StoryDirectorConditioning": "H3 Story Director Conditioning",
    "H3StoryDirectorChain": "H3 Story Director Chain",
    "H3StoryDirectorLatentTemplate": "H3 Story Director Latent Template",
}
