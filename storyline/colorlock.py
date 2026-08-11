"""颜色锁定：把每段的整体色温/曝光统计对齐到参考段。

逐段独立渲染时，模型会对曝光与白平衡做微小的重新决策，多段串联后
累积成肉眼可见的变暗/变色（中性灰底场景尤其明显）。这里做最朴素的
统计校色——按通道对齐整段的均值/方差（Reinhard 式），不动内容、
不动 latent，只修正交付像素。

适合锁机位、恒定光照的片子（口播、装配）；光照需要渐变的片子
（比如结尾要破晓）请关闭，否则渐变会被抹平。
"""

import torch.nn.functional as F


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
