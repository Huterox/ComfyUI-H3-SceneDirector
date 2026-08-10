"""StoryDirector 循环引擎：增量重渲 + 运动上下文链接。

这里只做一件事——循环。每段的文本条件由上游节点在编码头备好，
采样配置（sampler/sigmas/model 补丁/negative）全部来自接线；
静态图表达不了的部分才留在这里：每段的运动上下文来自上一段的
采样器输出这一顺序依赖，以及磁盘增量缓存。
"""

import logging
import os
import random
from fractions import Fraction

import torch

import comfy.samplers
import comfy.sample
import comfy.utils
import comfy.model_management
import latent_preview
from comfy_api.latest import InputImpl, Types
from server import PromptServer

from comfy_extras.nodes_minimax_h3 import _empty_av_latent

from ..core.motion_context import (apply_motion_context, trim_av,
                                   streams_from_av, VIDEO_RUN_GRID)
from . import payload as P
from . import cache as C
from .conditioning import build_cond, load_ref_image, encode_refs, MAX_REFS

_LOG = logging.getLogger("h3_storydirector")

PROGRESS_EVENT = "h3_storydirector_progress"


class _BasicGuider(comfy.samplers.CFGGuider):
    """只带正条件的 guider，与工作流里 BasicGuider 的行为一致（无 negative）。"""

    def set_conds(self, positive):
        self.inner_set_conds({"positive": positive})


def decode_av(vae, audio_vae, samples):
    """把 H3 AV latent 解码成 (images, AUDIO dict)。

    同时兼容采样器的鲜输出（NestedTensor）和缓存路径（safetensors 读出的
    普通 [video, audio] 对），保证缓存段和新渲染段解码行为一致。音频分支
    对齐 comfy_extras.nodes_audio.vae_decode_audio（含其归一化）。
    """
    parts = streams_from_av({"samples": samples})
    video, audio_lat = parts[0], parts[1]
    if video.ndim == 4:  # 无 batch 维的 [C,T,H,W]
        video = video.unsqueeze(0)
    images = vae.decode(video)
    if len(images.shape) == 5:  # 合并 batch
        images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
    audio = audio_vae.decode(audio_lat).movedim(-1, 1)
    std = torch.std(audio, dim=[1, 2], keepdim=True) * 5.0
    std[std < 1.0] = 1.0
    audio = audio / std
    sr = getattr(audio_vae, "audio_sample_rate_output",
                 getattr(audio_vae, "audio_sample_rate", 44100))
    return images, {"waveform": audio, "sample_rate": sr}


def _concat_audio(a, b):
    if a is None:
        return b
    return {"waveform": torch.cat([a["waveform"], b["waveform"]], dim=-1),
            "sample_rate": a["sample_rate"]}


