"""补丁语义测试（自研，纯 CPU 离线）。

用一个 numpy 版的山寨 PackedLayout 复刻官方布局语义：

  - 文本行占坐标 0..text_len-1
  - 参考块从 text_len 起的游标顺序排布：音频块推进 ref_audio_t、
    铺 2*ref_audio_t 行；图片块推进 1.0、铺 1 行
  - 关键帧 cond 段按官方坐标（从 text_len 算，不补游标），
    且官方只认第 0 帧/末帧——内部锚点直接抛错（这正是补丁要解的限制）
  - 目标视频行从游标末端按 _video_t_spans 排，目标音频行 1.0 间距

然后验证：
  1. 对忠实的山寨官方，补丁自检通过
  2. 内部锚点落位正确，加音频参考后锚点随游标补偿
  3. 游标算术被上游改动（2 倍推进）时自检必须失败
  4. 官方关键帧与钉帧混用且带参考块时被大声拒绝
  5. 音频参考块被端到端对齐地平移到目标帧，其余行不动
"""

import importlib
import os
import sys
import types

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FRAME_RESCALE = 5.0 / 3.0
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)


def _video_t_spans(latent_t):
    return [FRAME_RESCALE * FRAME_PER_TOKEN[k % 5] for k in range(latent_t)]


def make_mm(ref_factor=1.0):
    """构造山寨 comfy.ldm.minimax.model。ref_factor != 1 模拟上游改动
    参考块的游标推进。"""
    mm = types.ModuleType("comfy.ldm.minimax.model")
    mm.FRAME_RESCALE = FRAME_RESCALE
    mm.FRAME_PER_TOKEN = FRAME_PER_TOKEN
    mm._video_t_spans = _video_t_spans

    class PackedLayout:
        def __init__(self, text_len, latent_t, latent_h, latent_w, audio_t,
                     keyframes=None, refs=None, frame_count=None):
            rows_per_cond = 4      # 顶替 latent_h * latent_w
            segs, coords = [], []

            def emit(kind, ts):
                a = len(coords)
                coords.extend(ts)
                segs.append((a, len(coords), kind))

            emit("text", [float(i) for i in range(text_len)])

            cursor = float(text_len)
            for blk in (refs or []):
                kind = blk.get("kind")
                if kind == "audio":
                    rt = float(blk["ref_audio_t"]) * ref_factor
                    emit("ref_audio", [cursor + i * 0.5
                                       for i in range(2 * int(rt))] or [cursor])
                    cursor += rt
                elif kind == "image":
                    emit("ref_img", [cursor])
                    cursor += 1.0
                else:
                    raise ValueError("山寨：不支持的参考类型 %r" % kind)

            spans = _video_t_spans(latent_t)
            for kf in (keyframes or []):
                p = kf["resolved_frame_index"]
                if p == 0:
                    t = float(text_len)
                elif frame_count is not None and p == frame_count - 1:
                    t = float(text_len) + sum(spans) - FRAME_RESCALE
                else:
                    raise ValueError("only first/last keyframe anchors are supported")
                emit("cond", [t] * rows_per_cond)

            acc, vts = cursor, []
            for s in spans:
                vts.append(acc)
                acc += s
            emit("video", vts)
            emit("audio", [cursor + float(i) for i in range(audio_t)])

            self.segments = segs
            self.position_ids = np.zeros((len(coords), 4), dtype=np.float64)
            self.position_ids[:, 0] = coords

    mm.PackedLayout = PackedLayout
    return mm


def make_torch():
    t = types.ModuleType("torch")
    t.equal = lambda a, b: a.shape == b.shape and bool(np.array_equal(a, b))
    return t


