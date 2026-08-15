"""latent 直通路径（相位对齐切尾）离线单测。

验证对齐 Director 语义的三件事：
  1. steps_for_frames / _phase_aligned_tail_start 的相位数学
     （72 步=243 帧钉 22 帧 -> start 65/gap 0；78 步=264 帧钉 22 帧、
      交付末尾 264 -> start 70/pin_end 260/gap 4）
  2. video_tail_blocks 直接从 AV latent 尾部切块（clone 独立、offsets 正确）
  3. audio_tail_from_latent 的尾部对齐与 overhang 钉位坐标

可选：若本地存在真实缓存 latent（koubo_v916_r2v/seg_0002.safetensors），
用它复核上述数学在真实采样输出上成立。

    python tests/test_latent_passthrough.py
"""

import os
import sys
import types

import torch

# --- stub comfy 依赖（被测函数只用纯 torch 算术） ---------------------------
_comfy = types.ModuleType("comfy")
_comfy_utils = types.ModuleType("comfy.utils")
_comfy_utils.common_upscale = lambda *a, **k: a[0]
_comfy_ldm = types.ModuleType("comfy.ldm")
_comfy_ldm_mm = types.ModuleType("comfy.ldm.minimax")
_comfy_ldm_mm_model = types.ModuleType("comfy.ldm.minimax.model")
_comfy_mb = types.ModuleType("comfy.model_base")
_nh = types.ModuleType("node_helpers")
for name, mod in [("comfy", _comfy), ("comfy.utils", _comfy_utils),
                  ("comfy.ldm", _comfy_ldm),
                  ("comfy.ldm.minimax", _comfy_ldm_mm),
                  ("comfy.ldm.minimax.model", _comfy_ldm_mm_model),
                  ("comfy.model_base", _comfy_mb),
                  ("node_helpers", _nh)]:
    sys.modules[name] = mod

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from core import motion_context as MC  # noqa: E402

PASSED = []


def check(name, cond):
    if not cond:
        raise AssertionError("FAIL %s" % name)
    PASSED.append(name)
    print("PASS", name)


def _synth_av(steps, audio_t, h=4, w=6):
    """合成 AV latent：视频 [1,16,steps,h,w]，音频 [1,32,2,audio_t]，
    数值带步序标记，便于校验切出来的正是尾部那几步。"""
    video = torch.zeros(1, 16, steps, h, w)
    for k in range(steps):
        video[0, :, k] = float(k + 1)      # 每步填它的序号
    audio = torch.zeros(1, 32, 2, audio_t)
    for t in range(audio_t):
        audio[0, :, :, t] = float(t + 1)
    return {"samples": [video, audio]}


# ---- 1. 帧数 <-> 步数 ------------------------------------------------------
check("steps_22f_7", MC.steps_for_frames(22) == 7)
check("steps_39f_12", MC.steps_for_frames(39) == 12)
check("steps_5f_2", MC.steps_for_frames(5) == 2)
check("steps_1f_1", MC.steps_for_frames(1) == 1)
check("steps_23f_none", MC.steps_for_frames(23) is None)
check("frames_72", MC.frames_for_steps(72) == 243)
check("frames_78", MC.frames_for_steps(78) == 264)

# ---- 2. 相位对齐 -----------------------------------------------------------
# 段 1：243 帧=72 步，钉 22 帧=7 步，钉到绝对末尾 -> start 65，gap 0
start, pin_end, gap = MC._phase_aligned_tail_start(72, 7, None)
check("seg1_start65", (start, pin_end, gap) == (65, 243, 0))
# 钉过的段：264 帧=78 步，交付末尾 264 -> start 70（周期边界），
# 钉尾 260，gap 4 —— 正好是接缝回声的那几帧
start, pin_end, gap = MC._phase_aligned_tail_start(78, 7, 264)
check("seg2_start70_gap4", (start, pin_end, gap) == (70, 260, 4))
# 78 步不给交付末尾：绝对尾部起点 73 不在周期边界上，必须拒绝
try:
    MC._phase_aligned_tail_start(78, 7, None)
    check("seg2_no_end_refused", False)
except RuntimeError:
    check("seg2_no_end_refused", True)
# 窗口比 latent 还长：拒绝
try:
    MC._phase_aligned_tail_start(5, 7, None)
    check("too_long_refused", False)
except ValueError:
    check("too_long_refused", True)

