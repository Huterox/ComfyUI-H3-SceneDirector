"""节点与运动上下文冒烟测试（自研，纯 CPU 离线）。

用 numpy 版假模块把包拉起来，然后像图执行一样驱动：
  * 包导入（补丁应用 + 节点注册 + 路由注册）
  * apply_motion_context：124 帧片段、22 帧钉帧、带音频波形——
    校验关键帧数量/落点、音频参考块、trim
  * trim_av：头部裁帧 + 音画同步裁剪 + 尾部修齐
  * streams_from_av 的 NestedTensor 解包
"""

import importlib.util
import os
import sys
import types

import numpy as np

_TESTS = os.path.dirname(os.path.abspath(__file__))
_PKG = os.path.dirname(_TESTS)
sys.path.insert(0, _TESTS)
from test_patch_layout import make_mm, make_torch, FRAME_PER_TOKEN  # noqa: E402


class T:
    """最小 numpy 张量替身。"""

    def __init__(self, a):
        self.a = np.asarray(a)

    @property
    def shape(self):
        return self.a.shape

    @property
    def ndim(self):
        return self.a.ndim

    def __getitem__(self, idx):
        return T(self.a[idx])

    def movedim(self, src, dst):
        return T(np.moveaxis(self.a, src, dst))

    def unsqueeze(self, d):
        return T(np.expand_dims(self.a, d))

    def clone(self):
        return T(self.a.copy())

    def cpu(self):
        return self

    def contiguous(self):
        return T(np.ascontiguousarray(self.a))


class Nested:
    def __init__(self, parts):
        self.parts = parts

    def unbind(self):
        return list(self.parts)


