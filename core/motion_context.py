"""运动上下文（SceneDirector 自研实现）：把上一段尾部的一串帧连同声音
钉进下一段的条件，让画面和声音真正续接，而不是从一张静帧猜运动。

两条路径（对齐 Director 语义）：
  * latent 直通（首选）：上一段采样器输出的 AV latent 不做 decode->encode
    往返，直接按 5 步周期相位对齐从尾部切块钉入；音频从 latent 音频流
    尾切（钉位坐标含 overhang 零头）。运动/色彩状态零损耗续接。
  * 像素重编码（兜底/frames 模式）：上一段交付尾帧经视频 VAE 编成
    latent，作为一串"永不去噪"的关键帧条件块钉在新片段时间轴的开头
    （head 模式）或负坐标区（before 模式）；尾部声音经音频 VAE 编成
    latent，平移到本片时间轴上与钉帧窗口末尾对齐。

相位对齐：H3 视频 VAE 以 5 步为周期（17 帧）。钉块起点落在周期边界
时窗口像素末尾可能比交付末尾早几帧（gap）——这几帧已被钉块覆盖，
留在上一段交付尾部会在接缝回声一遍，调用方要按 prev_tail_trim 裁掉。

网格常识：H3 视频 VAE 的降采样公式 max(1,(n-5)//17*5+2) 只区分
1/5/22/39 这几种帧数（VIDEO_RUN_GRID）；介于其间的帧数会编出与较小
网格点相同的步数，但覆盖输入的前 `covered` 帧——所以请求先向下吸附
到网格再切片，保证钉住的内容与位置一致。布局坐标由 core.patch_layout
的补丁落到模型里。
"""

import logging

import torch
import comfy.utils
import node_helpers

from .patch_layout import MC_KEY, MC_AUDIO_KEY, is_applied as layout_ok
from .patch_payload import is_applied as payload_ok

_LOG = logging.getLogger("h3_scenedirector")

FPS = 24                    # H3 原生帧率；音频 latent 40Hz，故时间缩放 5/3
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
FRAME_RESCALE = 5.0 / 3.0
AUDIO_HZ = 40.0
VIDEO_RUN_GRID = (39, 22, 5, 1)   # 视频 VAE 实际可区分的钉帧长度


def frames_for_steps(latent_t):
    """latent_t 个视频步覆盖的像素帧数。"""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(latent_t))


def steps_for_frames(n):
    """n 个像素帧对应的整 latent 步数；凑不满整步（不在网格上）返回 None。"""
    k, covered = 0, 0
    while covered < n:
        covered += FRAME_PER_TOKEN[k % 5]
        k += 1
    return k if covered == n else None


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
        raise ValueError("h3_scenedirector: 预期是 MiniMax H3 的 AV latent"
                         "（video/audio 嵌套对），实际 %r" % type(samples))
    if not parts:
        raise ValueError("h3_scenedirector: AV latent 里没有任何流")
    return parts


def _video_of(latent):
    video = streams_from_av(latent)[0]
    if video.ndim == 4:      # 无 batch 维 [C,T,H,W]
        video = video.unsqueeze(0)
    if video.ndim != 5:
        raise ValueError("h3_scenedirector: 预期视频 latent [B,C,T,H,W]，"
                         "实际 %s" % (tuple(video.shape),))
    return video


def _resize(image, width, height, crop):
    """[B,H,W,C] -> [B,height,width,3]，与官方helper同一缩放路径。"""
    samples = image[..., :3].movedim(-1, 1)
    samples = comfy.utils.common_upscale(samples, width, height, "lanczos", crop)
    return samples.movedim(1, -1)


