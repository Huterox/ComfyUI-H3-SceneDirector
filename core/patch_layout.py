"""运动上下文布局补丁（SceneDirector 自研实现）。

要解决的问题：MiniMax H3 官方的 PackedLayout 只接受钉在第 0 帧或最后一帧
的关键帧，其余像素位置一律拒绝。而链接长视频需要把上一段尾部的一串帧
钉在新片段时间轴的任意内部位置，钉住的音频还要落在本片自己的时间轴上。

关键事实（官方代码的坐标算术）：每个视频 latent 步 k 覆盖
FRAME_PER_TOKEN[k % 5] 个像素帧，时间跨度为 FRAME_RESCALE * FRAME_PER_TOKEN[k % 5]，
所以像素帧 p 的累计时间恰好是 text_len + FRAME_RESCALE * p——官方那两个
分支（首帧/尾帧）都是这个通项的特例。官方的关键帧坐标只依赖 text_len，
而参考块会把游标往后推，因此钉帧坐标必须补上参考块占用的游标位移，
否则加参考图后锚点和目标画面错位。

补丁方式（不改官方源码）：包一层 PackedLayout.__init__——关键帧先以恒
合法的 resolved_frame_index=0 交给原版构造，真实位置用 MC_KEY 标记随行
携带，构造返回后再改写 position_ids 的时间列。RoPE 在前向时才从
position_ids 构建，改写落在任何读取之前。音频参考块同理：构造照旧，
之后把它的行整体平移到本片时间轴上（MC_AUDIO_KEY 标记目标结束帧）。

两个标记键名与 H3-Motion-Context 生态保持一致，便于共存互认。
"""

import logging

import torch

import comfy.ldm.minimax.model as mm

MC_KEY = "motion_context_index"               # 关键帧的真实像素位置
MC_AUDIO_KEY = "motion_context_audio_end_frame"  # 音频窗的结束帧（目标时间轴）
_LOG = logging.getLogger("h3_scenedirector")

_orig_init = None
_applied = False


def _ref_advance(refs):
    """参考块把目标内容的起点从 text_len 往后推多少。

    官方布局从 text_len 起顺序摆参考块：图片块占 1.0，音频块占
    ref_audio_t，视频/音视频块占两者跨度的较大者。目标视频/音频行
    以游标最终值为原点，所以这个位移必须加到钉帧坐标上。
    """
    if not refs:
        return 0.0
    cursor = 0.0
    for blk in refs:
        kind = blk.get("kind")
        if kind == "image":
            cursor += 1.0
        elif kind == "audio":
            cursor += float(blk.get("ref_audio_t", 0))
        elif kind in ("video", "video_audio"):
            rt = float(blk.get("ref_audio_t", 0))
            vt = int(blk.get("latent_t", 0))
            cursor += max(rt, sum(mm._video_t_spans(vt)))
    return cursor


def _kf_time(text_len, latent_t, frame_count, p):
    """像素帧 p 的时间坐标。首/尾帧沿用官方原式（数学上与通项相同，
    但官方尾帧分支是 latent_t 次浮点累加，通项是一次乘法，末位有几个
    ulp 的差异；首/尾逐字对齐官方，让只含首/尾帧的旧图在补丁后产出
    逐位相同的坐标）。"""
    if p == 0:
        return float(text_len)
    if frame_count is not None and p == frame_count - 1:
        return float(text_len) + sum(mm._video_t_spans(latent_t)) - mm.FRAME_RESCALE
    return float(text_len) + mm.FRAME_RESCALE * float(p)


def _rewrite_keyframes(layout, text_len, latent_t, frame_count, keyframes, refs=None):
    """把带 MC 标记的关键帧行改写到通项坐标（含参考游标位移）。"""
    offset = _ref_advance(refs)
    if offset and any(kf.get(MC_KEY) is None for kf in keyframes):
        # 官方关键帧不补游标位移，和我们的钉帧混用在同一张图里再加参考块，
        # 两类锚点会相对目标错位。目前没有这样的用法——出现就大声拒绝。
        raise RuntimeError(
            "h3_scenedirector: 官方关键帧与运动上下文钉帧混用且带参考块，"
            "坐标会互相错位。请给所有关键帧都带 %s 标记，或移除参考块。" % MC_KEY)
    cond_spans = [(a, b) for a, b, kind in layout.segments if kind == "cond"]
    if len(cond_spans) != len(keyframes):
        raise RuntimeError(
            "h3_scenedirector: 关键帧 %d 个，布局里 cond 段 %d 个，拒绝改写坐标。"
            % (len(keyframes), len(cond_spans)))
    for (a, b), kf in zip(cond_spans, keyframes):
        p = kf.get(MC_KEY)
        if p is None:
            continue
        layout.position_ids[a:b, 0] = _kf_time(text_len, latent_t, frame_count, p) + offset


