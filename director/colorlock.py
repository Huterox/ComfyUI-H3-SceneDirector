"""颜色锁定 + 接缝互补：色彩一致性的两层。

面（全片不漂）：逐段独立渲染时，模型会对曝光与白平衡做微小的重新
决策，多段串联后累积成肉眼可见的变暗/变色（中性灰底场景尤其明显）。
match/match_smooth 做整段统计校色——只修交付像素，不动内容、不动 latent。

缝（接口不跳）：opening_luma_blend 把本段开头若干帧的亮度以加性等值
位移向上一段尾巴渐变对齐（乘性增益会造成亮度泵，Director 实测结论）；
seam_echo_count 做接缝回声诊断。这一层与 Director 的接缝处理同思路，
是我们的自研互补实现。

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


def luma_of(images):
    """整段平均亮度（Rec.601）。images: [T,H,W,C] 浮点 [0,1]。"""
    return float(_luma(images).mean().item())


def luma_match(images, ref_luma, ratio_clamp=(0.55, 1.8)):
    """整段平均亮度按比例归一到参考值（Director 同款思路的我们的实现）：
    只做整体亮度缩放，不动色相、不动对比度结构——与 color_lock 的
    均值/方差通道匹配互补（那个连色偏一起修，这个只稳亮度）。

    参考取第 1 段的交付亮度（链式参考会累积漂移）；ratio 夹在
    [0.55, 1.8] 防内容差异被误当漂移硬拉；变化不足 1% 不动。"""
    cur = luma_of(images)
    if cur < 1e-4:
        return images
    ratio = max(ratio_clamp[0], min(ratio_clamp[1], float(ref_luma) / cur))
    if abs(ratio - 1.0) < 0.01:
        return images
    return (images * ratio).clamp(0.0, 1.0)


def opening_luma_blend(images, prev_tail, k=12, max_delta=0.10, trigger=0.02):
    """开头亮度向上一段尾巴渐变对齐——加性等值位移版。

    Director 的迭代结论：乘性 fading gain（逐帧按比率缩放）会在接缝后
    形成亮度泵（一闪一闪）；把亮度差折算成全通道等值 delta 加上去，
    只动亮度、不压局部对比度，也就没有拖影。这里按同思路自研：

    前 k 帧的平均亮度从 prev_tail[-1] 线性缓到 images[k]，每帧加
    同一个 RGB delta（封顶 ±max_delta）；接缝本来就很顺滑（两端差值
    都小于 trigger）时原样不动。
    """
    if prev_tail is None or int(prev_tail.shape[0]) < 1:
        return images
    n = min(int(k), int(images.shape[0]) - 1)
    if n < 2:
        return images
    y_start = float(_luma(prev_tail[-1]).mean().item())
    y0 = float(_luma(images[0]).mean().item())
    y_end = float(_luma(images[n]).mean().item())
    if abs(y0 - y_start) < trigger and abs(y_end - y_start) < trigger:
        return images
    out = images.clone()
    for i in range(n):
        t = float(i) / float(n)
        target = y_start * (1.0 - t) + y_end * t
        cur = float(_luma(out[i]).mean().item())
        delta = max(-float(max_delta), min(float(max_delta), target - cur))
        if abs(delta) < 1e-5:
            continue
        out[i] = (out[i].float() + delta).clamp(0.0, 1.0).to(dtype=out.dtype)
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