def _phase_aligned_tail_start(total_steps, n_steps, end_frame):
    """挑一个 5 步周期对齐的尾部起点，钉帧窗口的像素末尾不得超过 end_frame。

    返回 (起点步, 钉住窗口的像素末尾, 窗口之后多出的帧数 gap)。

    H3 视频 VAE 以 5 步为一个压缩周期（17 帧），钉块起点必须落在周期
    边界上，否则同样的像素内容会以错位的相位进入下一段，接缝处出重影。
    end_frame 为 None 时钉到 latent 绝对末尾；给定时（上一段经过交付
    裁剪）钉到交付末尾为止——多出的 gap 帧已被下一段的钉块覆盖，调用方
    要把它们从上一段交付尾部裁掉，否则下一段开头会把这几帧回声一遍。
    """
    if n_steps > total_steps:
        raise ValueError(
            "h3_scenedirector: 需要 %d 步 latent，上下文只有 %d 步。"
            % (n_steps, total_steps))
    if end_frame is None:
        start = total_steps - n_steps
        if start % 5 != 0:
            raise RuntimeError(
                "h3_scenedirector: 尾部起点的周期相位是 %d 不是 0，"
                "拒绝错位衔接。" % (start % 5))
        return start, frames_for_steps(total_steps), 0

    end_limit = int(end_frame)
    best_start, best_end = None, -1
    for start in range(0, total_steps - n_steps + 1, 5):
        # 起点固定步进 5：每个起点像素位置随 start 严格递增，最后一个
        # 满足窗口末尾 <= end_limit 的就是最优解
        end_px = frames_for_steps(start) + frames_for_steps(n_steps)
        if end_px <= end_limit and end_px > best_end:
            best_start, best_end = start, end_px
    if best_start is None:
        raise RuntimeError(
            "h3_scenedirector: 找不到结束于第 %d 帧之前的相位对齐钉帧窗口。"
            % end_limit)
    gap = max(0, end_limit - best_end)
    if gap > 0:
        _LOG.info("h3_scenedirector: 相位对齐，钉帧窗口结束于交付末尾前 %d 帧"
                  "（交付尾 %d，钉尾 %d）——上一段交付尾部要裁掉这部分",
                  gap, end_limit, best_end)
    return best_start, best_end, gap


def video_tail_blocks(context_latent, n, end_frame=None):
    """从上一段的 AV latent 尾部直接切出 n 帧钉块（相位对齐）。

    返回 (blocks, offsets, covered, pin_end_px, gap_after_pin)。
    与像素重编码路径相比不做 decode->encode 往返：钉进去的就是上一段
    采样器当时看到的数值，运动与色彩状态零损耗续接。
    """
    video = _video_of(context_latent)
    total = int(video.shape[2])
    steps = steps_for_frames(n)
    if steps is None:
        raise ValueError(
            "h3_scenedirector: %d 帧凑不出整 latent 步（可用网格 1/5/22/39）。"
            % n)
    start, pin_end_px, gap = _phase_aligned_tail_start(total, steps, end_frame)
    covered = frames_for_steps(steps)
    if covered != n:
        raise RuntimeError(
            "h3_scenedirector: %d 步覆盖 %d 帧，与请求的 %d 帧不符。"
            % (steps, covered, n))
    blocks = [video[:1, :, start + k:start + k + 1].clone()
              for k in range(steps)]
    return blocks, step_starts(steps), covered, pin_end_px, gap