def _move_audio_ref(layout, text_len, refs):
    """把带标记的音频参考块平移到本片时间轴：窗口结束于目标帧
    MC_AUDIO_KEY（与钉帧视频的结尾同一时刻）。

    官方把参考块放在目标内容之前的坐标区，模型读到的是"另一段可模仿的
    素材"；平移到本片时间轴上，模型才会把它读作"本片到目前为止的声音"
    并延续它。平移（整体加同一个位移）保留块内行结构，行选择按
    坐标槽位 + 段类型（ref_audio）双重限定，图片参考块绝不被扫到。
    """
    marked = [r for r in refs if r.get(MC_AUDIO_KEY) is not None]
    if len(marked) != 1:
        raise RuntimeError(
            "h3_scenedirector: 音频时间轴安放只支持恰好一个带标记的音频参考块；"
            "当前 %d 个参考块、%d 个带标记。" % (len(refs), len(marked)))
    blk = marked[0]
    if blk.get("kind") != "audio":
        raise RuntimeError(
            "h3_scenedirector: %s 标在了 %r 参考块上；只有音频参考块能移到时间轴。"
            % (MC_AUDIO_KEY, blk.get("kind")))
    kinds = set(r.get("kind") for r in refs)
    if not kinds <= {"image", "audio"} \
            or sum(1 for r in refs if r.get("kind") == "audio") != 1:
        raise RuntimeError(
            "h3_scenedirector: 音频时间轴安放支持若干图片参考块 + 恰好一个"
            "（带标记的）音频参考块；当前类型 %s。" % sorted(kinds))
    rt = int(blk.get("ref_audio_t", 0))
    if rt <= 0:
        return
    end_frame = float(blk[MC_AUDIO_KEY])
    # 参考块从 text_len 顺序排布，目标块的槽位起点 = text_len + 前面块的位移
    prior = refs[:refs.index(blk)]
    slot_start = float(text_len) + _ref_advance(prior)
    target_origin = float(text_len) + _ref_advance(refs)

    t = layout.position_ids[:, 0]
    sel = (t >= slot_start - 1e-4) & (t < slot_start + rt - 1e-4)
    for a, b, kind in layout.segments:
        if kind != "ref_audio":
            sel[a:b] = False
    count = int(sel.sum())
    if count < rt or count > 8 * rt:
        raise RuntimeError(
            "h3_scenedirector: 音频参考槽位里找到 %d 行，对应 %d 个 latent 步，"
            "预期在 %d..%d 之间。上游布局已变化，拒绝移动。"
            % (count, rt, rt, 8 * rt))
    # 窗口结束于 target_origin + FRAME_RESCALE * end_frame，宽度 rt 步
    shift = (target_origin + mm.FRAME_RESCALE * end_frame - rt) - slot_start
    layout.position_ids[sel, 0] = t[sel] + shift


def _patched_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
                  keyframes=None, refs=None, frame_count=None):
    _orig_init(self, text_len, latent_t, latent_h, latent_w, audio_t,
               keyframes=keyframes, refs=refs, frame_count=frame_count)
    has_mc_kf = bool(keyframes) and any(
        kf.get(MC_KEY) is not None for kf in keyframes)
    has_mc_audio = bool(refs) and any(
        r.get(MC_AUDIO_KEY) is not None for r in refs)
    if has_mc_kf:
        _rewrite_keyframes(self, text_len, latent_t, frame_count, keyframes, refs)
    if has_mc_audio:
        _move_audio_ref(self, text_len, refs)
    # 都没带标记：官方图，原样放行


