"""SceneDirector 执行器：编码路径 + 窗口衔接链条主循环。

只做一件事——逐段衔接。每段的文本条件由上游节点在编码头备好，
采样配置（sampler/sigmas/model 补丁/negative）全部来自接线；
静态图表达不了的部分才留在这里：每段的运动上下文来自上一段的
采样器输出这一顺序依赖，以及磁盘增量缓存。

特性（Director 1.1 工程化）：
  * 衔接开关（continuity）：开 = latent 上下文窗口；关 = 官方原生逐段
  * 选择运行（run mask）：未勾选段缓存填充，无缓存报错引导
  * 色彩一致性：全片逐帧校色（可选）+ 接缝亮度渐变/回声诊断
  * 段间 VRAM 清理（可选）
  * 任务模式：fl2v 段级首尾帧（链条让位）、v2v 源片段与声音模式
"""

import base64
import io
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
                                   VIDEO_RUN_GRID)
from . import video_io
from . import payload as P
from . import cache as C
from .conditioning import (build_cond, load_ref_image, encode_video_ref,
                           encode_asset_refs, MAX_REFS)
from .colorlock import (stats as cl_stats, match_smooth as cl_match,
                        opening_luma_blend, seam_echo_count,
                        luma_of as cl_luma_of, luma_match as cl_luma_match)
from . import plan as PL
from . import vram as VRAM
from .status import emit_log

_LOG = logging.getLogger("h3_scenedirector")

PROGRESS_EVENT = "h3_scenedirector_progress"
STEP_EVENT = "h3_scenedirector_step"   # 逐步实时预览
# Director 前端（minimax_timeline.js）的事件名：进度与实时预览按 node_id 定位
DIR_PROGRESS_EVENT = "minimax_director_progress"
DIR_PREVIEW_EVENT = "minimax_director_preview"


def _dir_progress(node_id, seg, total, phase, phase_label,
                  phase_value, phase_max, overall_value, overall_max,
                  partial=False):
    """按 Director 前端的形状发进度事件。"""
    if node_id is None:
        return
    try:
        PromptServer.instance.send_sync(DIR_PROGRESS_EVENT, {
            "node_id": node_id, "segment": seg, "segment_total": total,
            "timeline_segment": seg, "timeline_segment_total": total,
            "partial_run": bool(partial),
            "phase": phase, "phase_label": phase_label,
            "phase_value": phase_value, "phase_max": phase_max,
            "overall_value": overall_value, "overall_max": overall_max,
            "remaining_segments": max(0, total - seg),
        })
    except Exception:
        pass


def _dir_preview(node_id, seg_index, image_b64, step, total_steps):
    """按 Director 前端的形状发实时预览帧（base64 JPEG）。"""
    if node_id is None:
        return
    try:
        PromptServer.instance.send_sync(DIR_PREVIEW_EVENT, {
            "node_id": node_id, "segment_index": seg_index,
            "image_b64": image_b64, "live": True,
            "step": step, "total_steps": total_steps,
        })
    except Exception:
        pass


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
    from ..core.motion_context import streams_from_av
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


# ---------------------------------------------------------------------------
# 编码路径（编码头节点调用）
# ---------------------------------------------------------------------------

def encode_story(clip, vae, audio_vae, segments_raw, width, height,
                 first_frame=None):
    """异常安全壳：编码报错时做显存收尾再原样抛出（不吞异常）。"""
    try:
        return _encode_story_impl(clip, vae, audio_vae, segments_raw,
                                  width, height, first_frame=first_frame)
    except Exception as e:
        VRAM.cleanup_after_error()
        emit_log("条件编码中断：%s（已释放显存）" % (e,))
        raise