def encode_story(clip, vae, segments_raw, width, height, first_frame=None):
    """编码头：把载荷里每一段的完整提示词（场景设定表 + 资产清单 +
    段提示词 + 段级资产图钉）用接进来的 CLIP 编码，参考图用接进来的
    视频 VAE 编码，输出逐段 CONDITIONING 列表。链条节点只管消费。"""
    run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments_raw)
    if not segs:
        raise ValueError("H3StoryDirector: 载荷里没有任何段")
    global_block = P.compose_global(global_prompt, globals_rows, assets)
    n_global_pics = sum(1 for a in assets if a["image"])

    g_images = [load_ref_image(a["image"], a["subfolder"])
                for a in assets if a["image"]]
    global_refs = encode_refs(vae, width, height, g_images)
    seg_img_cache = {}

    conds = []
    for i, seg in enumerate(segs):
        seg_assets = seg.get("assets") or []
        seg_extra = P.compose_seg_extra(seg_assets, n_global_pics)
        full_prompt = P.compose_prompt(global_block, seg["prompt"], seg_extra)

        if seg_assets:
            s_images = []
            for a in seg_assets:
                if not a["image"]:
                    continue
                key = (a["image"], a["subfolder"])
                if key not in seg_img_cache:
                    seg_img_cache[key] = load_ref_image(*key)
                s_images.append(seg_img_cache[key])
            s_items, s_blocks = encode_refs(vae, width, height, s_images)
            ref_items = global_refs[0] + s_items
            ref_blocks = global_refs[1] + s_blocks
        else:
            ref_items, ref_blocks = global_refs
        if len(ref_blocks) > MAX_REFS:
            _LOG.warning("run %r 段 %d: %d 个参考块（>%d）可能挤占条件行",
                         run, i + 1, len(ref_blocks), MAX_REFS)
        _LOG.info("run %r 段 %d: %d 个参考块; 提示词: %.100s",
                  run, i + 1, len(ref_blocks), full_prompt.replace("\n", " "))

        # 段 1 的渲染长度就是 base_length（没有钉帧跨度补偿），它的关键帧
        # frame_count 与链条建的 latent 一致。后续段不带关键帧，条件与长度
        # 无关，latent 尺寸由链条在运行时决定（那时才知道真实钉帧跨度）。
        cond, _latent = build_cond(
            clip, vae, full_prompt, width, height, P.base_length(seg["duration"]),
            first_frame=first_frame if i == 0 else None,
            ref_items=ref_items, ref_blocks=ref_blocks)
        conds.append(cond)
    return {"width": int(width), "height": int(height), "conds": conds}


def _sample(model, positive, latent, seed, sampler, sigmas, negative=None, cfg=1.0):
    latent2 = latent.copy()
    latent_image = comfy.sample.fix_empty_latent_channels(model, latent2["samples"], None, None)
    latent2["samples"] = latent_image

    if negative is None:
        guider = _BasicGuider(model)
        guider.set_conds(positive)
    else:
        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(positive, negative)
        guider.set_cfg(float(cfg))

    noise = comfy.sample.prepare_noise(latent_image, seed)
    callback = latent_preview.prepare_callback(model, sigmas.shape[-1] - 1)
    samples = guider.sample(noise, latent_image, sampler, sigmas,
                            denoise_mask=None, callback=callback,
                            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
                            seed=seed)
    samples = samples.to(comfy.model_management.intermediate_device())

    out = latent2.copy()
    out["samples"] = samples
    return out


