"""colorlock 单元测试：真实 torch，纯 CPU，可直接 python 运行。

校验：
  * match 之后整段均值/方差贴回参考段
  * 平帧（std≈0）不炸、不产 NaN
  * 值域始终钳在 [0,1]
"""

import os
import sys

import torch

_PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PKG)
from storyline.colorlock import match, match_smooth, stats  # noqa: E402


def test_match_reduces_drift():
    torch.manual_seed(0)
    ref = torch.rand(8, 16, 16, 3) * 0.2 + 0.6
    drifted = (ref * 0.9 + 0.02).clamp(0, 1)  # 模拟逐段变暗+偏移
    ref_mean, ref_std = stats(ref)
    fixed = match(drifted, ref_mean, ref_std)
    fm, fs = stats(fixed)
    assert torch.allclose(fm, ref_mean, atol=1e-3), (fm, ref_mean)
    assert torch.allclose(fs, ref_std, atol=1e-3), (fs, ref_std)


def test_flat_frame_safe():
    flat = torch.full((4, 8, 8, 3), 0.5)
    ref = torch.rand(4, 8, 8, 3)
    out = match(flat, *stats(ref))
    assert torch.isfinite(out).all()
    assert out.min() >= 0.0 and out.max() <= 1.0


def test_output_range_clamped():
    ref = torch.rand(4, 8, 8, 3) * 0.1  # 很暗的参考
    bright = torch.rand(4, 8, 8, 3) * 0.5 + 0.5
    out = match(bright, *stats(ref))
    assert out.min() >= 0.0 and out.max() <= 1.0


def test_smooth_kills_intra_segment_drift():
    """段内线性漂移（曝光越走越偏）应被逐帧滑动校正压平。"""
    torch.manual_seed(1)
    base = torch.rand(48, 16, 16, 3) * 0.2 + 0.55
    ramp = torch.linspace(0, 0.08, 48).view(-1, 1, 1, 1)   # 段内渐亮 0.08
    drifted = (base + ramp).clamp(0, 1)
    ref = base[:8]                                          # 参考 = 开头水平
    out = match_smooth(drifted, *stats(ref))
    pm = out.mean(dim=(1, 2))                               # 每帧均值 [T,C]
    assert (pm - pm[0]).abs().max() < 0.02, (pm[-1] - pm[0])
    assert out.min() >= 0.0 and out.max() <= 1.0


def test_smooth_preserves_fast_content_change():
    """窗口内的瞬时变化（如手一闪而过）应保留；持续超窗的变化按设计压掉。"""
    torch.manual_seed(2)
    ref = torch.rand(24, 16, 16, 3) * 0.2 + 0.5
    seg = ref.clone()
    seg[12:16] += 0.15                     # 4 帧瞬时变亮（< 窗口 13）
    out = match_smooth(seg.clamp(0, 1), *stats(ref))
    transient = out[13].mean() - out[5].mean()
    assert transient > 0.07, transient     # 瞬时内容保留大半
    seg2 = ref.clone()
    seg2[12:] += 0.15                      # 持续变亮（> 窗口）
    out2 = match_smooth(seg2.clamp(0, 1), *stats(ref))
    persistent = out2[20].mean() - out2[5].mean()
    assert persistent < 0.03, persistent   # 持续漂移按设计压平


if __name__ == "__main__":
    test_match_reduces_drift()
    test_flat_frame_safe()
    test_output_range_clamped()
    test_smooth_kills_intra_segment_drift()
    test_smooth_preserves_fast_content_change()
    print("colorlock 测试全绿")
