"""H3 专项显存规划（节点侧，不动 comfy 核心）。

背景：DynamicVRAM（comfy-aimdo）已经提供逐块异步换入换出（vbar + prefetch
流水线），但它的策略是"能装多少装多少"——权重会把显存堆满，只给激活留
最低推理内存。高分辨率长段时采样激活一顶上来就被动交换，在崩溃边缘抖动。

我们比通用层更懂这次 run：段长、分辨率、钉帧窗口、参考图数量在采样前
全部已知，激活峰值可以提前估算。三个动作：

  1. 采样期间临时抬高 model_management.EXTRA_RESERVED_VRAM（官方
     --reserve-vram 的运行时等价物），把 DiT 权重驻留压到安全额度，
     缺口由 DynamicVRAM 的 prefetch 流水线异步补上——抖动换确定。
  2. 修正 H3 视频 VAE 的 decode 内存估算：VAE 内建 17 帧时间滑窗 +
     空间 tile，实际是流式的，通用估算公式按整段线性高估几十 GB，
     导致每段 decode 前做一次无谓的 20G 权重往返卸载。
  3. 编码头完成后主动卸载 CLIP——文本条件已全部编码完毕，
     采样循环不再需要它。

只做规划，不碰采样语义；全部走 ModelPatcher / model_management 公开接口。
"""

import contextlib
import logging
import math

import torch

import comfy.model_management as mm

from .status import emit_log

_LOG = logging.getLogger("h3_scenedirector.budget")

# 采样激活估算系数（bf16，按 H3 forward 的单层峰值：残差 h + FFN 中间态
# 2×14336 维 ≈ seq×68KB，再含 attention/qkv 与 sage workspace 余量）
_ACT_PER_ROW = 70 * 1024
_FIXED_OVERHEAD = 2.5 * 1024**3    # 模态打包临时张量（fp32）+ 采样器工作区
_SMALL_MODELS = 1.0 * 1024**3      # 音频 VAE 等小件驻留
_SAFETY = 1.25

# H3 VAE decode 的真实峰值：单窗（17 帧 + 重叠）× 空间 tile 的 ViT3D 解码，
# 与段长无关。通用公式按整段 latent 线性估算，294 帧段能虚高几十 GB。
_VAE_DECODE_REAL = 2 * 1024**3

_TEXT_ROWS = 1024                  # 文本段长度上界（qwen 编码后）