def audio_tail_from_latent(context_latent, a_frames, end_frame=None):
    """从上一段 AV latent 的音频流尾部切出 a_frames 帧对应的声音。

    返回 (audio_latent, 步数, overhang)。音频流 40Hz（对画面 5/3 缩放），
    总长比视频帧数折算值多出不到 1 步的零头（overhang）——钉位坐标要
    算上它，声音才正好结束在钉帧窗口末尾。end_frame 给定（交付末尾）时
    音频尾对齐它，而不是采样网格的绝对末尾。
    """
    parts = streams_from_av(context_latent)
    if len(parts) < 2:
        raise ValueError("h3_scenedirector: 上下文 latent 里没有音频流。")
    video, audio = parts[0], parts[1]
    if video.ndim == 4:
        video = video.unsqueeze(0)
    if audio.ndim == 3:
        audio = audio.unsqueeze(0)
    if audio.ndim != 4:
        raise ValueError(
            "h3_scenedirector: 预期音频 latent [B,C,2,T]，实际 %s"
            % (tuple(audio.shape),))
    total_t = int(audio.shape[-1])
    frames = frames_for_steps(int(video.shape[2]))
    overhang = total_t - FRAME_RESCALE * frames
    if not (0.0 <= overhang < 1.0):
        _LOG.warning("h3_scenedirector: 音频网格异常（%d 步 / %d 帧），按无零头处理",
                     total_t, frames)
        overhang = 0.0
    rt = int(round(a_frames / float(FPS) * AUDIO_HZ))
    if rt > total_t:
        _LOG.warning("h3_scenedirector: 请求 %d 步音频，latent 只有 %d 步，全钉",
                     rt, total_t)
        rt = total_t
    if rt < 1:
        raise ValueError("h3_scenedirector: 音频窗口为空。")
    if end_frame is None:
        audio_end = total_t
    else:
        # 与视频钉帧窗口末尾（交付边界）对齐，而不是采样盈余的绝对末尾
        audio_end = int(round(float(end_frame) / float(FPS) * AUDIO_HZ))
        audio_end = max(rt, min(total_t, audio_end))
    audio_start = max(0, audio_end - rt)
    rt = audio_end - audio_start
    return audio[:1, ..., audio_start:audio_end].clone(), rt, float(overhang)


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
                "h3_scenedirector: 上下文音频是 %d Hz，VAE 要 %d Hz，"
                "且没有 torchaudio 可重采样。" % (sr, vae_sr))
        waveform = torchaudio.functional.resample(waveform, sr, vae_sr)
    want = int(round(seconds * vae_sr))
    have = int(waveform.shape[-1])
    if have < want:
        _LOG.warning("h3_scenedirector: 上下文音频只有 %.3fs，不足钉帧窗口的 "
                     "%.3fs，有多少钉多少。", have / vae_sr, seconds)
    else:
        waveform = waveform[..., have - want:]
    z = audio_vae.encode(waveform[:1].movedim(1, -1))   # [1, 32, 2, T]
    return z, int(z.shape[-1])


