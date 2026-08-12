// video.js —— v2 二期：v2v/rv2v 视频编辑模式。
//
// 组成（设计图 v2v.png）：
//   上传区（点击/拖拽，>95MB 自动分块）→ 舞台播放器（播放/seek/帧跳转/循环）
//   → 时间轴段块（点选/拖右缘调区间/分割点删除合并相邻段）
//   → 段面板（提示词+🪄+rv2v 段级参考图/音频）+ 智能分割/均分/追加视频。
//
// 数据契约（后端 parse_director）：
//   * 单视频：tl.video.fileName + 段 start/length（24fps 时间轴帧号）
//   * 多段拼接：tl.videoClips[{videoFile, logicalStart, logicalEnd}]，
//     段与 clip 1:1（后端 clip = clips[min(i, len-1)]），追加视频后
//     不能再智能分割/均分（后端只看 clip 整段范围）；
//   * 段的 frameCount = length、durationSec = length/24（输出时长跟随源区间）。
import { el, fmtTime, viewURL, splitRel, uploadImage, refThumbURL, lightbox } from "./util.js";

const TL_FPS = 24;   // 时间轴帧率（parse_director 用 tl.frameRate=24 换算秒）

export function createVideoEditor(ed, { api }) {
    const { store } = ed;

    // --- 上传（直传/分块） -------------------------------------------------------
    async function uploadVideo(file) {
        if (file.size > 95 * 1024 * 1024) {
            // 分块：8MB/块，multipart upload_chunk
            const uploadId = "up" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const CHUNK = 8 * 1024 * 1024;
            const total = Math.ceil(file.size / CHUNK);
            for (let i = 0; i < total; i++) {
                const fd = new FormData();
                fd.append("upload_id", uploadId);
                fd.append("filename", file.name);
                fd.append("chunk_index", String(i));
                fd.append("total_chunks", String(total));
                fd.append("chunk", file.slice(i * CHUNK, (i + 1) * CHUNK));
                const r = await api.fetchApi("/minimax/director/upload_chunk", { method: "POST", body: fd });
                if (!r.ok) throw new Error("分块上传失败: HTTP " + r.status);
                const data = await r.json();
                if (data.name) return data;   // 最后一块返回装配结果
            }
            throw new Error("分块上传未完成");
        }
        return await uploadImage(api, file);   // 视频走同一 /upload/image 通道
    }

    async function probe(name, subfolder) {
        const r = await api.fetchApi("/minimax/director/probe_video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoFile: name, subfolder: subfolder || "" }),
        });
        if (!r.ok) throw new Error("视频解析失败: " + (await r.text()));
        return await r.json();   // {width,height,duration,native_fps,frame_count}
    }

    // 载入首个视频：建一个覆盖全片的段
    async function loadFirstVideo(file) {
        const info = await uploadVideo(file);
        const meta = await probe(info.name, info.subfolder);
        const s = store.get();
        const frames = Math.max(TL_FPS, Math.round(meta.duration * TL_FPS));
        s.video = { fileName: info.name, subfolder: info.subfolder || "", frames };
        s.videoClips = [];
        s.segments = [{
            id: store.newSegment().id, start: 0, length: frames,
            frameCount: frames, durationSec: Math.round(frames / TL_FPS * 10) / 10,
            prompt: "", taskType: store.mode(), refs: [], refAudios: [], refVideos: [],
            genImage: { imageFile: "" },
        }];
        s.shots = [];
        ed.selectedIndex = 0;
        store.commit({ structural: true });
    }

    // 追加视频：clips 模式，段与 clip 1:1
    async function appendVideo(file) {
        const info = await uploadVideo(file);
        const meta = await probe(info.name, info.subfolder);
        const s = store.get();
        const frames = Math.max(TL_FPS, Math.round(meta.duration * TL_FPS));
        if (!s.videoClips.length) {
            // 单视频转 clips：既有分段压成 1:1（后端 clips 模式只看 clip 整段）
            s.videoClips = [{ id: "c0", videoFile: s.video.fileName,
                              subfolder: s.video.subfolder,
                              logicalStart: 0, logicalEnd: s.video.frames }];
            const keep = s.segments[0];
            s.segments = [{ ...keep, start: 0, length: s.video.frames,
                            frameCount: s.video.frames,
                            durationSec: Math.round(s.video.frames / TL_FPS * 10) / 10 }];
        }
        const base = s.videoClips.reduce((a, c) => Math.max(a, c.logicalEnd), 0);
        s.videoClips.push({ id: "c" + s.videoClips.length, videoFile: info.name,
                            subfolder: info.subfolder || "",
                            logicalStart: base, logicalEnd: base + frames });
        s.segments.push({
            id: store.newSegment().id, start: base, length: base + frames,
            frameCount: frames, durationSec: Math.round(frames / TL_FPS * 10) / 10,
            prompt: "", taskType: store.mode(), refs: [], refAudios: [], refVideos: [],
            genImage: { imageFile: "" },
        });
        s.video.frames = base + frames;
        ed.selectedIndex = s.segments.length - 1;
        store.commit({ structural: true });
    }

    // 智能分割（仅单视频）
    async function smartSplit(statusFn) {
        const s = store.get();
        if (!s.video?.fileName) return;
        statusFn?.("正在分析分镜…");
        try {
            const r = await api.fetchApi("/minimax/director/detect_shots", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    videoFile: s.video.fileName, subfolder: s.video.subfolder || "",
                    frameRate: TL_FPS, totalFrames: s.video.frames,
                }),
            });
            const data = await r.json();
            if (!r.ok || !data.cutFrames || data.cutFrames.length < 2) {
                statusFn?.("智能分割失败：" + (data.error || "无有效切点"));
                return;
            }
            rebuildFromCuts(data.cutFrames);
            statusFn?.("完成：约 " + data.shotCount + " 个镜头，可手动微调");
        } catch (e) {
            statusFn?.("智能分割失败：" + (e?.message || e));
        }
    }

    function rebuildFromCuts(cuts) {
        const s = store.get();
        const prompts = s.segments.map((x) => x.prompt);
        const segs = [];
        for (let i = 0; i < cuts.length - 1; i++) {
            const len = cuts[i + 1] - cuts[i];
            if (len < 5) continue;
            segs.push({
                id: (s.segments[i] || {}).id || store.newSegment().id,
                start: cuts[i], length: len,
                frameCount: len, durationSec: Math.round(len / TL_FPS * 10) / 10,
                prompt: prompts[i] || "", taskType: store.mode(),
                refs: [], refAudios: [], refVideos: [], genImage: { imageFile: "" },
            });
        }
        if (segs.length) {
            s.segments = segs;
            ed.selectedIndex = 0;
            store.commit({ structural: true });
        }
    }

    function equalSplit(n) {
        const s = store.get();
        if (!s.video?.frames || n < 2) return;
        const cuts = [0];
        for (let i = 1; i < n; i++) cuts.push(Math.round(s.video.frames * i / n));
        cuts.push(s.video.frames);
        rebuildFromCuts(cuts);
    }

    // --- 渲染 -------------------------------------------------------------------

    function render(main, globalArea) {
        const s = store.get();
        main.innerHTML = "";

        if (!s.video?.fileName) {
            const up = el("div", "sd2-panel sd2-vup");
            up.innerHTML = "<b>上传源视频</b><br><span class='meta'>点击选择或拖进来；"
                + "超过 95MB 自动分块上传</span>";
            up.addEventListener("click", () => pickFile(loadFirstVideo));
            up.addEventListener("dragover", (e) => { e.preventDefault(); up.classList.add("drop"); });
            up.addEventListener("dragleave", () => up.classList.remove("drop"));
            up.addEventListener("drop", (e) => {
                e.preventDefault();
                up.classList.remove("drop");
                const f = e.dataTransfer?.files?.[0];
                if (f) loadFirstVideo(f).catch((err) => console.error("[sd2] 视频载入失败", err));
            });
            main.appendChild(up);
            return;
        }

        main.appendChild(buildStage());
        main.appendChild(buildTrack());
        main.appendChild(buildSegPanel());
        if (store.mode() === "rv2v") globalArea.appendChild(buildRv2vGlobal());
    }

    function pickFile(onFile) {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/*";
        inp.style.display = "none";
        inp.addEventListener("change", () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (f) onFile(f).catch?.((err) => console.error("[sd2] 视频载入失败", err));
        });
        document.body.appendChild(inp);
        inp.click();
    }

    // 舞台播放器
    function buildStage() {
        const s = store.get();
        const wrap = el("div", "sd2-vstage");
        const video = document.createElement("video");
        video.src = viewURL(api, s.video.fileName, s.video.subfolder, "input");
        video.preload = "auto";
        video.playsInline = true;
        wrap.appendChild(video);

        const bar = el("div", "sd2-vcontrols");
        const play = el("button", "sd2-btn sm", "▶");
        const tc = el("span", "meta tc", "0.00 / " + (s.video.frames / TL_FPS).toFixed(2));
        const seek = el("input", "seek");
        seek.type = "range";
        seek.min = "0";
        seek.max = String(Math.max(0, s.video.frames - 1));
        seek.step = "1";
        seek.value = "0";
        const frameInp = el("input", "sd2-inp num");
        frameInp.type = "number";
        frameInp.min = "1";
        frameInp.value = "1";
        const frameTotal = el("span", "meta", "/ " + s.video.frames);
        const loop = el("button", "sd2-btn sm", "循环：开");
        loop.classList.add("active");

        play.addEventListener("click", () => { video.paused ? video.play() : video.pause(); });
        video.addEventListener("play", () => { play.textContent = "⏸"; });
        video.addEventListener("pause", () => { play.textContent = "▶"; });
        video.addEventListener("timeupdate", () => {
            const f = Math.round(video.currentTime * TL_FPS);
            seek.value = String(f);
            tc.textContent = video.currentTime.toFixed(2) + " / " + (s.video.frames / TL_FPS).toFixed(2);
        });
        seek.addEventListener("input", () => {
            video.currentTime = parseInt(seek.value, 10) / TL_FPS;
        });
        frameInp.addEventListener("change", () => {
            const f = Math.min(s.video.frames, Math.max(1, parseInt(frameInp.value, 10) || 1));
            frameInp.value = String(f);
            video.currentTime = (f - 1) / TL_FPS;
        });
        loop.addEventListener("click", () => {
            video.loop = !video.loop;
            loop.textContent = video.loop ? "循环：开" : "循环：关";
            loop.classList.toggle("active", video.loop);
        });
        video.loop = true;

        bar.appendChild(play);
        bar.appendChild(tc);
        bar.appendChild(seek);
        bar.appendChild(frameInp);
        bar.appendChild(frameTotal);
        bar.appendChild(loop);
        wrap.appendChild(bar);
        return wrap;
    }

    // 时间轴段块（DOM 版：块 + 分割点 + 拖右缘）
    function buildTrack() {
        const s = store.get();
        const wrap = el("div", "sd2-vtrack-wrap");
        // 工具行：智能分割/均分/追加视频（clips 模式禁分割）
        const tools = el("div", "sd2-vtools");
        const single = !s.videoClips.length;
        const bSplit = el("button", "sd2-btn sm", "智能分割");
        bSplit.title = single ? "按分镜自动切分（PySceneDetect 帧差）" : "多段拼接模式不支持";
        bSplit.disabled = !single;
        const stMsg = el("span", "meta");
        bSplit.addEventListener("click", () => smartSplit((m) => { stMsg.textContent = m; }));
        tools.appendChild(bSplit);
        tools.appendChild(el("span", "lbl", "均分"));
        const eqN = el("input", "sd2-inp num");
        eqN.type = "number"; eqN.min = "2"; eqN.max = "64"; eqN.value = "2";
        eqN.disabled = !single;
        tools.appendChild(eqN);
        const bEq = el("button", "sd2-btn sm", "均分");
        bEq.disabled = !single;
        bEq.addEventListener("click", () => equalSplit(parseInt(eqN.value, 10) || 2));
        tools.appendChild(bEq);
        const bAppend = el("button", "sd2-btn sm", "追加视频");
        bAppend.title = "上传并拼到时间轴末尾（段与片 1:1）";
        bAppend.addEventListener("click", () => pickFile(appendVideo));
        tools.appendChild(bAppend);
        tools.appendChild(stMsg);
        wrap.appendChild(tools);

        const track = el("div", "sd2-vtrack");
        const totalF = Math.max(1, s.video.frames);
        s.segments.forEach((seg, i) => {
            const startF = seg.start ?? seg.logicalStart ?? 0;
            const lenF = seg.length ?? ((seg.logicalEnd ?? 0) - startF);
            const block = el("div", "sd2-vseg" + (i === ed.selectedIndex ? " sel" : ""));
            block.style.left = (startF / totalF * 100) + "%";
            block.style.width = Math.max(2, lenF / totalF * 100) + "%";
            block.appendChild(el("span", "cap",
                "片段 " + (i + 1) + " · " + fmtTime(startF / TL_FPS) + "–" + fmtTime((startF + lenF) / TL_FPS)));
            block.addEventListener("click", () => {
                ed.selectedIndex = i;
                ed.render();
            });
            // 拖右缘调区间（仅单视频模式；段 i 的尾 = 段 i+1 的头）
            if (single) {
                const grip = el("div", "grip");
                grip.title = "拖动调整本段终点（下一段起点跟着动）";
                grip.addEventListener("pointerdown", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    grip.setPointerCapture(e.pointerId);
                    const trackRect = track.getBoundingClientRect();
                    const move = (ev) => {
                        const frac = Math.min(1, Math.max(0, (ev.clientX - trackRect.left) / trackRect.width));
                        let endF = Math.round(frac * totalF);
                        const minEnd = startF + TL_FPS;   // 至少 1s
                        const maxEnd = i < s.segments.length - 1
                            ? (s.segments[i + 1].start + s.segments[i + 1].length - TL_FPS)
                            : totalF;
                        endF = Math.max(minEnd, Math.min(maxEnd, endF));
                        seg.length = endF - startF;
                        seg.frameCount = seg.length;
                        seg.durationSec = Math.round(seg.length / TL_FPS * 10) / 10;
                        if (i < s.segments.length - 1) {
                            s.segments[i + 1].length = s.segments[i + 1].start + s.segments[i + 1].length - endF;
                            s.segments[i + 1].start = endF;
                            s.segments[i + 1].frameCount = s.segments[i + 1].length;
                            s.segments[i + 1].durationSec = Math.round(s.segments[i + 1].length / TL_FPS * 10) / 10;
                        }
                        block.style.width = (seg.length / totalF * 100) + "%";
                        const next = track.children[i + 1];
                        if (next && i < s.segments.length - 1) {
                            next.style.left = (endF / totalF * 100) + "%";
                            next.style.width = (s.segments[i + 1].length / totalF * 100) + "%";
                        }
                    };
                    const up = () => {
                        grip.removeEventListener("pointermove", move);
                        grip.removeEventListener("pointerup", up);
                        store.commit({ structural: true });
                    };
                    grip.addEventListener("pointermove", move);
                    grip.addEventListener("pointerup", up);
                });
                block.appendChild(grip);
            }
            track.appendChild(block);
        });
        wrap.appendChild(track);
        return wrap;
    }

    // 段面板（选中段：提示词 + 🪄 + 删除 + rv2v 段级参考）
    function buildSegPanel() {
        const s = store.get();
        const i = Math.min(ed.selectedIndex, s.segments.length - 1);
        const seg = s.segments[i];
        const panel = el("div", "sd2-panel");
        if (!seg) return panel;
        const head = el("div", "sd2-card-head");
        head.appendChild(el("b", "", "片段 " + (i + 1)));
        head.appendChild(el("span", "meta",
            "帧 " + (seg.start + 1) + "–" + (seg.start + seg.length)
            + " · " + fmtTime(seg.start / TL_FPS) + "–" + fmtTime((seg.start + seg.length) / TL_FPS)));
        head.appendChild(el("span", "sp"));
        const del = el("button", "sd2-btn sm danger", "删除片段");
        del.title = "删除并把区间并给前一段（首段则并给后一段）";
        del.addEventListener("click", () => {
            if (s.segments.length <= 1) return;
            if (!s.videoClips.length) {
                // 单视频：区间并给邻段
                if (i > 0) {
                    s.segments[i - 1].length += seg.length;
                    s.segments[i - 1].frameCount = s.segments[i - 1].length;
                    s.segments[i - 1].durationSec = Math.round(s.segments[i - 1].length / TL_FPS * 10) / 10;
                } else {
                    s.segments[1].length += s.segments[0].length;
                    s.segments[1].start = 0;
                    s.segments[1].frameCount = s.segments[1].length;
                    s.segments[1].durationSec = Math.round(s.segments[1].length / TL_FPS * 10) / 10;
                }
            } else {
                s.videoClips.splice(i, 1);   // clips 模式 1:1 同步删
            }
            s.segments.splice(i, 1);
            ed.selectedIndex = Math.max(0, i - 1);
            store.commit({ structural: true });
        });
        head.appendChild(del);
        panel.appendChild(head);

        // 提示词 + 🪄（复用 cards.js 的 promptArea 结构，直接内联实现避免循环依赖）
        const phead = el("div", "sd2-phead");
        phead.appendChild(el("span", "lbl", "片段提示词"));
        const wand = el("button", "sd2-wand", "🪄 扩写本段");
        wand.type = "button";
        wand.addEventListener("click", () => ed.enhancer.enhanceTarget(i));
        phead.appendChild(wand);
        panel.appendChild(phead);
        const ta = el("textarea", "sd2-prompt");
        ta.value = seg.prompt || "";
        ta.placeholder = "这一段要改成什么（画面/运镜/声音）……";
        ta.addEventListener("input", () => { seg.prompt = ta.value; store.commit(); });
        panel.appendChild(ta);
        if (ed.preview && ed.preview.target === i) {
            // 预览块（与 cards.js 同结构）
            const p = ed.preview;
            const box = el("div", "sd2-pv");
            box.appendChild(el("div", "hd", "🪄 结果预览 · " + p.name + " · 确认后应用"));
            box.appendChild(el("pre", "tx", p.text));
            const ops = el("div", "ops");
            const close = () => { ed.preview = null; ed.render(); };
            const mk = (label, cls, fn) => {
                const b = el("button", cls, label);
                b.type = "button";
                b.addEventListener("click", (e) => { e.preventDefault(); fn(); });
                ops.appendChild(b);
            };
            mk("应用", "p", () => { ed.enhancer.applyPreview(); });
            mk("复制", "s", () => { navigator.clipboard?.writeText(p.text); });
            mk("丢弃", "d", close);
            box.appendChild(ops);
            panel.appendChild(box);
        }

        // rv2v：段级参考图/音频
        if (store.mode() === "rv2v") {
            panel.appendChild(el("div", "sd2-sec", "本段参考图（编号接全局之后）"));
            const gPics = (s.global.refs || []).length;
            const refs = el("div", "sd2-refs");
            for (let k = 0; k < Math.max(1, 4 - 0); k++) {
                refs.appendChild(segRefSlot(seg.refs, gPics + k));
            }
            panel.appendChild(refs);
            panel.appendChild(el("div", "sd2-sec", "本段参考音频"));
            const auds = el("div", "sd2-refs three");
            for (let k = 0; k < 3; k++) auds.appendChild(segAudioSlot(seg.refAudios, k));
            panel.appendChild(auds);
        }
        return panel;
    }

    function segRefSlot(refList, index) {
        const ref = refList.find((r) => Number(r.index) === index && r.imageFile);
        const slot = el("div", "sd2-ref" + (ref ? " has" : ""));
        let clickTimer = 0;
        if (ref) {
            const img = document.createElement("img");
            img.src = refThumbURL(api, ref);
            slot.appendChild(img);
            slot.appendChild(el("span", "tag", "图片" + (index + 1)));
            const x = el("u", "x", "×");
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                clearTimeout(clickTimer);
                refList.splice(refList.indexOf(ref), 1);
                store.commit({ structural: true });
            });
            slot.appendChild(x);
            slot.title = "点击更换；双击放大";
        } else {
            slot.textContent = "图片" + (index + 1);
        }
        slot.addEventListener("click", () => {
            clearTimeout(clickTimer);
            clickTimer = setTimeout(() => {
                const inp = document.createElement("input");
                inp.type = "file";
                inp.accept = "image/*";
                inp.style.display = "none";
                inp.addEventListener("change", async () => {
                    const f = inp.files && inp.files[0];
                    inp.remove();
                    if (!f) return;
                    const info = await uploadImage(api, f);
                    const rel = info.subfolder ? info.subfolder + "/" + info.name : info.name;
                    const old = refList.find((r) => Number(r.index) === index);
                    if (old) old.imageFile = rel;
                    else refList.push({ index, imageFile: rel });
                    store.commit({ structural: true });
                });
                document.body.appendChild(inp);
                inp.click();
            }, 260);
        });
        if (ref) {
            slot.addEventListener("dblclick", () => {
                clearTimeout(clickTimer);
                lightbox(refThumbURL(api, ref), false);
            });
        }
        return slot;
    }

    function segAudioSlot(refList, index) {
        const ref = refList.find((r) => Number(r.index) === index && r.audioFile);
        const slot = el("div", "sd2-audio" + (ref ? " has" : ""));
        slot.textContent = ref ? "音频" + (index + 1) + " · " + splitRel(ref.audioFile).image : "音频" + (index + 1);
        if (ref) {
            const x = el("u", "x", "×");
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                refList.splice(refList.indexOf(ref), 1);
                store.commit({ structural: true });
            });
            slot.appendChild(x);
        }
        slot.addEventListener("click", () => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "audio/*";
            inp.style.display = "none";
            inp.addEventListener("change", async () => {
                const f = inp.files && inp.files[0];
                inp.remove();
                if (!f) return;
                const info = await uploadImage(api, f);
                const rel = info.subfolder ? info.subfolder + "/" + info.name : info.name;
                const old = refList.find((r) => Number(r.index) === index);
                if (old) old.audioFile = rel;
                else refList.push({ index, audioFile: rel });
                store.commit({ structural: true });
            });
            document.body.appendChild(inp);
            inp.click();
        });
        return slot;
    }

    // rv2v 全局参考图（复用全局面板语义：仅图片区）
    function buildRv2vGlobal() {
        const s = store.get();
        const panel = el("div", "sd2-panel");
        const head = el("div", "sd2-card-head");
        head.appendChild(el("b", "", "全局参考图（图片1–9）"));
        head.appendChild(el("span", "meta", "供各段读取"));
        panel.appendChild(head);
        const refs = el("div", "sd2-refs nine");
        for (let k = 0; k < 9; k++) refs.appendChild(segRefSlot(s.global.refs, k));
        panel.appendChild(refs);
        return panel;
    }

    return { render };
}