def run_chain(model, vae, audio_vae, segments_raw, story_cond, sampler, sigmas,
              width, height, seed, context_length, audio_context_length,
              encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
              uniform_window=False, negative=None):
    """链条主循环：缓存命中段直接解码，自第一个变动段起级联重渲。
    返回 (images, audio, contact_sheet, info)。"""
    run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments_raw)
    if not segs:
        raise ValueError("H3StoryDirector: 请至少加一段带提示词的分镜")

    conds = list((story_cond or {}).get("conds") or [])
    if len(conds) != len(segs):
        raise ValueError(
            "H3StoryDirector: story_cond 带了 %d 个段条件，但载荷有 %d 段。"
            "两个输入请接同一个 StoryList。" % (len(conds), len(segs)))
    if (int(story_cond.get("width", width)), int(story_cond.get("height", height))) \
            != (int(width), int(height)):
        raise ValueError(
            "H3StoryDirector: 画布不一致——story_cond 按 %dx%d 编码，链条设的是 "
            "%dx%d。两处宽高请接同一个 ResolutionSelector。"
            % (story_cond.get("width"), story_cond.get("height"), width, height))

    rd = C.run_dir(run)
    os.makedirs(rd, exist_ok=True)
    meta = C.load_meta(rd)
    g_hash = P.global_hash(run_nonce, width, height, context_length,
                           audio_context_length, encode_mode, anchor_mode,
                           audio_mode, crop, global_prompt, globals_rows, assets,
                           P.sampling_fp(sampler, sigmas, negative, cfg),
                           cache_tag=str(cache_tag or "").strip(), seed=seed)
    hashes = [P.seg_hash(i, s) for i, s in enumerate(segs)]
    global_block = P.compose_global(global_prompt, globals_rows, assets)

    # 第一个必须重渲的段；它之后的全部级联
    first_dirty = 0
    cached_meta = []
    if meta.get("global_hash") == g_hash:
        cached_meta = meta.get("segments") or []
        first_dirty = len(segs)
        for i, h in enumerate(hashes):
            m = cached_meta[i] if i < len(cached_meta) else None
            if (not m or m.get("hash") != h or m.get("trim") is None
                    or not os.path.isfile(C.latent_path(rd, i))):
                first_dirty = i
                break

    if seed is not None and seed >= 0:
        base_seed = seed
    elif meta.get("base_seed") is not None:
        base_seed = int(meta["base_seed"])
    else:
        base_seed = random.randrange(0, 0xffffffffffffffff)

    n_render = len(segs) - first_dirty
    _LOG.info("run %r: %d 段, %d 缓存, %d 待渲, base_seed %d, "
              "%d 行设定, %d 个场景资产, cfg %.2f, %s",
              run, len(segs), first_dirty, n_render, base_seed,
              len(globals_rows), len(assets), float(cfg),
              "引导采样" if negative is not None else "仅正条件")

    # 运动上下文与裁剪都是 core.motion_context 里的函数式接口
    all_images, all_audio = [], None
    seg_meta, info_lines = [], []
    prev_images = prev_aud = None

    def delivered_view(imgs, aud, trim, duration):
        """完整渲染 -> 实际交付视图：先去钉帧头（音画同步 trim + 修尾部
        网格盈余），再裁到精确时长。连续性锚点必须锚在这个视图上：
        渲染窗口被 VAE 网格向上取整的盈余尾巴（最多 16 帧）若留在连续
        链里，交付时间线每段就会跳那么长一截。"""
        if trim:
            out_i, out_a = trim_av(imgs, aud, trim,
                                   fps=float(P.FPS), match_tail=True)
        else:
            out_i, out_a = imgs, aud
        target = max(5, round(float(duration) * P.FPS))
        if int(out_i.shape[0]) > target:
            out_i = out_i[:target]
            sr = int(out_a["sample_rate"])
            want_samples = int(round(target / float(P.FPS) * sr))
            wav = out_a["waveform"]
            if int(wav.shape[-1]) > want_samples:
                out_a = {"waveform": wav[..., :want_samples], "sample_rate": sr}
        return out_i, out_a

    if first_dirty > 0:
        # 级联点之前的最后一段提供运动上下文（用它的交付视图）
        pl = C.load_segment_latent(rd, first_dirty - 1)
        pi, pa = decode_av(vae, audio_vae, pl["samples"])
        prev_images, prev_aud = delivered_view(
            pi, pa, int(cached_meta[first_dirty - 1].get("trim", 0)),
            segs[first_dirty - 1]["duration"])

    for i, seg in enumerate(segs):
        cached_hit = i < first_dirty
        if cached_hit:
            latent = C.load_segment_latent(rd, i)
            imgs, aud = decode_av(vae, audio_vae, latent["samples"])
            trim = int(cached_meta[i].get("trim", 0))
        else:
            positive = conds[i]
            if positive is None:
                raise ValueError(
                    "H3StoryDirector: 段 %d 的条件为空，请重跑编码头。" % (i + 1))
            want = max(5, round(seg["duration"] * P.FPS))
            if i > 0:
                # head 模式钉帧会把上一段尾部的 span 帧复制进本段输出，
                # trim 再把它裁掉，所以裸 dur*FPS 的窗口会少交付 span 帧。
                # 窗口按钉帧跨度加大（与编码器同一个 VIDEO_RUN_GRID 吸附）。
                avail = int(prev_images.shape[0]) if prev_images is not None else 0
                n_pin = min(int(context_length), avail)
                span = next((g for g in VIDEO_RUN_GRID if g <= n_pin), 1)
                want += span
            elif uniform_window:
                # 段 1 也补齐到统一的渲染窗口，保证每次采样的打包 latent
                # 尺寸一致（MultiRate T8 这类采样器会逐次校验）
                span = next((g for g in VIDEO_RUN_GRID
                             if g <= int(context_length)), 1)
                want += span
            length = P.align_frame_count(want)
            latent_in, _fc = _empty_av_latent(width, height, length)
            if i > 0:
                # 钉上一段"实际交付"的尾帧（像素）+ 交付波形（音频 VAE
                # 路径，落点精确到交付边界），而不是完整渲染的尾巴——
                # 网格对齐的盈余尾巴不参与连续性
                positive, trim = apply_motion_context(
                    positive, vae, latent_in, prev_images,
                    context_length, encode_mode, anchor_mode,
                    crop, audio_context_length, audio_mode,
                    audio_vae=audio_vae, context_audio=prev_aud)
            else:
                trim = 0
            PromptServer.instance.send_sync(PROGRESS_EVENT, {
                "run": run, "segment": i + 1, "total": len(segs),
                "cached": first_dirty})
            seg_seed = (base_seed + i) & 0xffffffffffffffff
            latent = _sample(model, positive, latent_in, seg_seed,
                             sampler, sigmas, negative, cfg)
            imgs, aud = decode_av(vae, audio_vae, latent["samples"])

        out_imgs, out_aud = delivered_view(imgs, aud, trim, seg["duration"])
        # 运动上下文锚在"实际交付"的尾部：网格盈余尾巴退出连续链，
        # 交付时间线的接缝才没有洞
        prev_images = out_imgs
        prev_aud = out_aud

        base = "seg_%04d" % (i + 1)
        if cached_hit:
            # 命中段缺了可看工件就补上，不动 latent
            if not os.path.isfile(os.path.join(rd, "posters", base + ".jpg")):
                C.save_segment(rd, i, None, out_imgs, out_aud, poster_only=True)
            if not os.path.isfile(os.path.join(rd, base + ".mp4")):
                video_obj = InputImpl.VideoFromComponents(
                    Types.VideoComponents(images=out_imgs, audio=out_aud,
                                          frame_rate=Fraction(P.FPS)))
                video_obj.save_to(os.path.join(rd, base + ".mp4"),
                                  format=Types.VideoContainer("mp4"))
        else:
            C.save_segment(rd, i, latent, out_imgs, out_aud)

        all_images.append(out_imgs)
        all_audio = _concat_audio(all_audio, out_aud)

        seg_seed = (base_seed + i) & 0xffffffffffffffff
        frames = int(out_imgs.shape[0])
        wav_s = int(out_aud["waveform"].shape[-1])
        drift = abs(frames / float(P.FPS) - wav_s / int(out_aud["sample_rate"])) * 1000.0
        seg_meta.append({
            "hash": hashes[i], "frames": frames, "seed": seg_seed, "trim": trim,
            "poster_file": base + ".jpg", "mp4_file": base + ".mp4",
        })
        info_lines.append(
            "段 %d: %d 帧 / %.2fs, seed %d, trim %d, 音画漂移 %.1fms [%s]"
            % (i + 1, frames, frames / float(P.FPS), seg_seed, trim, drift,
               "缓存" if cached_hit else "新渲染"))

    C.save_meta(rd, C.new_meta(run, g_hash, global_prompt, globals_rows,
                               P.assets_fp(assets), base_seed, seg_meta))

    total_frames = sum(int(t.shape[0]) for t in all_images)
    header = ("运行 %r: %d 段 (%d 新渲染 / %d 缓存), base_seed %d, 共 %d 帧 / %.2fs"
              % (run, len(segs), n_render, first_dirty, base_seed,
                 total_frames, total_frames / float(P.FPS)))
    if global_block:
        header += "\n全局设定: " + (global_block[:60] + "…" if len(global_block) > 60 else global_block)
    info = header + "\n" + "\n".join(info_lines)
    _LOG.info("%s", header)

    return (torch.cat(all_images, dim=0), all_audio,
            C.contact_sheet(all_images), info)