def install_fakes():
    mm = make_mm()
    for name in ("comfy", "comfy.ldm", "comfy.ldm.minimax"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["comfy.ldm.minimax.model"] = mm
    sys.modules["comfy"].ldm = sys.modules["comfy.ldm"]
    sys.modules["comfy.ldm"].minimax = sys.modules["comfy.ldm.minimax"]
    sys.modules["torch"] = make_torch()

    cu = types.ModuleType("comfy.utils")
    cu.common_upscale = lambda s, w, h, m, c: T(
        np.zeros((s.shape[0], 3, h, w), dtype=np.float32))
    cu.PROGRESS_BAR_ENABLED = False
    sys.modules["comfy.utils"] = cu
    sys.modules["comfy"].utils = cu

    mb = types.ModuleType("comfy.model_base")

    class MiniMaxH3:
        def extra_conds(self, **kw):
            return {}
    mb.MiniMaxH3 = MiniMaxH3
    sys.modules["comfy.model_base"] = mb
    sys.modules["comfy"].model_base = mb

    cs = types.ModuleType("comfy.samplers")

    class CFGGuider:
        def __init__(self, model=None):
            self.cfg = 1.0
    cs.CFGGuider = CFGGuider
    sys.modules["comfy.samplers"] = cs
    sys.modules["comfy"].samplers = cs

    csample = types.ModuleType("comfy.sample")
    csample.fix_empty_latent_channels = lambda m, s, a, b: s
    csample.prepare_noise = lambda *a, **k: None
    sys.modules["comfy.sample"] = csample
    sys.modules["comfy"].sample = csample

    cmm = types.ModuleType("comfy.model_management")
    cmm.intermediate_device = lambda: "cpu"
    sys.modules["comfy.model_management"] = cmm
    sys.modules["comfy"].model_management = cmm

    captured = {}
    nh = types.ModuleType("node_helpers")

    def conditioning_set_values(cond, values):
        captured.update(values)
        return cond
    nh.conditioning_set_values = conditioning_set_values
    sys.modules["node_helpers"] = nh

    outdir = os.path.join(_TESTS, "_out")
    os.makedirs(outdir, exist_ok=True)
    fp = types.ModuleType("folder_paths")
    fp.get_output_directory = lambda: outdir
    fp.get_input_directory = lambda: outdir
    sys.modules["folder_paths"] = fp

    st = types.ModuleType("safetensors")
    stt = types.ModuleType("safetensors.torch")
    stt.load_file = stt.save_file = None
    st.torch = stt
    sys.modules["safetensors"] = st
    sys.modules["safetensors.torch"] = stt

    lp = types.ModuleType("latent_preview")
    lp.prepare_callback = lambda *a, **k: None
    sys.modules["latent_preview"] = lp

    capi = types.ModuleType("comfy_api")
    clatest = types.ModuleType("comfy_api.latest")

    class _InputImpl:
        class VideoFromComponents:
            def __init__(self, *a, **k):
                pass

            def save_to(self, *a, **k):
                pass

    class _Types:
        VideoComponents = dict
        VideoContainer = dict
    clatest.InputImpl = _InputImpl
    clatest.Types = _Types
    capi.latest = clatest
    sys.modules["comfy_api"] = capi
    sys.modules["comfy_api.latest"] = clatest

    srv = types.ModuleType("server")

    class _Routes:
        def post(self, path):
            return lambda fn: fn

    class _PS:
        instance = None
    _ps = _PS()
    _ps.routes = _Routes()
    _ps.send_sync = lambda *a, **k: None
    _PS.instance = _ps
    srv.PromptServer = _PS
    sys.modules["server"] = srv

    ce = types.ModuleType("comfy_extras")
    cmh = types.ModuleType("comfy_extras.nodes_minimax_h3")
    cmh._empty_av_latent = lambda w, h, n: ({"samples": None}, n)
    cmh._resize = lambda img, w, h, c: img
    cmh.CANVAS_MULTIPLE = 8
    ce.nodes_minimax_h3 = cmh
    sys.modules["comfy_extras"] = ce
    sys.modules["comfy_extras.nodes_minimax_h3"] = cmh

    tn = types.ModuleType("torch.nn")
    tnf = types.ModuleType("torch.nn.functional")
    tn.functional = tnf
    sys.modules["torch"].nn = tn
    sys.modules["torch.nn"] = tn
    sys.modules["torch.nn.functional"] = tnf

    return captured


def main():
    captured = install_fakes()

    # 按文件位置拉起整个包（补丁随之应用）
    spec = importlib.util.spec_from_file_location(
        "h3sd_pkg", os.path.join(_PKG, "__init__.py"),
        submodule_search_locations=[_PKG])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules["h3sd_pkg"] = pkg
    spec.loader.exec_module(pkg)
    core_mc = sys.modules["h3sd_pkg.core.motion_context"]
    pl = sys.modules["h3sd_pkg.storyline.payload"]
    nodes_mod = sys.modules["h3sd_pkg.storyline.nodes"]

    # 四个工作台节点注册
    import json
    for name in ("H3SceneDirectorList", "H3SceneDirectorConditioning",
                 "H3SceneDirectorChain", "H3SceneDirectorLatentTemplate"):
        assert name in pkg.NODE_CLASS_MAPPINGS, name
    assert pl.base_length(5.0) == 124    # 120 向上对齐 17 帧网格
    assert pl.base_length(6.0) == 158
    parsed = pl.parse_payload(json.dumps(nodes_mod._default_payload(),
                                         ensure_ascii=False))
    assert len(parsed[5]) == 3
    print("节点注册与网格/载荷助手正常")

    # 124 帧片段：latent_t 37（7 组 17 帧 + 1 + 4）
    latent_t, frames = 37, 124
    assert core_mc.frames_for_steps(latent_t) == frames
    h, w = 480 // 16, 864 // 16
    target = {"samples": Nested([
        T(np.zeros((1, 16, latent_t, h, w), dtype=np.float32)),
        T(np.zeros((1, 32, 2, 207), dtype=np.float32)),
    ])}
    context = T(np.zeros((124, 480, 864, 3), dtype=np.float32))

    class VAE:
        def encode(self, x):
            n = x.shape[0]
            steps = max(1, (n - 5) // 17 * 5 + 2)
            return T(np.zeros((1, 16, steps, h, w), dtype=np.float32))

    class AudioVAE:
        audio_sample_rate = 32000

        def encode(self, x):
            steps = int(round(x.shape[-2] / 32000 * 40))
            return T(np.zeros((1, 32, 2, steps), dtype=np.float32))

    audio = {"waveform": T(np.zeros((1, 2, 2 * 32000), dtype=np.float32)),
             "sample_rate": 32000}

    cond, trim = core_mc.apply_motion_context(
        [["c", {}]], VAE(), target, context, 22, "video", "head", "disabled",
        audio_context_length=22, audio_mode="timeline",
        audio_vae=AudioVAE(), context_audio=audio)

    kfs = captured["minimax_keyframes"]
    assert len(kfs) == 7, len(kfs)          # 22 帧 -> 7 个条件块
    idx = [kf[core_mc.MC_KEY] for kf in kfs]
    assert idx == [0, 1, 5, 9, 13, 17, 18], idx
    assert captured["minimax_frame_count"] == frames
    assert trim == 22
    ref = captured["minimax_refs"][0]
    assert ref["kind"] == "audio" and ref["ref_audio_t"] == 37  # round(22/24*40)
    assert abs(ref[core_mc.MC_AUDIO_KEY] - 22.0) < 1e-9
    print("钉帧：7 块落点 %s；音频 37 步钉在时间轴 22.0 帧处；trim 22" % idx)

    # 钉帧不影响已有图片参考块（合并而非覆盖）
    captured.clear()
    cond_with_ref = [["c", {"minimax_refs": [{"kind": "image", "latent_h": 4,
                                              "latent_w": 6, "latent": None}]}]]
    core_mc.apply_motion_context(
        cond_with_ref, VAE(), target, context, 22, "video", "head", "disabled",
        audio_context_length=22, audio_mode="timeline",
        audio_vae=AudioVAE(), context_audio=audio)
    kinds = [r["kind"] for r in captured["minimax_refs"]]
    assert kinds == ["image", "audio"], kinds
    print("图片参考块与音频参考块共存：", kinds)

    # trim_av：裁头 + 音画同步 + 尾部修齐
    imgs = T(np.zeros((124, 480, 864, 3), dtype=np.float32))
    # 124 帧整 = 165333 样本；网格盈余 +267 -> 输入 165600
    wav = {"waveform": T(np.zeros((1, 2, 165600), dtype=np.float32)),
           "sample_rate": 32000}
    oi, oa = core_mc.trim_av(imgs, wav, 22, fps=24.0, match_tail=True)
    assert oi.shape[0] == 102, oi.shape
    assert oa["waveform"].shape[-1] == 136000, oa["waveform"].shape
    print("trim_av：124->102 帧，音频修齐到 136000 样本（102 帧整）")

    # streams_from_av：NestedTensor 解包不丢 batch 维
    parts = core_mc.streams_from_av(target)
    assert len(parts) == 2 and parts[0].shape[0] == 1
    print("streams_from_av：NestedTensor 正确解包")

    print("冒烟测试全部通过")


if __name__ == "__main__":
    main()