def _self_test():
    """应用前的自检：证明我们的改写与官方坐标在官方支持的点位上逐位一致，
    且内部锚点、参考游标补偿、音频平移都符合预期。任何一步不符（说明
    上游 ComfyUI 改了布局算术）就拒绝应用，避免静默产出错误画面。"""
    text_len, latent_t, lh, lw, audio_t = 7, 7, 22, 38, 16
    frame_count = sum(mm.FRAME_PER_TOKEN[k % 5] for k in range(latent_t))

    stock_kf = [{"resolved_frame_index": 0},
                {"resolved_frame_index": frame_count - 1}]
    ours_kf = [{"resolved_frame_index": 0, MC_KEY: 0},
               {"resolved_frame_index": 0, MC_KEY: frame_count - 1}]

    a = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(a, text_len, latent_t, lh, lw, audio_t,
               keyframes=stock_kf, frame_count=frame_count)
    b = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(b, text_len, latent_t, lh, lw, audio_t,
               keyframes=ours_kf, frame_count=frame_count)
    _rewrite_keyframes(b, text_len, latent_t, frame_count, ours_kf)

    if a.position_ids.shape != b.position_ids.shape:
        raise RuntimeError("自检：position_ids 形状不一致")
    if not torch.equal(a.position_ids, b.position_ids):
        bad = (a.position_ids != b.position_ids).any(dim=1).nonzero().flatten()
        raise RuntimeError("自检：坐标不一致，行 %s" % bad[:8].tolist())

    # 连续钉帧：坐标必须严格递增且不超出首尾锚点定义的区间
    run = [{"resolved_frame_index": 0, MC_KEY: i} for i in range(4)]
    c = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(c, text_len, latent_t, lh, lw, audio_t,
               keyframes=run, frame_count=frame_count)
    _rewrite_keyframes(c, text_len, latent_t, frame_count, run)
    ts = [float(c.position_ids[s, 0]) for s, _, k in c.segments if k == "cond"]
    if len(ts) != len(run):
        raise RuntimeError("自检：cond 段数量 %d != 钉帧数 %d" % (len(ts), len(run)))
    if any(ts[i] >= ts[i + 1] for i in range(len(ts) - 1)):
        raise RuntimeError("自检：连续锚点未严格递增：%s" % ts)
    t_last = float(text_len) + mm.FRAME_RESCALE * (frame_count - 1)
    if not (ts[0] == float(text_len) and ts[-1] < t_last):
        raise RuntimeError("自检：锚点 %s 超出 [%.4f, %.4f] 区间"
                           % (ts, float(text_len), t_last))

    # 参考块补偿：加了音频参考后，锚点到目标末尾的距离必须不变。
    # 真值取目标行本身（官方 cond 行不算游标位移，正是要防的坑）：
    # 参考行排在目标行之前，所以 position_ids 里的最大时间坐标永远属于
    # 目标内容末尾；有无参考时，锚点-末尾间距必须一致。
    ref = [{"kind": "audio", "ref_audio_t": 8}]
    d = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(d, text_len, latent_t, lh, lw, audio_t,
               keyframes=run, refs=ref, frame_count=frame_count)
    _rewrite_keyframes(d, text_len, latent_t, frame_count, run, refs=ref)
    ts_ref = [float(d.position_ids[s, 0]) for s, _, k in d.segments if k == "cond"]
    if len(ts_ref) != len(ts):
        raise RuntimeError("自检：加参考块后 cond 段数量变了")
    tol = 1e-3   # 语义错误是整行移位（参考块的 8.0）；浮点噪声远低于此
    gap = float(c.position_ids[:, 0].max()) - ts[0]
    gap_ref = float(d.position_ids[:, 0].max()) - ts_ref[0]
    if abs(gap - gap_ref) > tol:
        raise RuntimeError(
            "自检：参考补偿失效，锚点-目标间距 %.6f（无参考）vs %.6f（有参考）"
            % (gap, gap_ref))
    shifts = [y - x for x, y in zip(ts, ts_ref)]
    if any(abs(s - shifts[0]) > tol for s in shifts):
        raise RuntimeError("自检：参考块把锚点移得不均匀：%s" % shifts)

    # 音频时间轴安放：带标记重建布局 d，要求恰好槽位内的行整体平移、
    # 其余行逐位不动
    end_frame, rt = 4, 8
    ref_mc = [{"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}]
    e = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(e, text_len, latent_t, lh, lw, audio_t,
               keyframes=run, refs=ref_mc, frame_count=frame_count)
    _rewrite_keyframes(e, text_len, latent_t, frame_count, run, refs=ref_mc)
    _move_audio_ref(e, text_len, ref_mc)
    if e.position_ids.shape != d.position_ids.shape:
        raise RuntimeError("自检：音频平移改变了布局形状")
    if not torch.equal(d.position_ids[:, 1:], e.position_ids[:, 1:]):
        raise RuntimeError("自检：音频平移动了非时间列")
    td, te = d.position_ids[:, 0], e.position_ids[:, 0]
    cond_rows = set()
    for a_, b_, kind in d.segments:
        if kind == "cond":
            cond_rows.update(range(a_, b_))
    expect_moved = set(i for i in range(len(td))
                       if text_len - 1e-4 <= float(td[i]) < text_len + rt - 1e-4
                       and i not in cond_rows)
    moved = set(i for i in range(len(td)) if float(td[i]) != float(te[i]))
    if moved != expect_moved:
        raise RuntimeError("自检：音频平移扫错了行：移动 %d 行，预期 %d 行"
                           % (len(moved), len(expect_moved)))
    if not moved:
        raise RuntimeError("自检：音频平移没有移动任何行")
    want_shift = mm.FRAME_RESCALE * end_frame   # 此用例位移恰等于 rt，抵消
    deltas = [float(te[i]) - float(td[i]) for i in sorted(moved)]
    if any(abs(dd - want_shift) > 1e-5 for dd in deltas):
        raise RuntimeError("自检：音频行平移量不一致或不正确：%s 应为 %.6f"
                           % (deltas[:4], want_shift))

    # 多参考块：图片参考在前、带标记音频在后——音频行照移，图片行逐位不动
    ref_mix = [{"kind": "image", "latent_h": 4, "latent_w": 6},
               {"kind": "audio", "ref_audio_t": rt, MC_AUDIO_KEY: end_frame}]
    f = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(f, text_len, latent_t, lh, lw, audio_t,
               keyframes=run, refs=ref_mix, frame_count=frame_count)
    _rewrite_keyframes(f, text_len, latent_t, frame_count, run, refs=ref_mix)
    _move_audio_ref(f, text_len, ref_mix)
    g = mm.PackedLayout.__new__(mm.PackedLayout)
    _orig_init(g, text_len, latent_t, lh, lw, audio_t,
               keyframes=run, refs=ref_mix, frame_count=frame_count)
    _rewrite_keyframes(g, text_len, latent_t, frame_count, run, refs=ref_mix)
    img_rows, aud_rows = set(), set()
    for a_, b_, kind in f.segments:
        if kind == "ref_img":
            img_rows.update(range(a_, b_))
        elif kind == "ref_audio":
            aud_rows.update(range(a_, b_))
    if not img_rows or not aud_rows:
        raise RuntimeError("自检：多参考块用例缺参考段")
    tf, tg = f.position_ids[:, 0], g.position_ids[:, 0]
    if any(float(tf[i]) != float(tg[i]) for i in sorted(img_rows)):
        raise RuntimeError("自检：多参考块用例的图片参考行被移动")
    deltas = [float(tf[i]) - float(tg[i]) for i in sorted(aud_rows)]
    if any(abs(dd - want_shift) > 1e-5 for dd in deltas):
        raise RuntimeError("自检：多参考块用例的音频行平移错误：%s 应为 %.6f"
                           % (deltas[:4], want_shift))


def apply_patch():
    """应用布局补丁。若进程里已有同生态补丁（另一份拷贝先应用了），
    直接认领养——再包一层会让音频行的相对平移执行两次。"""
    global _orig_init, _applied
    if _applied:
        return True
    if not hasattr(mm, "PackedLayout") or not hasattr(mm, "FRAME_RESCALE"):
        _LOG.warning("h3_scenedirector: MiniMax H3 模型模块缺预期属性，补丁未应用")
        return False
    if getattr(mm.PackedLayout.__init__, "__name__", "") == "_patched_init":
        _applied = True
        _LOG.info("h3_scenedirector: 布局补丁已在位（另一份拷贝应用），认领养复用")
        return True
    _orig_init = mm.PackedLayout.__init__
    try:
        _self_test()
    except Exception as exc:
        _orig_init = None
        _LOG.warning("h3_scenedirector: 自检失败（%s），补丁未应用。"
                     "内部关键帧锚定不可用。", exc)
        return False
    mm.PackedLayout.__init__ = _patched_init
    _applied = True
    _LOG.info("h3_scenedirector: 内部关键帧锚定已启用")
    return True


def is_applied():
    return _applied
