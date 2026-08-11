"""颜色锁定 + 接缝互补：色彩一致性的两层。

面（全片不漂）：逐段独立渲染时，模型会对曝光与白平衡做微小的重新
决策，多段串联后累积成肉眼可见的变暗/变色（中性灰底场景尤其明显）。
match/match_smooth 做整段统计校色——只修交付像素，不动内容、不动 latent。

缝（接口不跳）：opening_luma_blend 把本段开头几帧亮度向上一段尾巴
渐变对齐；seam_echo_count 做接缝回声诊断。这一层与 Director 的
"引导帧亮度归一/开头混合"同思路，是我们的自研互补实现。

适合锁机位、恒定光照的片子（口播、装配）；光照需要渐变的片子
（比如结尾要破晓）请关闭 color_lock，否则渐变会被抹平。
"""

import torch.nn.functional as F


# ---------------------------------------------------------------------------
# 面：全片逐帧校色
# ---------------------------------------------------------------------------

def stats(images):
    """整段聚合的颜色统计。

    images: [T,H,W,C] 浮点张量，值域 [0,1]（ComfyUI IMAGE 约定）。
    返回 (mean[C], std[C])。整段聚合而不是逐帧：帧间内容在运动，
    逐帧统计会把动作差异误当颜色漂移。
    """
    dims = tuple(range(images.ndim - 1))  # 除通道维外全部聚合
    return images.mean(dim=dims), images.std(dim=dims)


def match(images, ref_mean, ref_std):
    """把 images 的每通道均值/方差对齐到参考统计，钳回 [0,1]。

    std 近零的极端平帧用 clamp_min 兜底，增益不会爆炸。
    注意：整段同一个校正值——段内慢漂移会残留在接缝处形成跳变，
    接缝敏感的片子请用 match_smooth。
    """
    mean, std = stats(images)
    gain = ref_std / std.clamp_min(1e-4)
    return ((images - mean) * gain + ref_mean).clamp(0.0, 1.0)


def match_smooth(images, ref_mean, ref_std, win=13):
    """逐帧滑动校色：增益整段对齐，偏移按每帧滑动均值钉到参考。

    整段一次校正的缺陷：钉帧窗口被裁出交付后，每段交付开头距锚点已有
    一段自由生成，曝光在段内漂走，整段校正补不掉段内梯度，漂移全挤到
    接缝处变成肉眼可见的跳变。这里把偏移拆成逐帧的：
    每帧偏移 = 参考均值 - 该帧均值的滑动平均（窗口 ~0.5s）——
    窗口内的手势/表情等内容变化原样通过，窗口外的慢漂移被压平，
    且接缝两侧统计天然连续（参考即上一段交付尾部的目标值）。
    """
    _mean, std = stats(images)
    gain = ref_std / std.clamp_min(1e-4)
    x = images * gain                                  # 先对齐对比度
    pm = x.mean(dim=(1, 2))                            # 每帧均值 [T,C]
    pad = win // 2
    sm = F.avg_pool1d(F.pad(pm.movedim(-1, 0).unsqueeze(0), (pad, pad),
                            mode="replicate"),
                      kernel_size=win, stride=1)[0].movedim(0, -1)
    offset = ref_mean - sm                             # [T,C]
    return (x + offset.view(-1, 1, 1, x.shape[-1])).clamp(0.0, 1.0)


# ---------------------------------------------------------------------------
# 缝：开头亮度渐变 + 回声诊断
# ---------------------------------------------------------------------------

def _luma(frame):
    """Rec.601 亮度。frame: [..., H,W,C] 浮点 [0,1]。"""
    f = frame.float()
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def opening_luma_blend(images, prev_tail, k=4, strength=0.85, ratio_clamp=(0.8, 1.25)):
    """开头亮度向上一段尾巴渐变对齐：本段前 k 帧按线性衰减权重把亮度
    拉向上一段末帧亮度，只调亮度不改内容。

    images: [T,H,W,C] 本段交付帧；prev_tail: [N,H,W,C] 上一段交付尾部
    （至少 1 帧）。接缝两侧内容由 latent 钉帧保证连续，这里只消除
    亮度层面的跳变。
    """
    if prev_tail is None or int(prev_tail.shape[0]) < 1 or int(images.shape[0]) < 1:
        return images
    target = float(_luma(prev_tail[-1]).mean().item())
    target = max(target, 1e-4)
    out = images.clone()
    n = min(int(k), int(out.shape[0]))
    for i in range(n):
        cur = float(_luma(out[i]).mean().item())
        if cur < 1e-4:
            continue
        ratio = target / cur
        lo, hi = ratio_clamp
        ratio = max(lo, min(hi, ratio))
        w = strength * (n - i) / n
        out[i] = (out[i] * (1.0 + (ratio - 1.0) * w)).clamp(0.0, 1.0)
    return out


def seam_echo_count(body, prev_tail, max_k=4, mad_threshold=0.02):
    """接缝回声诊断：本段开头有连续几帧在重放上一段尾巴（MAD 小于
    阈值判"回声"）。只记日志不改数据——回声多说明钉帧内容渗透进
    了交付开头，是衔接机制的观察指标。"""
    if (prev_tail is None or int(prev_tail.shape[0]) < 1
            or int(body.shape[0]) < 1 or max_k <= 0):
        return 0
    limit = min(int(max_k), int(body.shape[0]), int(prev_tail.shape[0]))
    for n in range(limit, 0, -1):
        mad = float((body[:n].float() - prev_tail[-n:].float()).abs().mean().item())
        if mad <= mad_threshold:
            return n
    return 0