def _latent_steps(frames):
    """H3 视频 VAE 的时间降采样网格：max(1, (n-5)//17*5+2)。"""
    return max(1, (int(frames) - 5) // 17 * 5 + 2)


def estimate_sample_reserve(width, height, window_frames, cond_frames=0,
                            n_ref_images=0, duration_s=0.0):
    """估算单次采样的显存余量需求（字节）。

    window_frames 渲染窗口帧数（含钉帧 span）；cond_frames 钉帧帧数；
    n_ref_images 参考图张数；duration_s 段时长（音频行估算用）。
    """
    rows_per_step = (math.ceil(height / 16) * math.ceil(width / 16)) // 4
    video_rows = _latent_steps(window_frames) * rows_per_step
    cond_rows = _latent_steps(cond_frames) * rows_per_step if cond_frames else 0
    ref_rows = int(n_ref_images) * rows_per_step
    audio_rows = int(duration_s * 40.0)     # 音频 latent 40Hz
    seq = _TEXT_ROWS + video_rows + cond_rows + ref_rows + audio_rows
    return int((seq * _ACT_PER_ROW + _FIXED_OVERHEAD + _SMALL_MODELS) * _SAFETY)


@contextlib.contextmanager
def reserved_vram(extra_bytes):
    """采样期间临时抬高全局显存保留量，结束恢复。

    load_models_gpu 每次装载都按"空闲 − 保留"决定权重驻留，所以抬高保留
    就是把权重驻留压到安全额度；DynamicVRAM 的 prefetch 流水线自动接管
    被压出去的部分。单 worker 顺序执行，污染窗口仅限本段采样。
    """
    old = mm.EXTRA_RESERVED_VRAM
    want = max(old, int(extra_bytes))
    if want != old:
        mm.EXTRA_RESERVED_VRAM = want
        _LOG.info("显存规划：采样保留 %.1f GB（原 %.1f GB）",
                  want / 1024**3, old / 1024**3)
        emit_log("显存规划：采样保留 %.1f GB（权重驻留压低，缺口走异步预取）"
                 % (want / 1024**3))
    try:
        yield
    finally:
        mm.EXTRA_RESERVED_VRAM = old


def weight_keep_bytes(reserve_bytes):
    """采样期权重驻留上限 = 物理总量 − 规划余量。"""
    total = float(torch.cuda.get_device_properties(mm.get_torch_device()).total_memory)
    return max(0, int(total - reserve_bytes))


def clamp_weight_residency(patcher, keep_bytes, name="模型"):
    """把权重驻留主动压到 keep_bytes 以内，返回释放量（字节）。

    为什么需要它：DynamicVRAM 下 free_memory 对 dynamic 模型互不相卸
    （指望 aimdo 分配时按需抢救），partially_load 又只增不减——上一段
    decode 把 DiT 驻留推高后，下一段采样带着高驻留进场；而第二段起
    钉帧行 + 窗口加 span 让激活峰值更高，大块激活与按需抢救赛跑就会炸。
    采样前主动压舱，把确定性握在自己手里。缺口由 prefetch 流水线补。
    """
    try:
        loaded = int(patcher.loaded_size())
    except Exception:
        return 0
    excess = loaded - int(keep_bytes)
    if excess <= 256 * 1024**2:          # 256MB 以内的零头不折腾
        return 0
    try:
        freed = int(patcher.partially_unload(patcher.offload_device, excess))
    except Exception as e:
        _LOG.warning("显存规划：%s 驻留压缩失败（忽略）: %r", name, e)
        return 0
    if freed > 0:
        _LOG.info("显存规划：%s 权重驻留 %.1f -> %.1f GB（主动释放 %.1f GB）",
                  name, loaded / 1024**3, (loaded - freed) / 1024**3,
                  freed / 1024**3)
        emit_log("显存规划：%s 权重驻留 %.1f → %.1f GB（主动压舱，缺口走异步预取）"
                 % (name, loaded / 1024**3, (loaded - freed) / 1024**3))
    return freed


def fix_vae_decode_estimate(vae):
    """把 H3 视频 VAE 的 decode 内存估算换成符合其内建分块行为的真实值。

    非 H3 VAE（没有 decode_temporal）不动。幂等。"""
    fsm = getattr(vae, "first_stage_model", None)
    if fsm is None or not hasattr(fsm, "decode_temporal"):
        return False
    if getattr(vae, "_h3_decode_estimate_fixed", False):
        return True
    vae.memory_used_decode = lambda shape, dtype: _VAE_DECODE_REAL
    vae._h3_decode_estimate_fixed = True
    _LOG.info("显存规划：H3 VAE decode 估算修正为 %.1f GB（流式分块实测口径）",
              _VAE_DECODE_REAL / 1024**3)
    emit_log("显存规划：VAE 解码内存估算修正为 %.1f GB（内建滑窗流式口径，"
             "免去每段 20G 权重往返）" % (_VAE_DECODE_REAL / 1024**3))
    return True


def unload_clip(clip):
    """编码头完成后主动卸载文本编码器（采样循环不再用它）。

    DynamicVRAM 下卸载是 pin 回 RAM，万一后续节点还要用会自动重载，
    行为正确，只是省掉它在采样初期占卡的时间窗口。"""
    patcher = getattr(clip, "patcher", None)
    if patcher is None:
        return
    for loaded in list(mm.current_loaded_models):
        if loaded.model is patcher:
            if loaded.model_unload() and loaded in mm.current_loaded_models:
                mm.current_loaded_models.remove(loaded)
            _LOG.info("显存规划：CLIP 已卸载（文本条件编码完毕）")
            emit_log("显存规划：CLIP 已卸载（编码完毕，采样循环不再使用）")
            return
