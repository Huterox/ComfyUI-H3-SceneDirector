// store.js —— v2 单一数据源：timeline v4 JSON 模型 + commit/序列化 + 状态体。
//
// 契约（js/AGENTS.md）：
//   * timeline_data 隐藏 widget 是序列化载体，写值只准普通赋值；
//   * 一切修改走 commit()，由它统一序列化 + 同步关联 widget + 广播；
//   * JSON schema 与后端 parse_director 逐字段对齐（后端零改动）；
//   * r2v 的公共音频/视频参考在序列化时合进每段（后端只读段级音/视；
//     图片不用合——后端把 global.refs 当全局资产合进每段）。
import { uid, taskKeyFromLabel, labelForTask, setDuration, resolveSize,
         sanitizeRun, splitRel } from "./util.js";

const AUDIO_MODES = ["generate", "original", "mute"];

function newSegment(durationSec = 5.0) {
    const d = setDuration(durationSec);
    return { id: uid(), durationSec: d.durationSec, frameCount: d.frameCount,
             prompt: "", taskType: "", refs: [], refAudios: [], refVideos: [],
             genImage: { imageFile: "" } };
}

function newShot(durationSec = 5.0) {
    const d = setDuration(durationSec);
    return { id: uid(), durationSec: d.durationSec, prompt: "", refs: [],
             startImage: { imageFile: "" }, endImage: { imageFile: "" } };
}

function defaultState(taskLabel) {
    return {
        version: 4,
        frameRate: 24,
        global: { taskType: taskKeyFromLabel(taskLabel), prompt: "",
                  refs: [], refAudios: [], refVideos: [] },
        output: { aspectRatio: "16:9 (宽屏)", megapixels: 1.0,
                  continuityEnabled: true, continuityOverlapFrames: 22,
                  audioMode: "generate", exportMode: "all" },
        video: { fileName: "", subfolder: "", frames: 0 },   // v2v/rv2v 源片
        videoClips: [],   // 多段拼接：{id, videoFile, subfolder, logicalStart, logicalEnd}
        segments: [newSegment(5.0)],
        shots: [],
        runSelectEnabled: false,
        runSelection: [],
    };
}