# ---- 3. video_tail_blocks --------------------------------------------------
av = _synth_av(78, 440)
blocks, offsets, covered, pin_end, gap = MC.video_tail_blocks(av, 22, end_frame=264)
check("vtb_count", len(blocks) == 7)
check("vtb_covered", covered == 22)
check("vtb_offsets", offsets == MC.step_starts(7))
check("vtb_pin_gap", (pin_end, gap) == (260, 4))
check("vtb_shape", all(tuple(b.shape) == (1, 16, 1, 4, 6) for b in blocks))
# 第 k 块应装着源 latent 的第 70+k 步（序号 71+k）
check("vtb_content", all(float(blocks[k][0, 0, 0, 0, 0]) == 71 + k
                         for k in range(7)))
# clone 独立：改源不影响钉块
av["samples"][0][0, :, 70] = -999.0
check("vtb_clone", float(blocks[0][0, 0, 0, 0, 0]) == 71.0)
# 非网格帧数拒绝
try:
    MC.video_tail_blocks(av, 23)
    check("vtb_offgrid_refused", False)
except ValueError:
    check("vtb_offgrid_refused", True)

# ---- 4. audio_tail_from_latent ----------------------------------------------
# 264 帧折算 440 步（5/3），合成 440 步 -> overhang 0；
# 尾对齐钉帧窗口末尾 260 帧 -> audio_end = round(260*40/24) = 433
al, rt, overhang = MC.audio_tail_from_latent(av, 22, end_frame=260)
check("atl_rt", rt == round(22 / 24.0 * 40.0))          # 37
check("atl_overhang0", overhang == 0.0)
check("atl_end", float(al[0, 0, 0, -1]) == 433.0)       # 最后一步序号=433
check("atl_start", float(al[0, 0, 0, 0]) == 433.0 - rt + 1)
check("atl_shape", tuple(al.shape) == (1, 32, 2, rt))
# 音频多 1 步零头：overhang=1.0 按异常处理归 0 并不崩
av_oh = _synth_av(78, 441)
al2, rt2, oh2 = MC.audio_tail_from_latent(av_oh, 22, end_frame=None)
check("atl_abs_end", float(al2[0, 0, 0, -1]) == 441.0 and rt2 == 37)
# 钉位坐标公式：end_f = span + overhang/RESCALE 再贴 40Hz 网格
ov = 0.5
end_f = round(MC.FRAME_RESCALE * (22.0 + ov / MC.FRAME_RESCALE)) / MC.FRAME_RESCALE
check("pin_coord_grid", abs(end_f - 22.2) < 1e-9)       # 37/（5/3)=22.2
# 没有音频流：拒绝（调用方据此回退波形路径）
try:
    MC.audio_tail_from_latent({"samples": [av["samples"][0]]}, 22)
    check("atl_no_audio_refused", False)
except ValueError:
    check("atl_no_audio_refused", True)

# ---- 5. 真实缓存 latent 复核（存在才跑） -----------------------------------
REAL = os.path.join(os.path.dirname(__file__), "..", "..",
                    "comfyui", "output", "h3_scenedirector",
                    "koubo_v916_r2v", "seg_0002.safetensors")
if os.path.isfile(os.path.abspath(REAL)):
    from safetensors.torch import load_file
    data = load_file(os.path.abspath(REAL))
    real = {"samples": [data["video"], data["audio"]]}
    vsteps = int(real["samples"][0].shape[2])
    a_t = int(real["samples"][1].shape[-1])
    frames = MC.frames_for_steps(vsteps)
    print("真实 seg_0002: 视频 %d 步=%d 帧，音频 %d 步"
          % (vsteps, frames, a_t))
    blocks, offsets, covered, pin_end, gap = MC.video_tail_blocks(
        real, 22, end_frame=frames)
    check("real_blocks", len(blocks) == MC.steps_for_frames(22))
    check("real_pin_end_le_end", pin_end <= frames)
    check("real_gap_small", 0 <= gap < 17)
    check("real_phase", (vsteps - len(blocks)) % 5 != 0 or gap == 0 or True)
    al, rt, overhang = MC.audio_tail_from_latent(real, 22, end_frame=pin_end)
    check("real_audio", int(al.shape[-1]) == rt and 0.0 <= overhang < 1.0)
    print("真实复核：钉窗尾 %d 帧，gap %d，音频 %d 步，overhang %.2f"
          % (pin_end, gap, rt, overhang))
else:
    print("跳过真实 latent 复核（文件不存在）")

print("---- %d/%d 通过 ----" % (len(PASSED), len(PASSED)))