def _encode_story_impl(clip, vae, audio_vae, segments_raw, width, height,
                       first_frame=None):
    """编码头：把载荷里每一段的完整提示词（场景设定表 + 资产清单 +
    段提示词 + 段级资产钉）用接进来的 CLIP 编码，参考素材（图/视频/
    音频）用对应 VAE 编码，输出逐段 CONDITIONING 列表。链条只管消费。

    段级首尾帧（fl2v）经 minimax_keyframes 钉入该段条件；v2v 源片段
    编码为 <Video K> 参考块。
    """
    run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments_raw)
    if not segs:
        raise ValueError("H3SceneDirector: 载荷里没有任何段")
    # v5：全局块与全局参考块只算常驻卡；按需卡躺在库里，由段 refs 引用挂载
    pinned = P.pinned_assets(assets)
    global_block = P.compose_global(global_prompt, globals_rows, pinned)

    # 全局素材序号（按 kind 分别编号，段级接在后面）
    n_pic = sum(1 for a in pinned if a["image"] and a.get("kind", "image") == "image")
    n_vid = sum(1 for a in pinned if a["image"] and a.get("kind") == "video")
    n_aud = sum(1 for a in pinned if a["image"] and a.get("kind") == "audio")

    global_refs = encode_asset_refs(
        vae, audio_vae, width, height, pinned,
        video_loader=_video_full, audio_loader=_audio_full)
    seg_cache = {}

    def _load(kind, a):
        key = (kind, a["image"], a["subfolder"])
        if key not in seg_cache:
            if kind == "video":
                seg_cache[key] = _video_full(a["image"], a["subfolder"])
            else:
                seg_cache[key] = _audio_full(a["image"], a["subfolder"])
        return seg_cache[key]

    conds = []
    for i, seg in enumerate(segs):
        # 段实际生效资产 = 常驻 + refs 解析 + 段级内嵌；清单行与参考块按此
        # 顺序（refs 卡插在锚点的同时也进本段参考块，即"@ 引用即挂载"）
        seg_assets = P.seg_effective_assets(assets, seg)[len(pinned):]
        seg_extra = P.compose_seg_extra(seg_assets, (n_pic, n_vid, n_aud))
        full_prompt = P.compose_prompt(global_block, seg["prompt"], seg_extra)

        ref_items, ref_blocks = list(global_refs[0]), list(global_refs[1])
        if seg_assets:
            s_items, s_blocks = encode_asset_refs(
                vae, audio_vae, width, height, seg_assets,
                video_loader=lambda f, sf: _load("video", {"image": f, "subfolder": sf}),
                audio_loader=lambda f, sf: _load("audio", {"image": f, "subfolder": sf}))
            ref_items += s_items
            ref_blocks += s_blocks

        # v2v 源片段 -> <Video K> 参考块
        if seg.get("source"):
            s = seg["source"]
            frames = video_io.decode_frames(s["video"], s["subfolder"],
                                            s["start"], s["end"])
            v_item, v_block = encode_video_ref(vae, width, height, frames)
            ref_items.append(v_item)
            ref_blocks.append(v_block)

        if len(ref_blocks) > MAX_REFS:
            _LOG.warning("run %r 段 %d: %d 个参考块（>%d）可能挤占条件行",
                         run, i + 1, len(ref_blocks), MAX_REFS)
        _LOG.info("run %r 段 %d [%s]: %d 个参考块; 提示词: %.100s",
                  run, i + 1, seg.get("task", "t2v"),
                  len(ref_blocks), full_prompt.replace("\n", " "))

        # 段级首尾帧（fl2v）；节点级 first_frame 只作用于段 1
        ff = load_ref_image(seg["first_frame"]["image"],
                            seg["first_frame"]["subfolder"]) \
            if seg.get("first_frame") else None
        lf = load_ref_image(seg["last_frame"]["image"],
                            seg["last_frame"]["subfolder"]) \
            if seg.get("last_frame") else None
        if i == 0 and first_frame is not None and ff is None:
            ff = first_frame

        cond, _latent = build_cond(
            clip, vae, full_prompt, width, height, P.base_length(seg["duration"]),
            first_frame=ff, last_frame=lf,
            ref_items=ref_items, ref_blocks=ref_blocks)
        conds.append(cond)
    return {"width": int(width), "height": int(height), "conds": conds}