def load_patch(mm):
    for name in ("comfy", "comfy.ldm", "comfy.ldm.minimax"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["comfy.ldm.minimax.model"] = mm
    sys.modules["comfy"].ldm = sys.modules["comfy.ldm"]
    sys.modules["comfy.ldm"].minimax = sys.modules["comfy.ldm.minimax"]
    sys.modules["torch"] = make_torch()
    sys.modules.pop("core.patch_layout", None)
    sys.modules.pop("core", None)
    return importlib.import_module("core.patch_layout")


def main():
    # 1. 忠实官方：补丁必须能应用（自检通过）
    mm = make_mm()
    pl = load_patch(mm)
    assert pl.apply_patch(), "忠实官方布局上自检失败"
    assert pl.is_applied()
    print("1. 自检通过（忠实官方布局）")

    # 2. 内部锚点落位 + 参考游标补偿
    text_len, latent_t, lh, lw, audio_t = 7, 7, 22, 38, 16
    fc = sum(FRAME_PER_TOKEN[k % 5] for k in range(latent_t))
    run = [{"resolved_frame_index": 0, pl.MC_KEY: i} for i in range(4)]
    lay = mm.PackedLayout(text_len, latent_t, lh, lw, audio_t,
                          keyframes=run, frame_count=fc)
    ts = [float(lay.position_ids[a, 0]) for a, _, k in lay.segments if k == "cond"]
    exp = [text_len + FRAME_RESCALE * i for i in range(4)]
    assert np.allclose(ts, exp), (ts, exp)
    ref = [{"kind": "audio", "ref_audio_t": 8}]
    lay2 = mm.PackedLayout(text_len, latent_t, lh, lw, audio_t,
                           keyframes=run, refs=ref, frame_count=fc)
    ts2 = [float(lay2.position_ids[a, 0]) for a, _, k in lay2.segments if k == "cond"]
    assert np.allclose(ts2, [t + 8.0 for t in ts]), (ts, ts2)
    print("2. 内部钉帧落位", [round(t, 4) for t in ts],
          "-> 加 8 步参考后", [round(t, 4) for t in ts2])

    # 3. 上游改了游标算术：自检必须失败、补丁拒绝应用
    bad = make_mm(ref_factor=2.0)
    pl_bad = load_patch(bad)
    assert not pl_bad.apply_patch(), "游标算术变了自检还能过（不应该）"
    print("3. 游标算术漂移被自检捕获，补丁拒绝应用")

    # 4. 官方关键帧 + 钉帧混用且带参考：大声拒绝
    pl3 = load_patch(make_mm())
    assert pl3.apply_patch()
    mm3 = sys.modules["comfy.ldm.minimax.model"]
    mixed = [{"resolved_frame_index": 0},
             {"resolved_frame_index": 0, pl3.MC_KEY: 2}]
    try:
        mm3.PackedLayout(text_len, latent_t, lh, lw, audio_t,
                         keyframes=mixed, refs=ref, frame_count=fc)
    except RuntimeError as e:
        assert "混用" in str(e)
        print("4. 官方帧/钉帧混用带参考被大声拒绝")
    else:
        raise AssertionError("混用没有被拒绝")

    # 5. 音频时间轴安放：参考行端到端对齐到目标帧，其余行不动
    pl4 = load_patch(make_mm())
    assert pl4.apply_patch()
    mm4 = sys.modules["comfy.ldm.minimax.model"]
    run4 = [{"resolved_frame_index": 0, pl4.MC_KEY: i} for i in range(4)]
    rt, end_frame = 8, 22
    ref_mc = [{"kind": "audio", "ref_audio_t": rt,
               pl4.MC_AUDIO_KEY: end_frame}]
    lay = mm4.PackedLayout(text_len, latent_t, lh, lw, audio_t,
                           keyframes=run4, refs=ref_mc, frame_count=fc)
    ref_rows = [i for a, b, k in lay.segments if k == "ref_audio"
                for i in range(a, b)]
    times = sorted(float(lay.position_ids[i, 0]) for i in ref_rows)
    target_origin = text_len + rt
    want_end = target_origin + FRAME_RESCALE * end_frame
    assert abs(times[0] - (want_end - rt)) < 1e-6, (times[0], want_end - rt)
    assert abs(times[-1] - (want_end - 0.5)) < 1e-6, (times[-1], want_end)
    # 视频锚点仍然只受游标补偿，不被音频平移波及
    ts4 = [float(lay.position_ids[a, 0]) for a, _, k in lay.segments if k == "cond"]
    assert np.allclose(ts4, [target_origin + FRAME_RESCALE * i for i in range(4)]), ts4
    print("5. 音频行端对齐于 %d 帧（t %.3f..%.3f），视频锚点未被波及"
          % (end_frame, times[0], times[-1]))

    print("全部通过")


if __name__ == "__main__":
    main()