export function createStore({ node, app, api }) {
    const widgets = Object.fromEntries((node.widgets || []).map((w) => [w.name, w]));
    const tlW = widgets.timeline_data;
    const runW = widgets.run_name;
    const taskW = widgets.task_type;
    const gpW = widgets.global_prompt;
    const fpsW = widgets.frame_rate;
    const widthW = widgets.width;
    const heightW = widgets.height;
    const refMaxW = widgets.ref_max_size;
    const totalW = widgets.total_frames;

    let state = load();
    let writing = false;   // commit 写回 tlW 期间屏蔽 callback 触发的 reload
                           //（这版前端 widget.value 赋值会触发 callback，
                           //  不挡会让每次击键都 reload+render，输入框被换掉）
    const listeners = new Set();
    let statusTimer = 0;
    const statusWatchers = new Set();

    function load() {
        try {
            const data = JSON.parse(tlW?.value || "{}");
            if (data && typeof data === "object" && (data.segments || data.global)) {
                const s = { ...defaultState(taskW?.value), ...data };
                s.global = { ...defaultState().global, ...(data.global || {}) };
                s.output = { ...defaultState().output, ...(data.output || {}) };
                s.segments = Array.isArray(data.segments) && data.segments.length
                    ? data.segments.map(normLoadedSegment) : [newSegment(5.0)];
                s.shots = Array.isArray(data.shots) ? data.shots.map(normLoadedShot) : [];
                return s;
            }
        } catch (e) { /* 解析失败回退默认 */ }
        return defaultState(taskW?.value);
    }

    // 兼容 Director 时代的存档：段可能只有 start/length/frameCount 而没有
    // durationSec——渲染层 seg.durationSec.toFixed 会直接崩（"死了 prompt" 的
    // 根因：渲染崩在半路，卡片区根本没出来，编辑全落在别处）
    function normLoadedSegment(s) {
        const base = newSegment(5.0);
        const out = { ...base, ...(s || {}) };
        if (!Number.isFinite(parseFloat(out.durationSec))) {
            const fc = parseInt(out.frameCount ?? out.length, 10);
            const d = setDuration(Number.isFinite(fc) && fc > 0 ? fc / 24 : 5.0);
            out.durationSec = d.durationSec;
            out.frameCount = d.frameCount;
        }
        out.id = out.id || uid();
        out.refs = Array.isArray(out.refs) ? out.refs : [];
        out.refAudios = Array.isArray(out.refAudios) ? out.refAudios : [];
        out.refVideos = Array.isArray(out.refVideos) ? out.refVideos : [];
        out.genImage = out.genImage || { imageFile: "" };
        return out;
    }

    function normLoadedShot(sh) {
        const base = newShot(5.0);
        const out = { ...base, ...(sh || {}) };
        if (!Number.isFinite(parseFloat(out.durationSec))) out.durationSec = 5.0;
        out.id = out.id || uid();
        out.startImage = out.startImage || { imageFile: "" };
        out.endImage = out.endImage || { imageFile: "" };
        return out;
    }

    const mode = () => taskKeyFromLabel(state.global.taskType || taskW?.value);
    const isFl2v = () => mode() === "fl2v";
    const isVideoMode = () => mode() === "v2v" || mode() === "rv2v";
    const resolveRun = () => sanitizeRun(runW ? runW.value : "story");

    // r2v：公共音/视参考在序列化时合进每段（后端 parse_director 只读段级）
    function serialize() {
        const tl = JSON.parse(JSON.stringify(state));
        if (mode() === "r2v") {
            const ga = tl.global.refAudios || [];
            const gv = tl.global.refVideos || [];
            for (const s of tl.segments) {
                s.refAudios = [...ga, ...(s.refAudios || [])];
                s.refVideos = [...gv, ...(s.refVideos || [])];
            }
        }
        tl.output = tl.output || {};
        tl.output.runSelection = state.runSelectEnabled ? state.runSelection : null;
        return JSON.stringify(tl);
    }

    function syncWidgets() {
        if (taskW) taskW.value = labelForTask(mode());
        if (gpW) gpW.value = state.global.prompt || "";
        const fps = parseFloat(fpsW?.value) || 24;
        state.frameRate = fps;
        const { width, height } = resolveSize(state.output.aspectRatio, state.output.megapixels);
        if (widthW) widthW.value = width;
        if (heightW) heightW.value = height;
        if (refMaxW) refMaxW.value = Math.max(width, height);
        const total = isVideoMode()
            ? (state.video?.frames || 0)
            : isFl2v()
            ? (state.shots || []).reduce((a, s) => a + (setDuration(s.durationSec).frameCount), 0)
            : (state.segments || []).reduce((a, s) => a + (s.frameCount || 0), 0);
        if (totalW) totalW.value = Math.max(5, total);
    }

    const notify = (info) => {
        for (const fn of Array.from(listeners)) {
            try { fn(info); } catch (e) { console.error("[sd2] 订阅者异常", e); }
        }
    };

    function commit(opts = {}) {
        // 规范化：帧数贴合网格（输入秒数已在组件层 snap，这里是兜底）。
        // 视频模式的段不管——start/length/durationSec 由 video.js 精确维护，
        // 套网格会让 frameCount 与源区间漂移。
        if (!isVideoMode()) {
            for (const s of state.segments) {
                const d = setDuration(s.durationSec);
                s.durationSec = d.durationSec;
                s.frameCount = d.frameCount;
            }
        }
        for (const sh of state.shots) sh.durationSec = setDuration(sh.durationSec).durationSec;
        if (!AUDIO_MODES.includes(state.output.audioMode)) state.output.audioMode = "generate";
        if (tlW) {
            writing = true;
            try { tlW.value = serialize(); } finally { writing = false; }   // 纯赋值
        }
        syncWidgets();
        app?.graph?.setDirtyCanvas?.(true, true);
        notify({ structural: !!opts.structural });
        for (const fn of Array.from(statusWatchers)) {
            try { fn(); } catch (e) { /* 忽略 */ }
        }
    }

    // 外部改写（工作流加载/撤销）：重新读 widget
    function reload() {
        state = load();
        notify({ structural: true, external: true });
    }

    return {
        get: () => state,
        mode, isFl2v, isVideoMode, resolveRun,
        commit, reload,
        isWriting: () => writing,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        onStatusDirty(fn) { statusWatchers.add(fn); return () => statusWatchers.delete(fn); },
        newSegment, newShot,
        // widget 访问器（main/组件层用）
        tlWidget: () => tlW,
        runWidget: () => runW,
        fpsWidget: () => fpsW,
        taskWidget: () => taskW,

        // /h3_scenedirector/status 请求体：从刚序列化的 JSON 构建，
        // 与后端 parse_director 的行结构逐字段对齐（含 r2v 合并后的音/视）
        statusBody() {
            let tl = {};
            try { tl = JSON.parse(tlW?.value || "{}"); } catch (e) { /* 空 */ }
            const g = tl.global || {};
            const fps = parseFloat(tl.frameRate) || 24;
            const seen = new Set();
            const toCard = (item, kind, category) => {
                const rel = String(item?.imageFile || item?.videoFile || item?.audioFile
                    || item?.fileName || "").trim();
                if (!rel) return null;
                const { image, subfolder } = splitRel(rel);
                const key = kind + ":" + subfolder + "/" + image;
                if (seen.has(key)) return null;
                seen.add(key);
                return { category, name: image.replace(/\.[^.]+$/, ""),
                         image, subfolder, note: "", kind };
            };
            const globalTask = taskKeyFromLabel(g.taskType || taskW?.value);
            const assets = (g.refs || []).map((r) => toCard(r, "image", "参考")).filter(Boolean);

            const rows = [];
            const shots = tl.shots || [];
            if (shots.length && mode() === "fl2v") {
                shots.forEach((sh) => {
                    const si = splitRel(sh.startImage?.imageFile);
                    const ei = splitRel(sh.endImage?.imageFile);
                    rows.push({
                        duration: parseFloat(sh.durationSec) || 5.0,
                        prompt: String(sh.prompt || ""), nonce: String(sh.id || ""),
                        task: "fl2v", audio_mode: null,
                        assets: (sh.refs || []).map((r) => toCard(r, "image", "场景")).filter(Boolean),
                        first_frame: si.image ? si : null,
                        last_frame: ei.image ? ei : null,
                    });
                });
            } else {
                (tl.segments || []).forEach((s) => {
                    const gi = splitRel(s.genImage?.imageFile);
                    rows.push({
                        duration: parseFloat(s.durationSec)
                            || (parseInt(s.frameCount, 10) || 0) / fps || 5.0,
                        prompt: String(s.prompt || ""), nonce: String(s.id || ""),
                        task: taskKeyFromLabel(s.taskType || globalTask),
                        audio_mode: null,
                        assets: [
                            ...(s.refs || []).map((r) => toCard(r, "image", "场景")),
                            ...(s.refAudios || []).map((r) => toCard(r, "audio", "场景")),
                            ...(s.refVideos || []).map((r) => toCard(r, "video", "场景")),
                        ].filter(Boolean),
                        first_frame: gi.image ? gi : null,
                        last_frame: null,
                    });
                });
            }
            return {
                run: resolveRun(),
                global_prompt: String(g.prompt || gpW?.value || ""),
                globals: [],
                assets,
                segments: rows,
            };
        },
    };
}
