"""运动上下文（StoryDirector 自研实现）：把上一段尾部的一串帧连同声音
钉进下一段的条件，让画面和声音真正续接，而不是从一张静帧猜运动。

原理：上一段尾部 n 帧经视频 VAE 编成 latent，作为一串"永不去噪"的
关键帧条件块钉在新片段时间轴的开头（head 模式）或负坐标区（before
模式）；尾部声音经音频 VAE 编成 latent，平移到本片时间轴上与钉帧
窗口末尾对齐。布局坐标由 core.patch_layout 的补丁落到模型里。

网格常识：H3 视频 VAE 的降采样公式 max(1,(n-5)//17*5+2) 只区分
1/5/22/39 这几种帧数（VIDEO_RUN_GRID）；介于其间的帧数会编出与较小
网格点相同的步数，但覆盖输入的前 `covered` 帧——所以请求先向下吸附
到网格再切片，保证钉住的内容与位置一致。
"""

import logging

import torch
import comfy.utils
import node_helpers

from .patch_layout import MC_KEY, MC_AUDIO_KEY, is_applied as layout_ok
from .patch_payload import is_applied as payload_ok

_LOG = logging.getLogger("h3_storydirector")

FPS = 24                    # H3 原生帧率；音频 latent 40Hz，故时间缩放 5/3
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
FRAME_RESCALE = 5.0 / 3.0
AUDIO_HZ = 40.0
VIDEO_RUN_GRID = (39, 22, 5, 1)   # 视频 VAE 实际可区分的钉帧长度


def frames_for_steps(latent_t):
    """latent_t 个视频步覆盖的像素帧数。"""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(latent_t))


def step_starts(latent_t):
    """每个 latent 步起始的像素帧索引。"""
    out, acc = [], 0
    for k in range(latent_t):
        out.append(acc)
        acc += FRAME_PER_TOKEN[k % 5]
    return out


def streams_from_av(latent):
    """把 H3 AV latent 拆成 [video, audio] 两路。

    NestedTensor 的 __getitem__ 会把索引广播进每一路（samples[0] 会削掉
    两路的 batch 维），所以要用 unbind()；磁盘读回的普通 list 直接返回。
    """
    samples = latent["samples"]
    if hasattr(samples, "unbind"):
        parts = list(samples.unbind())
    elif isinstance(samples, (tuple, list)):
        parts = list(samples)
    else:
        raise ValueError("h3_storydirector: 预期是 MiniMax H3 的 AV latent"
                         "（video/audio 嵌套对），实际 %r" % type(samples))
    if not parts:
        raise ValueError("h3_storydirector: AV latent 里没有任何流")
    return parts


def _video_of(latent):
    video = streams_from_av(latent)[0]
    if video.ndim == 4:      # 无 batch 维 [C,T,H,W]
        video = video.unsqueeze(0)
    if video.ndim != 5:
        raise ValueError("h3_storydirector: 预期视频 latent [B,C,T,H,W]，"
                         "实际 %s" % (tuple(video.shape),))
    return video


def _resize(image, width, height, crop):
    """[B,H,W,C] -> [B,height,width,3]，与官方helper同一缩放路径。"""
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


def _encode_tail_audio(audio_vae, audio, seconds):
    """把一段音频的最后 seconds 秒编成 H3 音频 latent，返回 (latent, 步数T)。"""
    waveform = audio["waveform"]           # [B, C, L]
    sr = int(audio["sample_rate"])
    vae_sr = int(getattr(audio_vae, "audio_sample_rate", 32000))
    if sr != vae_sr:
        try:
            import torchaudio
        except ImportError:
            raise RuntimeError(
                "h3_storydirector: 上下文音频是 %d Hz，VAE 要 %d Hz，"
                "且没有 torchaudio 可重采样。" % (sr, vae_sr))
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    want = int(round(seconds * vae_sr))
    have = int(waveform.shape[-1])
    if have < want:
        _LOG.warning("h3_storydirector: 上下文音频只有 %.3fs，不足钉帧窗口的 "
                     "%.3fs，有多少钉多少。", have / vae_sr, seconds)
    else:
        waveform = waveform[..., have - want:]
    z = audio_vae.encode(waveform[:1].movedim(1, -1))   # [1, 32, 2, T]
    return z, int(z.shape[-1])