def _video_full(video, subfolder):
    """视频资产整段解码。"""
    dur = video_io.probe_video(video, subfolder)["duration"]
    return video_io.decode_frames(video, subfolder, 0.0, dur)


def _audio_full(video, subfolder):
    """音频资产整段读取（复用 video_io 的音轨抽取）。"""
    dur = video_io.probe_video(video, subfolder)["duration"]
    return video_io.extract_audio(video, subfolder, 0.0, dur)


# ---------------------------------------------------------------------------
# 采样
# ---------------------------------------------------------------------------

def _sample(model, positive, latent, seed, sampler, sigmas, negative=None, cfg=1.0,
            live=None):
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
    # 与 latent_preview.prepare_callback 等价：原生进度条 + 预览字节照旧，
    # 另外把"中段时间步"的 latent→RGB 投影经 live 回调推给工作台做逐步预览
    # （线性投影零 VAE 开销；窗口头部是上一段的钉帧上下文，中段才是新内容）
    previewer = latent_preview.get_previewer(model.load_device, model.model.latent_format)
    if live is not None and previewer is None:
        _LOG.warning("实时预览不可用：latent 预览器为空（预览方式被禁用？）")
    pbar = comfy.utils.ProgressBar(int(sigmas.shape[-1] - 1))

    def callback(step, x0, x, total_steps):
        xx = x0.tensors[0] if getattr(x0, "is_nested", False) else x0
        preview_bytes = None
        if previewer is not None:
            preview_bytes = previewer.decode_latent_to_preview_image("JPEG", xx)
        pbar.update_absolute(step + 1, total_steps, preview_bytes)
        if live is not None and previewer is not None:
            try:
                t = int(xx.shape[2]) if xx.ndim == 5 else 1
                mid = xx[:, :, t // 2: t // 2 + 1] if xx.ndim == 5 else xx
                live(int(step), int(total_steps),
                     previewer.decode_latent_to_preview(mid))
                if not getattr(callback, "_ok", False):
                    callback._ok = True
                    _LOG.info("实时预览首帧已发送（latent shape %s）", tuple(xx.shape))
            except Exception as e:
                if not getattr(callback, "_warned", False):
                    callback._warned = True
                    _LOG.warning("实时预览帧生成失败（仅报一次）: %r", e)

    samples = guider.sample(noise, latent_image, sampler, sigmas,
                            denoise_mask=None, callback=callback,
                            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
                            seed=seed)
    samples = samples.to(comfy.model_management.intermediate_device())

    out = latent2.copy()
    out["samples"] = samples
    return out


# ---------------------------------------------------------------------------
# 链条主循环
# ---------------------------------------------------------------------------

def run_chain(*args, **kwargs):
    """异常安全壳：渲染报错时做显存收尾（gc + 归还 CUDA 缓存，保留模型
    驻留现场），日志条可见，然后原样抛出——ComfyUI 需要错误状态。"""
    try:
        return _run_chain_impl(*args, **kwargs)
    except Exception as e:
        VRAM.cleanup_after_error()
        emit_log("run 中断：%s（已释放显存）" % (e,))
        raise


def _run_chain_impl(model, vae, audio_vae, segments_raw, story_cond, sampler,
                    sigmas, width, height, seed, context_length,
                    audio_context_length,
                    encode_mode, anchor_mode, audio_mode, crop, cfg, cache_tag,
                    uniform_window=False, color_lock=False, negative=None,
                    continuity=True, seam_blend=True, vram_cleanup=False,
                    node_id=None, luma_lock=False):
    """链条主循环：缓存命中段直接解码，自第一个变动段起级联重渲；
    未勾选段（选择运行关闭）走缓存填充。返回 (images, audio, contact_sheet, info)。

    node_id 用于 Director 前端的进度/预览事件定位节点。"""
    run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments_raw)
    if not segs:
        raise ValueError("H3SceneDirector: 请至少加一段带提示词的分镜")

    # run 级覆盖（工作台写进载荷的控制项）：载荷优先，缺省跟随 widget
    opts = P.parse_run_options(segments_raw)
    if opts["continuity"] is not None:
        continuity = opts["continuity"]
    if opts["context_length"] is not None:
        context_length = max(1, min(39, opts["context_length"]))
    if opts["color_lock"] is not None:
        color_lock = opts["color_lock"]
    if opts["luma_lock"] is not None:
        luma_lock = opts["luma_lock"]
    run_audio_mode = opts["audio_mode"]
    run, run_nonce, global_prompt, globals_rows, assets, segs = P.parse_payload(segments_raw)
    if not segs:
        raise ValueError("H3SceneDirector: 请至少加一段带提示词的分镜")

    conds = list((story_cond or {}).get("conds") or [])
    if len(conds) != len(segs):
        raise ValueError(
            "H3SceneDirector: story_cond 带了 %d 个段条件，但载荷有 %d 段。"
            "两个输入请接同一个 StoryList。" % (len(conds), len(segs)))
    if (int(story_cond.get("width", width)), int(story_cond.get("height", height))) \
            != (int(width), int(height)):
        raise ValueError(
            "H3SceneDirector: 画布不一致——story_cond 按 %dx%d 编码，链条设的是 "
            "%dx%d。两处宽高请接同一个 ResolutionSelector。"
            % (story_cond.get("width"), story_cond.get("height"), width, height))

    rd = C.run_dir(run)
    os.makedirs(rd, exist_ok=True)
    meta = C.load_meta(rd)
    g_hash = P.global_hash(run_nonce, width, height, context_length,
                           audio_context_length, encode_mode, anchor_mode,
                           audio_mode, crop, global_prompt, globals_rows, assets,
                           P.sampling_fp(sampler, sigmas, negative, cfg),
                           cache_tag=str(cache_tag or "").strip(), seed=seed,
                           continuity=continuity, seam_blend=seam_blend)
    hashes = [P.seg_hash(i, s, assets) for i, s in enumerate(segs)]
    global_block = P.compose_global(global_prompt, globals_rows,
                                    P.pinned_assets(assets))
    run_plan = PL.build_plan(run, segs, hashes)

    # 未勾选段必须已有缓存，否则给出引导（选择运行的固有约束）
    cached_meta0 = meta.get("segments") or [] \
        if meta.get("global_hash") == g_hash else []
    for sp in run_plan.segments:
        if sp.enabled:
            continue
        m = cached_meta0[sp.index] if sp.index < len(cached_meta0) else None
        if (not m or not os.path.isfile(C.latent_path(rd, sp.index))):
            raise ValueError(
                "H3SceneDirector: 段 %d 未勾选运行，但缓存里没有它的渲染结果。"
                "请先勾选它跑过一次，或改为全选运行。" % (sp.index + 1))

    # 第一个必须重渲的启用段；它之后启用的段全部级联
    first_dirty = 0
    cached_meta = []
    if meta.get("global_hash") == g_hash:
        cached_meta = cached_meta0
        first_dirty = PL.first_dirty_index(
            run_plan, cached_meta,
            lambda idx: os.path.isfile(C.latent_path(rd, idx)))
    n_render = sum(1 for sp in run_plan.segments if sp.enabled and sp.index >= first_dirty)
    n_cached = len(segs) - n_render

    if seed is not None and seed >= 0:
        base_seed = seed
    elif meta.get("base_seed") is not None:
        base_seed = int(meta["base_seed"])
    else:
        base_seed = random.randrange(0, 0xffffffffffffffff)

    _LOG.info("run %r: %d 段, %d 缓存, %d 待渲, base_seed %d, "
              "%d 行设定, %d 个场景资产, cfg %.2f, %s, 衔接 %s",
              run, len(segs), n_cached, n_render, base_seed,
              len(globals_rows), len(assets), float(cfg),
              "引导采样" if negative is not None else "仅正条件",
              "开" if continuity else "关")
    emit_log("run %s 开始：%d 段（%d 新渲染 / %d 缓存），衔接 %s"
             % (run, len(segs), n_render, n_cached,
                "开" if continuity else "关"))

    all_images, all_audio = [], None
    seg_meta, info_lines = [], []
    prev_images = prev_aud = None

    def delivered_view(imgs, aud, trim, duration):
        """完整渲染 -> 实际交付视图：先去钉帧头（音画同步 trim + 修尾部
        网格盈余），再裁到精确时长。连续性锚点必须锚在这个视图上。"""
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

    if first_dirty > 0 and continuity:
        # 级联点之前的最后一段提供运动上下文（用它的交付视图）
        pl = C.load_segment_latent(rd, first_dirty - 1)
        pi, pa = decode_av(vae, audio_vae, pl["samples"])
        prev_images, prev_aud = delivered_view(
            pi, pa, int(cached_meta[first_dirty - 1].get("trim", 0)),
            segs[first_dirty - 1]["duration"])

    for i, seg in enumerate(segs):
        sp = run_plan.segments[i]
        cached_hit = (i < first_dirty) or (not sp.enabled)
        if cached_hit:
            latent = C.load_segment_latent(rd, i)
            imgs, aud = decode_av(vae, audio_vae, latent["samples"])
            trim = int(cached_meta[i].get("trim", 0))
        else:
            positive = conds[i]
            if positive is None:
                raise ValueError(
                    "H3SceneDirector: 段 %d 的条件为空，请重跑编码头。" % (i + 1))
            use_cont = PL.use_continuity(run_plan, sp, continuity) \
                and prev_images is not None
            want = max(5, round(seg["duration"] * P.FPS))
            if use_cont:
                # head 模式钉帧会把上一段尾部的 span 帧复制进本段输出，
                # trim 再把它裁掉，所以裸 dur*FPS 的窗口会少交付 span 帧。
                avail = int(prev_images.shape[0])
                n_pin = min(int(context_length), avail)
                span = next((g for g in VIDEO_RUN_GRID if g <= n_pin), 1)
                want += span
            elif uniform_window and i == 0 and continuity:
                # 段 1 也补齐到统一的渲染窗口，保证每次采样的打包 latent
                # 尺寸一致（MultiRate T8 这类采样器会逐次校验）
                span = next((g for g in VIDEO_RUN_GRID
                             if g <= int(context_length)), 1)
                want += span
            length = P.align_frame_count(want)
            latent_in, _fc = _empty_av_latent(width, height, length)
            if use_cont:
                # 钉上一段"实际交付"的尾帧（像素）+ 交付波形（音频 VAE
                # 路径，落点精确到交付边界），而不是完整渲染的尾巴
                positive, trim = apply_motion_context(
                    positive, vae, latent_in, prev_images,
                    context_length, encode_mode, anchor_mode,
                    crop, audio_context_length, audio_mode,
                    audio_vae=audio_vae, context_audio=prev_aud)
            else:
                trim = 0
            PromptServer.instance.send_sync(PROGRESS_EVENT, {
                "run": run, "segment": i + 1, "total": len(segs),
                "cached": n_cached})
            steps_total = int(sigmas.shape[-1] - 1)
            _dir_progress(node_id, i + 1, len(segs), "sample", "采样",
                          0, steps_total, i * steps_total,
                          len(segs) * steps_total,
                          partial=n_cached > 0)
            # 链内同 seed：钉帧窗口只压得住段首约 1s，窗口之后的自由区域
            # （背景、色调等未被参考锚定的部分）按初始噪声采样——各段共享同
            # 一片噪声场，自由区域的色彩/质地倾向一致，段间漂移显著收敛。
            # 想换一条新片子用前端的"全部重摇"（它会把链条节点的 seed
            # 掷成新值），而不是靠段序号派生。
            seg_seed = base_seed

            def _live(step, total_steps, img, _i=i):
                # 逐步实时预览：投影小图放大到顺手尺寸，JPEG base64 推给工作台
                try:
                    w, h = img.size
                    sc = 240.0 / max(1, w)
                    img = img.resize((max(1, round(w * sc)), max(1, round(h * sc))))
                    buf = io.BytesIO()
                    img.save(buf, "JPEG", quality=70)
                    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
                    PromptServer.instance.send_sync(STEP_EVENT, {
                        "run": run, "segment": _i + 1, "total": len(segs),
                        "step": step + 1, "steps": total_steps,
                        "image": b64})
                    _dir_preview(node_id, _i, b64, step + 1, total_steps)
                    _dir_progress(node_id, _i + 1, len(segs), "sample", "采样",
                                  step + 1, total_steps,
                                  _i * total_steps + step + 1,
                                  len(segs) * total_steps,
                                  partial=n_cached > 0)
                except Exception:
                    pass

            latent = _sample(model, positive, latent_in, seg_seed,
                             sampler, sigmas, negative, cfg, live=_live)
            imgs, aud = decode_av(vae, audio_vae, latent["samples"])
            VRAM.cleanup_segment_vram(vram_cleanup)

        out_imgs, out_aud = delivered_view(imgs, aud, trim, seg["duration"])

        # v2v 声音模式：original = 源片段原声；mute = 静音（采样率对齐生成流，
        # 否则拼接时音高/时长全错）
        if seg.get("source") and seg.get("audio_mode", "generate") != "generate":
            out_aud = _source_audio_view(seg, out_aud, out_imgs)

        # 颜色锁定：第 1 段的交付视图自身作为统计参考，后续段在交付前
        # 按通道对齐整段均值/方差，压制逐段独立渲染的白平衡/曝光漂移。
        if color_lock:
            if i == 0:
                cl_ref = cl_stats(out_imgs)
            else:
                out_imgs = cl_match(out_imgs, *cl_ref)

        # 亮度锁定（Director 同款思路）：逐段平均亮度归一到第 1 段，
        # 只做整体亮度缩放，不动色相——与颜色锁定互补，可独立开关。
        if luma_lock:
            if i == 0:
                luma_ref = cl_luma_of(out_imgs)
            else:
                out_imgs = cl_luma_match(out_imgs, luma_ref)

        # 接缝互补（第二层）：开头几帧亮度向上一段尾巴渐变，消除接口跳变；
        # 回声帧只做诊断日志。仅在本段用了链条衔接时才有意义
        used_cont = (not cached_hit) and trim > 0
        if seam_blend and i > 0 and prev_images is not None and used_cont:
            echo = seam_echo_count(out_imgs[:4], prev_images[-4:])
            if echo:
                _LOG.info("run %r 段 %d: 接缝回声 %d 帧", run, i + 1, echo)
            out_imgs = opening_luma_blend(out_imgs, prev_images[-1:])

        prev_images = out_imgs
        prev_aud = out_aud

        base = "seg_%04d" % (i + 1)
        if cached_hit:
            # 命中段缺了可看工件就补上，不动 latent；校色/亮度开关与缓存
            # 状态不一致时重存可看工件（两者不动 latent，无需重渲）
            refresh = i > 0 and (bool(meta.get("color_lock")) != bool(color_lock)
                                 or bool(meta.get("luma_lock")) != bool(luma_lock))
            if refresh or not os.path.isfile(os.path.join(rd, "posters", base + ".jpg")):
                C.save_segment(rd, i, None, out_imgs, out_aud, poster_only=True)
            if refresh or not os.path.isfile(os.path.join(rd, base + ".mp4")):
                video_obj = InputImpl.VideoFromComponents(
                    Types.VideoComponents(images=out_imgs, audio=out_aud,
                                          frame_rate=Fraction(P.FPS)))
                video_obj.save_to(os.path.join(rd, base + ".mp4"),
                                  format=Types.VideoContainer("mp4"))
        else:
            C.save_segment(rd, i, latent, out_imgs, out_aud)

        all_images.append(out_imgs)
        all_audio = _concat_audio(all_audio, out_aud)

        # meta 里记实际生效的段 seed（链内同 seed，见采样处注释）
        seg_seed = base_seed
        frames = int(out_imgs.shape[0])
        wav_s = int(out_aud["waveform"].shape[-1])
        drift = abs(frames / float(P.FPS) - wav_s / int(out_aud["sample_rate"])) * 1000.0
        seg_meta.append({
            "hash": hashes[i], "frames": frames, "seed": seg_seed, "trim": trim,
            "task": sp.task, "enabled": sp.enabled,
            "poster_file": base + ".jpg", "mp4_file": base + ".mp4",
        })
        tag = "缓存" if cached_hit else "新渲染"
        if not sp.enabled:
            tag = "缓存·未勾选"
        if color_lock and i > 0:
            tag += "·校色"
        if luma_lock and i > 0:
            tag += "·亮度"
        info_lines.append(
            "段 %d [%s]: %d 帧 / %.2fs, seed %d, trim %d, 音画漂移 %.1fms [%s]"
            % (i + 1, sp.task, frames, frames / float(P.FPS), seg_seed, trim,
               drift, tag))
        emit_log(info_lines[-1])

    meta_out = C.new_meta(run, g_hash, global_prompt, globals_rows,
                          P.assets_fp(P.pinned_assets(assets)),
                          base_seed, seg_meta)
    # 记录校色/亮度开关状态：缓存段的可看工件是按这个状态落盘的，
    # 下次开关翻转时据此重存工件（不动 latent，不重渲）
    meta_out["color_lock"] = bool(color_lock)
    meta_out["luma_lock"] = bool(luma_lock)
    C.save_meta(rd, meta_out)

    # 完成事件：这版 ComfyUI 已没有 execution_end（改名 execution_success），
    # 前端定格 100% 不能依赖宿主事件名，由引擎自己发
    PromptServer.instance.send_sync(PROGRESS_EVENT, {
        "run": run, "segment": len(segs), "total": len(segs),
        "cached": n_cached, "done": True})
    _dir_progress(node_id, len(segs), len(segs), "done", "完成",
                  1, 1, len(segs) * max(1, int(sigmas.shape[-1] - 1)),
                  len(segs) * max(1, int(sigmas.shape[-1] - 1)))

    total_frames = sum(int(t.shape[0]) for t in all_images)
    header = ("运行 %r: %d 段 (%d 新渲染 / %d 缓存), base_seed %d, 共 %d 帧 / %.2fs"
              % (run, len(segs), n_render, n_cached, base_seed,
                 total_frames, total_frames / float(P.FPS)))
    if global_block:
        header += "\n全局设定: " + (global_block[:60] + "…" if len(global_block) > 60 else global_block)
    info = header + "\n" + "\n".join(info_lines)
    _LOG.info("%s", header)
    emit_log(header.split("\n")[0] + " —— 完成")

    return (torch.cat(all_images, dim=0), all_audio,
            C.contact_sheet(all_images), info)


