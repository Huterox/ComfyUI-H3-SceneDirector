"""段计划：把规范化载荷解析成可执行的 SegmentPlan 列表。

任务模式推断在载荷层已完成（payload.infer_task），这里只做执行侧
组织：run mask（选择运行）与缓存级联规则、链条衔接的让位规则。
不 import ComfyUI——保持离线可测。
"""

from dataclasses import dataclass, field

CONTINUITY_TASK_KEYS = ("t2v", "i2v", "r2v", "v2v", "rv2v")


@dataclass
class SegmentPlan:
    index: int            # 链内序号（0 基）
    seg: dict             # 规范化后的段载荷
    hash: str             # 段内容指纹
    task: str             # t2v/i2v/fl2v/r2v/v2v/rv2v
    enabled: bool         # 选择运行：False = 缓存填充
    has_keyframes: bool   # 带首/尾帧锚定（链条上下文让位）
    has_source: bool      # 带 v2v 源片段

    @property
    def duration(self):
        return float(self.seg["duration"])


@dataclass
class RunPlan:
    run: str
    segments: list = field(default_factory=list)

    @property
    def n_enabled(self):
        return sum(1 for s in self.segments if s.enabled)


def build_plan(run, segs, hashes):
    """载荷段 -> RunPlan。"""
    plans = []
    for i, seg in enumerate(segs):
        plans.append(SegmentPlan(
            index=i, seg=seg, hash=hashes[i],
            task=seg.get("task", "t2v"),
            enabled=bool(seg.get("enabled", True)),
            has_keyframes=bool(seg.get("first_frame") or seg.get("last_frame")),
            has_source=bool(seg.get("source"))))
    return RunPlan(run=run, segments=plans)


def use_continuity(plan, sp, continuity_on):
    """本段是否钉上一段的运动上下文。

    规则：开关开 + 非首段 + 本段没有自己的首/尾帧锚定。
    钉了首帧的段由关键帧决定开场，链条上下文让位（两者同抢时间轴
    头部，钉帧优先——关键帧是用户的显式意图）。
    """
    return (continuity_on and sp.index > 0 and not sp.has_keyframes
            and sp.task in CONTINUITY_TASK_KEYS)


def first_dirty_index(plan, cached_meta, latent_exists):
    """缓存级联点：第一个"启用且失效"的段；它之后**启用的段**全部级联。
    未启用段（选择运行关掉的）永远走缓存填充，不参与级联。"""
    cached = cached_meta or []
    first = len(plan.segments)
    for sp in plan.segments:
        if not sp.enabled:
            continue
        m = cached[sp.index] if sp.index < len(cached) else None
        if (not m or m.get("hash") != sp.hash or m.get("trim") is None
                or not latent_exists(sp.index)):
            first = sp.index
            break
    return first