def apply_motion_context(conditioning, vae, latent, context_frames, context_length,
                         encode_mode, anchor_mode, crop,
                         audio_context_length=22, audio_mode="timeline",
                         audio_vae=None, context_audio=None):
    """把上一段的尾部钉进本段条件。返回 (conditioning, trim_frames)。

    head   模式：钉住帧占交付时间轴的 0..N-1，会出现在输出里，用毕剪掉
                  trim=N 帧；
    before 模式：钉住帧落在负坐标区（结束于 -1），交付第 0 帧直接续接，
                  没有浪费，但其坐标与文本行区间重叠（该模式即验证此事）。
    """
    if not layout_ok():
        raise RuntimeError(
            "h3_storydirector: 布局补丁未生效，内部锚点会被 ComfyUI 拒绝。"
            "看启动日志里自检失败的原因。")

    video = _video_of(latent)
    latent_t = int(video.shape[2])
    width = int(video.shape[4]) * 16
    height = int(video.shape[3]) * 16
    frame_count = frames_for_steps(latent_t)

    available = int(context_frames.shape[0])
    n = min(int(context_length), available)
    if n < 1:
        raise ValueError("h3_storydirector: 上下文帧为空")
    if n < context_length:
        _LOG.warning("h3_storydirector: 只拿到 %d 帧，钉 %d 帧", available, n)

    if encode_mode == "video":
        # 先吸附网格再切片：否则 VAE 覆盖的是输入前段，钉住的尾部会提前
        # 结束，接缝错位
        run = next(g for g in VIDEO_RUN_GRID if g <= n)
        if run != n:
            _LOG.warning("h3_storydirector: %d 帧不在 VAE 网格上，改钉最后 "
                         "%d 帧（可用网格 1/5/22/39）", n, run)
        n = run

    if n >= frame_count:
        raise ValueError(
            "h3_storydirector: 往 %d 帧的片段里钉 %d 帧——钉帧只能是时间轴的"
            "一小段。" % (n, frame_count))

    # 取上一段的最后 n 帧作为钉帧串
    tail = _resize(context_frames[available - n:], width, height, crop)

    if encode_mode == "video":
        # 一次调用：VAE 把 batch 维读作时间并压缩，帧间运动留在 latent 内
        enc = vae.encode(tail)
        if getattr(enc, "ndim", 0) != 5:
            raise ValueError(
                "h3_storydirector: video 模式编码返回 %s，预期 [B,C,T,H,W]。"
                "可改用 encode_mode=frames。" % (tuple(getattr(enc, "shape", ())),))
        steps = int(enc.shape[2])
        offsets = step_starts(steps)
        covered = frames_for_steps(steps)
        if covered != n:
            # n 已吸附网格，不一致说明上游 VAE 改了降采样公式——
            # 钉内容与位置对不上，宁可拒绝也不渲染错位接缝
            raise RuntimeError(
                "h3_storydirector: %d 帧编出 %d 步覆盖 %d 帧；VAE 网格与"
                " VIDEO_RUN_GRID 不再匹配，拒绝运行。" % (n, steps, covered))
        blocks = [enc[:, :, k:k + 1] for k in range(steps)]
        span = covered
    else:
        blocks, offsets = [], []
        for i in range(n):
            blocks.append(vae.encode(tail[i:i + 1]))
            offsets.append(i)
        span = n

    indices = [o - span for o in offsets] if anchor_mode == "before" else list(offsets)

    keyframes = []
    for p, blk in zip(indices, blocks):
        keyframes.append({
            # 官方只接受 0 或末帧；真实位置经 MC_KEY 随行，由布局补丁落位
            "resolved_frame_index": 0,
            MC_KEY: p,
            "latent": blk,
        })

    values = {"minimax_keyframes": keyframes,
              "minimax_frame_count": frame_count}

    # ---- 音频：把上一段的尾音钉到本片时间轴 ------------------------------
    ref_audio_t = 0
    if context_audio is not None:
        if not payload_ok():
            raise RuntimeError(
                "h3_storydirector: 载荷补丁未生效，音频参考会覆盖钉帧的"
                " latent。看启动日志。")
        if audio_vae is None:
            raise ValueError("h3_storydirector: 带了上下文音频但没接音频 VAE。")
        a_frames = int(audio_context_length) or span
        audio_latent, ref_audio_t = _encode_tail_audio(
            audio_vae, context_audio, a_frames / float(FPS))
        ref = {"kind": "audio", "ref_audio_t": ref_audio_t,
               "audio_latent": audio_latent}
        if audio_mode == "timeline":
            # 与钉帧视频尾端对齐：两者都是上一段的尾巴，必须结束于同一时刻
            # ——head 模式是第 span 帧，before 模式是第 0 帧
            ref[MC_AUDIO_KEY] = float(span if anchor_mode == "head" else 0)
        # conditioning_set_values 对列表是整体替换：与条件里已有的参考块
        # （资产卡图片）合并，不能覆盖
        existing = []
        for t in conditioning:
            prior = t[1].get("minimax_refs")
            if prior:
                existing = list(prior)
                break
        values["minimax_refs"] = existing + [ref]

    out = node_helpers.conditioning_set_values(conditioning, values)

    trim = span if anchor_mode == "head" else 0
    _LOG.info("h3_storydirector: %s/%s，%d 帧 -> %d 个条件块，位置 %d..%d，"
              "%d 帧片段 %dx%d，trim %d，音频 %s",
              encode_mode, anchor_mode, n, len(keyframes),
              indices[0], indices[-1], frame_count, width, height, trim,
              ("%d 帧 -> %d 步（%.3fs）钉在时间轴 %.1f 帧处"
               % (int(audio_context_length) or span, ref_audio_t,
                  ref_audio_t / AUDIO_HZ, ref[MC_AUDIO_KEY])
               if ref_audio_t and audio_mode == "timeline"
               else ("%d 帧 -> %d 步，官方参考位" % (int(audio_context_length) or span, ref_audio_t))
               if ref_audio_t else "关"))
    return out, trim