def apply_motion_context(conditioning, vae, latent, context_frames, context_length,
                         encode_mode, anchor_mode, crop,
                         audio_context_length=22, audio_mode="timeline",
                         audio_vae=None, context_audio=None,
                         context_latent=None, context_end_frame=None):
    """把上一段的尾部钉进本段条件。返回 (conditioning, trim_frames, prev_tail_trim)。

    head   模式：钉住帧占交付时间轴的 0..N-1，会出现在输出里，用毕剪掉
                  trim=N 帧；
    before 模式：钉住帧落在负坐标区（结束于 -1），交付第 0 帧直接续接，
                  没有浪费，但其坐标与文本行区间重叠（该模式即验证此事）。

    context_latent（上一段采样器的 AV latent 输出）给定时走 latent 直通：
    视频钉块直接从 latent 尾部按相位对齐切块，音频从 latent 音频流尾切，
    不做 decode->encode 往返，运动/色彩状态零损耗。此时 context_end_frame
    是上一段交付末尾在其采样时间轴上的坐标（trim + 交付帧数），钉帧窗口
    只钉到它为止；相位对齐可能让窗口提前几帧结束，这 prev_tail_trim 帧
    要由调用方从上一段交付尾部裁掉，否则接缝处会把它们回声一遍。
    latent 直通出现任何不一致（分辨率变了、旧缓存网格不符）会警告并回退
    像素重编码路径，context_frames 就是这条退路，必须照常传入。
    """
    if not layout_ok():
        raise RuntimeError(
            "h3_scenedirector: 布局补丁未生效，内部锚点会被 ComfyUI 拒绝。"
            "看启动日志里自检失败的原因。")

    video = _video_of(latent)
    latent_t = int(video.shape[2])
    width = int(video.shape[4]) * 16
    height = int(video.shape[3]) * 16
    frame_count = frames_for_steps(latent_t)

    # 上下文可用帧数：latent 直通看采样时间轴（ capped 到交付末尾），
    # 像素路径看交付帧本身
    if context_latent is not None and encode_mode == "video":
        available = frames_for_steps(int(_video_of(context_latent).shape[2]))
        if context_end_frame is not None:
            available = min(available, max(0, int(context_end_frame)))
    elif context_frames is not None:
        available = int(context_frames.shape[0])
    else:
        raise ValueError("h3_scenedirector: 既没有上一段 latent 也没有交付帧")

    n = min(int(context_length), available)
    if n < 1:
        raise ValueError("h3_scenedirector: 上下文帧为空")
    if n < context_length:
        _LOG.warning("h3_scenedirector: 只拿到 %d 帧，钉 %d 帧", available, n)

    if encode_mode == "video":
        # 先吸附网格再切片：否则 VAE 覆盖的是输入前段，钉住的尾部会提前
        # 结束，接缝错位
        run = next(g for g in VIDEO_RUN_GRID if g <= n)
        if run != n:
            _LOG.warning("h3_scenedirector: %d 帧不在 VAE 网格上，改钉最后 "
                         "%d 帧（可用网格 1/5/22/39）", n, run)
        n = run

    if n >= frame_count:
        raise ValueError(
            "h3_scenedirector: 往 %d 帧的片段里钉 %d 帧——钉帧只能是时间轴的"
            "一小段。" % (n, frame_count))

    # ---- 视频钉块：latent 直通优先，像素重编码兜底 -----------------------
    prev_tail_trim = 0
    pin_end_px = None
    video_src = "pixels"
    if encode_mode == "video" and context_latent is not None:
        try:
            src = _video_of(context_latent)
            sw, sh = int(src.shape[4]) * 16, int(src.shape[3]) * 16
            if (sw, sh) != (width, height):
                raise ValueError("上下文 latent 是 %dx%d，本段是 %dx%d"
                                 % (sw, sh, width, height))
            blocks, offsets, span, pin_end_px, prev_tail_trim = \
                video_tail_blocks(context_latent, n, end_frame=context_end_frame)
            video_src = "latent"
        except Exception as e:
            _LOG.warning("h3_scenedirector: latent 直通失败（%s），"
                         "回退像素重编码。", e)

    if video_src == "pixels":
        # 回退路径：可用帧数以交付帧为准重新吸附
        available = int(context_frames.shape[0])
        n = min(int(context_length), available)
        if n < 1:
            raise ValueError("h3_scenedirector: 上下文帧为空")
        if encode_mode == "video":
            n = next(g for g in VIDEO_RUN_GRID if g <= n)
        # 取上一段的最后 n 帧作为钉帧串
        tail = _resize(context_frames[available - n:], width, height, crop)
        if encode_mode == "video":
            # 一次调用：VAE 把 batch 维读作时间并压缩，帧间运动留在 latent 内
            enc = vae.encode(tail)
            if getattr(enc, "ndim", 0) != 5:
                raise ValueError(
                    "h3_scenedirector: video 模式编码返回 %s，预期 [B,C,T,H,W]。"
                    "可改用 encode_mode=frames。" % (tuple(getattr(enc, "shape", ())),))
            steps = int(enc.shape[2])
            offsets = step_starts(steps)
            covered = frames_for_steps(steps)
            if covered != n:
                # n 已吸附网格，不一致说明上游 VAE 改了降采样公式——
                # 钉内容与位置对不上，宁可拒绝也不渲染错位接缝
                raise RuntimeError(
                    "h3_scenedirector: %d 帧编出 %d 步覆盖 %d 帧；VAE 网格与"
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
    ref = None
    if context_audio is not None or video_src == "latent":
        if not payload_ok():
            raise RuntimeError(
                "h3_scenedirector: 载荷补丁未生效，音频参考会覆盖钉帧的"
                " latent。看启动日志。")
        a_frames = int(audio_context_length) or span
        overhang = 0.0
        audio_latent = None
        if video_src == "latent":
            try:
                # 音频尾对齐视频钉帧窗口末尾（交付边界），而不是采样网格末尾
                audio_latent, ref_audio_t, overhang = audio_tail_from_latent(
                    context_latent, a_frames, end_frame=pin_end_px)
            except Exception as e:
                if context_audio is None:
                    raise
                _LOG.warning("h3_scenedirector: 从 latent 切音频失败（%s），"
                             "回退波形重编码。", e)
        if audio_latent is None and context_audio is not None:
            if audio_vae is None:
                raise ValueError("h3_scenedirector: 带了上下文音频但没接音频 VAE。")
            audio_latent, ref_audio_t = _encode_tail_audio(
                audio_vae, context_audio, a_frames / float(FPS))
        if audio_latent is not None:
            ref = {"kind": "audio", "ref_audio_t": ref_audio_t,
                   "audio_latent": audio_latent}
            if audio_mode == "timeline":
                # 与钉帧视频尾端对齐：两者都是上一段的尾巴，必须结束于同一
                # 时刻——head 模式是第 span 帧，before 模式是第 0 帧。
                # 钉位坐标对齐 40Hz 网格，overhang 是音频 latent 比视频折算
                # 长度多出的零头（<1 步），算上它声音才正好结束在窗口末尾
                base = float(span) if anchor_mode == "head" else 0.0
                end_f = base + float(overhang) / FRAME_RESCALE
                ref[MC_AUDIO_KEY] = round(FRAME_RESCALE * end_f) / FRAME_RESCALE
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
    _LOG.info("h3_scenedirector: %s/%s（%s），%d 帧 -> %d 个条件块，位置 %d..%d，"
              "%d 帧片段 %dx%d，trim %d，裁上段尾 %d 帧，音频 %s",
              encode_mode, anchor_mode, video_src, n, len(keyframes),
              indices[0], indices[-1], frame_count, width, height, trim,
              prev_tail_trim,
              ("%d 帧 -> %d 步（%.3fs）钉在时间轴 %.2f 帧处"
               % (int(audio_context_length) or span, ref_audio_t,
                  ref_audio_t / AUDIO_HZ, ref[MC_AUDIO_KEY])
               if ref_audio_t and audio_mode == "timeline" and ref is not None
               else ("%d 帧 -> %d 步，官方参考位" % (int(audio_context_length) or span, ref_audio_t))
               if ref_audio_t else "关"))
    return out, trim, prev_tail_trim


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
        raise ValueError("h3_scenedirector: 从 %d 帧的片段裁 %d 帧没东西剩。"
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
                "h3_scenedirector: 从 %.3fs 音频裁 %.3fs 就没声了。检查 fps 是否"
                "与片段一致。" % (length / sr, n / float(fps)))
        waveform = waveform[..., cut:]
        if match_tail:
            frames_left = total - n
            want = int(round(frames_left / float(fps) * sr))
            have = int(waveform.shape[-1])
            if have > want:
                waveform = waveform[..., :want]
            elif have < want:
                _LOG.warning("h3_scenedirector: 音频比 %d 帧短 %.2fms，尾部保持原样",
                             frames_left, (want - have) / sr * 1000.0)
        out_audio = {"waveform": waveform, "sample_rate": sr}
        _LOG.info("h3_scenedirector: %d 帧 / %.4fs 画面，%.4fs 声音，漂移 %.2fms",
                  total - n, (total - n) / float(fps),
                  int(waveform.shape[-1]) / sr,
                  abs((total - n) / float(fps) - int(waveform.shape[-1]) / sr) * 1000.0)
    elif n:
        _LOG.info("h3_scenedirector: 裁掉头部 %d 帧，剩 %d 帧（未接音频）",
                  n, total - n)
    return out_images, out_audio