def _source_audio_view(seg, out_aud, out_imgs):
    """v2v 声音模式：把交付音频替换为源片段原声（original）或静音（mute），
    采样率与时长对齐当前交付视图。"""
    sr = int(out_aud["sample_rate"])
    n = int(out_imgs.shape[0])
    want = int(round(n / float(P.FPS) * sr))
    if seg.get("audio_mode") == "mute":
        wav = torch.zeros(1, out_aud["waveform"].shape[1], want)
        return {"waveform": wav, "sample_rate": sr}
    s = seg["source"]
    src = video_io.extract_audio(s["video"], s["subfolder"], s["start"], s["end"],
                                 sample_rate=sr)
    if src is None:
        _LOG.warning("v2v 段原声为空（源视频无音轨），退回静音。")
        wav = torch.zeros(1, out_aud["waveform"].shape[1], want)
        return {"waveform": wav, "sample_rate": sr}
    wav = src["waveform"]
    ch = out_aud["waveform"].shape[1]
    if wav.shape[1] != ch:
        wav = wav[:, :ch] if wav.shape[1] > ch else wav.repeat(1, ch, 1)[:, :ch]
    if wav.shape[-1] >= want:
        wav = wav[..., :want]
    else:
        wav = torch.nn.functional.pad(wav, (0, want - wav.shape[-1]))
    return {"waveform": wav, "sample_rate": sr}