def trim_av(images, audio, trim_frames, fps=24.0, match_tail=True):
    """把钉帧头从解码后的片段里裁掉，画面和声音裁同样的时长。

    只裁画面不裁声音，声音会比画面提前 trim/24 秒——接缝处节拍全错。
    尾部也要修：H3 音频 latent 40Hz 对 24fps 画面（5/3 缩放），片段音频
    网格向上取整后多带约 8ms 声音；逐段累积会让接缝处出现可闻的咔哒，
    所以把尾部长度修到 帧数/fps 整。
    """
    n = max(0, int(trim_frames))
    total = int(images.shape[0])
    if n >= total:
        raise ValueError("h3_storydirector: 从 %d 帧的片段裁 %d 帧没东西剩。"
                         % (total, n))
    out_images = images[n:] if n else images

    out_audio = audio
    if audio is not None:
        waveform = audio["waveform"]
        sr = int(audio["sample_rate"])
        cut = int(round(n / float(fps) * sr))
        length = int(waveform.shape[-1])
        if cut >= length:
            raise ValueError(
                "h3_storydirector: 从 %.3fs 音频裁 %.3fs 就没声了。检查 fps 是否"
                "与片段一致。" % (length / sr, n / float(fps)))
        waveform = waveform[..., cut:]
        if match_tail:
            frames_left = total - n
            want = int(round(frames_left / float(fps) * sr))
            have = int(waveform.shape[-1])
            if have > want:
                waveform = waveform[..., :want]
            elif have < want:
                _LOG.warning("h3_storydirector: 音频比 %d 帧短 %.2fms，尾部保持原样",
                             frames_left, (want - have) / sr * 1000.0)
        out_audio = {"waveform": waveform, "sample_rate": sr}
        _LOG.info("h3_storydirector: %d 帧 / %.4fs 画面，%.4fs 声音，漂移 %.2fms",
                  total - n, (total - n) / float(fps),
                  int(waveform.shape[-1]) / sr,
                  abs((total - n) / float(fps) - int(waveform.shape[-1]) / sr) * 1000.0)
    elif n:
        _LOG.info("h3_storydirector: 裁掉头部 %d 帧，剩 %d 帧（未接音频）",
                  n, total - n)
    return out_images, out_audio
