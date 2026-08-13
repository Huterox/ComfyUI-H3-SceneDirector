// store.js —— v2/v3 单一数据源：timeline JSON 模型 + commit/序列化 + 状态体。
//
// 契约（js/AGENTS.md）：
//   * timeline_data 隐藏 widget 是序列化载体，写值只准普通赋值；
//   * 一切修改走 commit()，由它统一序列化 + 同步关联 widget + 广播；
//   * JSON schema 与后端 parse_director 逐字段对齐（后端零改动）；
//   * v3 资产库：state.library 是全量卡（pinned 常驻 / 按需），段用
//     libRefs（"类别·名字" 引用键）挂载按需卡；序列化时派生旧键
//     （global.refs/refAudios/refVideos = pinned 子集）保持可读，
//     后端以 library 为准（pinned 注入每段，不再做 r2v 段级合并）。
import { uid, taskKeyFromLabel, labelForTask, setDuration, resolveSize,
         sanitizeRun, splitRel, assetKey, cardFile } from "./util.js";

const AUDIO_MODES = ["generate", "original", "mute"];

function newSegment(durationSec = 5.0) {
    const d = setDuration(durationSec);
    return { id: uid(), durationSec: d.durationSec, frameCount: d.frameCount,
             prompt: "", taskType: "", refs: [], refAudios: [], refVideos: [],
             libRefs: [],
             genImage: { imageFile: "" } };
}

function newShot(durationSec = 5.0) {
    const d = setDuration(durationSec);
    return { id: uid(), durationSec: d.durationSec, prompt: "", refs: [],
             libRefs: [],
             startImage: { imageFile: "" }, endImage: { imageFile: "" } };
}

function defaultState(taskLabel) {
    return {
        version: 4,
        frameRate: 24,
        global: { taskType: taskKeyFromLabel(taskLabel), prompt: "",
                  refs: [], refAudios: [], refVideos: [] },
        library: [],   // v3 资产库：[{id,category,name,imageFile,note,kind,pinned}]
        output: { aspectRatio: "16:9 (宽屏)", megapixels: 1.0,
                  continuityEnabled: true, continuityOverlapFrames: 22,
                  audioMode: "generate", exportMode: "all",
                  colorLock: false, lumaLock: false,
                  // 模型联动（输出条可配，随工作流保存）
                  modelGen: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                  modelRef: "minimax_h3_ref2va_pruned_int8_convrot.safetensors" },
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
    let modes = loadModes();   // 每模式独立数据舱：切模式各用各的，互不串
    let writing = false;   // commit 写回 tlW 期间屏蔽 callback 触发的 reload
                           //（这版前端 widget.value 赋值会触发 callback，
                           //  不挡会让每次击键都 reload+render，输入框被换掉）
    const listeners = new Set();
    let statusTimer = 0;
    const statusWatchers = new Set();

    // --- 资产库迁移（v3）-------------------------------------------------------
    // 旧存档（无 library 键）：global.refs/refAudios/refVideos -> pinned 常驻卡；
    // 段级 refs/refAudios/refVideos -> 按需卡 + 段 libRefs（按旧 index 排序，
    // 编号与旧版 <Picture N> 语义一致）。迁移后清空旧键，单一数据源只有 library。

    function normLibCard(c) {
        const kinds = ["image", "audio", "video"];
        const kind = kinds.includes(String(c?.kind || "").toLowerCase())
            ? String(c.kind).toLowerCase() : "image";
        const card = {
            id: c?.id || uid(),
            category: String(c?.category || "").trim() || "参考",
            name: String(c?.name || "").trim(),
            imageFile: String(c?.imageFile || c?.videoFile || c?.audioFile || "").trim(),
            note: String(c?.note || "").trim(),
            kind,
            pinned: c?.pinned !== false,
        };
        if (!card.name && card.imageFile) {
            card.name = splitRel(card.imageFile).image.replace(/\.[^.]+$/, "");
        }
        return (card.imageFile || card.name || card.note) ? card : null;
    }

    function migrateLibrary(data) {
        if (Array.isArray(data.library)) {
            const out = [];
            const keys = new Set();
            for (const raw of data.library) {
                const card = normLibCard(raw);
                if (!card) continue;
                // 键唯一兜底：存档损坏出现重键时自动改名（后端只认首个匹配）
                let name = card.name, i = 2;
                while (keys.has(assetKey(card))) {
                    card.name = name + "(" + i++ + ")";
                }
                keys.add(assetKey(card));
                out.push(card);
            }
            return out;
        }
        const lib = [];
        const byKey = new Map();
        const byFile = new Map();   // kind:rel -> card（同文件复用同卡）
        const byIndex = (a, b) => (a?.index ?? 0) - (b?.index ?? 0);
        const addCard = (category, rel, kind, pinned, name) => {
            rel = String(rel || "").trim();
            if (!rel) return "";
            const fk = kind + ":" + rel;
            if (byFile.has(fk)) {
                const c0 = byFile.get(fk);
                if (pinned) c0.pinned = true;   // 段级+全局同文件：并入常驻
                return assetKey(c0);
            }
            let base = String(name || "").trim()
                || splitRel(rel).image.replace(/\.[^.]+$/, "");
            let n = base, i = 2;
            while (byKey.has(category + "·" + n)) n = base + "(" + i++ + ")";
            const card = normLibCard({ category, name: n, imageFile: rel, kind, pinned });
            lib.push(card);
            byKey.set(assetKey(card), card);
            byFile.set(fk, card);
            return assetKey(card);
        };
        const g = data.global || {};
        (g.refs || []).slice().sort(byIndex)
            .forEach((r) => addCard("参考", r.imageFile, "image", true, r.name));
        (g.refAudios || []).slice().sort(byIndex)
            .forEach((r) => addCard("音频", r.audioFile, "audio", true, r.name));
        (g.refVideos || []).slice().sort(byIndex)
            .forEach((r) => addCard("视频", r.videoFile, "video", true, r.name));
        const segRefs = (s, withAv) => {
            const keys = [];
            const push = (k) => { if (k && !keys.includes(k)) keys.push(k); };
            (s.refs || []).slice().sort(byIndex)
                .forEach((r) => push(addCard("参考", r.imageFile, "image", false, r.name)));
            if (withAv) {
                (s.refAudios || []).slice().sort(byIndex)
                    .forEach((r) => push(addCard("音频", r.audioFile, "audio", false, r.name)));
                (s.refVideos || []).slice().sort(byIndex)
                    .forEach((r) => push(addCard("视频", r.videoFile, "video", false, r.name)));
            }
            s.libRefs = keys;
            s.refs = []; s.refAudios = []; s.refVideos = [];
        };
        (data.segments || []).forEach((s) => { if (s && typeof s === "object") segRefs(s, true); });
        (data.shots || []).forEach((s) => { if (s && typeof s === "object") segRefs(s, false); });
        g.refs = []; g.refAudios = []; g.refVideos = [];
        return lib;
    }

    function load() {
        try {
            const data = JSON.parse(tlW?.value || "{}");
            if (data && typeof data === "object" && (data.segments || data.global)) {
                const library = migrateLibrary(data);   // 就地清旧键、写 libRefs
                const s = { ...defaultState(taskW?.value), ...data };
                s.global = { ...defaultState().global, ...(data.global || {}) };
                s.output = { ...defaultState().output, ...(data.output || {}) };
                s.library = library;
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
        out.libRefs = Array.isArray(out.libRefs)
            ? [...new Set(out.libRefs.map((k) => String(k || "").trim()).filter(Boolean))]
            : [];
        out.genImage = out.genImage || { imageFile: "" };
        return out;
    }

    function normLoadedShot(sh) {
        const base = newShot(5.0);
        const out = { ...base, ...(sh || {}) };
        if (!Number.isFinite(parseFloat(out.durationSec))) out.durationSec = 5.0;
        out.id = out.id || uid();
        out.libRefs = Array.isArray(out.libRefs)
            ? [...new Set(out.libRefs.map((k) => String(k || "").trim()).filter(Boolean))]
            : [];
        out.startImage = out.startImage || { imageFile: "" };
        out.endImage = out.endImage || { imageFile: "" };
        return out;
    }

    // --- 每模式数据舱 ---------------------------------------------------------
    // 切片 = 模式私有的段/镜组/源视频；global（全局提示词+公共参考）全模式共享。
    // 序列化时 `_modes` 作为随行字段写进 JSON（后端 parse_director 只认固定键，
    // 多余键自动忽略，无副作用）。

    function defaultSlice(key) {
        return {
            segments: [newSegment(5.0)],
            shots: key === "fl2v" ? [newShot(5.0)] : [],
            video: { fileName: "", subfolder: "", frames: 0 },
            videoClips: [],
        };
    }

    function loadModes() {
        try {
            const data = JSON.parse(tlW?.value || "{}");
            if (data && typeof data === "object" && data._modes && typeof data._modes === "object") {
                return data._modes;
            }
        } catch (e) { /* 无则空 */ }
        return {};
    }

    function currentSlice() {
        return {
            segments: state.segments,
            shots: state.shots,
            video: state.video,
            videoClips: state.videoClips,
        };
    }

    function setMode(key) {
        const cur = mode();
        if (cur === key) return;
        modes[cur] = currentSlice();                 // 收好当前模式的
        const next = modes[key] || defaultSlice(key); // 取出/新建目标模式的
        state.segments = next.segments && next.segments.length ? next.segments : [newSegment(5.0)];
        state.shots = Array.isArray(next.shots) ? next.shots : [];
        state.video = next.video || { fileName: "", subfolder: "", frames: 0 };
        state.videoClips = Array.isArray(next.videoClips) ? next.videoClips : [];
        state.global.taskType = key;
        commit({ structural: true });
    }

    const mode = () => taskKeyFromLabel(state.global.taskType || taskW?.value);
    const isFl2v = () => mode() === "fl2v";
    const isVideoMode = () => mode() === "v2v" || mode() === "rv2v";
    const resolveRun = () => sanitizeRun(runW ? runW.value : "story");

    // 序列化：library 是全量资产（后端以它为准）；旧键 global.refs/refAudios/
    // refVideos 从 pinned 子集派生（可读性/旧消费者），v3 不再做 r2v 段级
    // 音视合并——pinned 卡由后端统一注入每段参考块。
    function serialize() {
        const tl = JSON.parse(JSON.stringify(state));
        const g = tl.global;
        g.refs = []; g.refAudios = []; g.refVideos = [];
        let pi = 0, ai = 0, vi = 0;
        for (const c of tl.library || []) {
            const f = cardFile(c);
            if (!f || c.pinned === false) continue;
            if (c.kind === "audio") g.refAudios.push({ index: ai++, audioFile: f, name: c.name });
            else if (c.kind === "video") g.refVideos.push({ index: vi++, videoFile: f, name: c.name });
            else g.refs.push({ index: pi++, imageFile: f, name: c.name });
        }
        tl.output = tl.output || {};
        tl.output.runSelection = state.runSelectEnabled ? state.runSelection : null;
        tl._modes = { ...modes, [mode()]: currentSlice() };   // 数据舱随行（后端忽略）
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
        modes = loadModes();
        notify({ structural: true, external: true });
    }

    return {
        get: () => state,
        mode, isFl2v, isVideoMode, resolveRun, setMode,
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

        // /h3_scenedirector/status 请求体：从刚序列化的 JSON 构建。
        // v3 口径：assets = 资产库全量（含 pinned），段行带 refs（引用键），
        // 与后端 routes.status 的 seg_hash(i, row, library) 判定逐字段对齐。
        statusBody() {
            let tl = {};
            try { tl = JSON.parse(tlW?.value || "{}"); } catch (e) { /* 空 */ }
            const g = tl.global || {};
            const fps = parseFloat(tl.frameRate) || 24;
            const assets = (Array.isArray(tl.library) ? tl.library : []).map((c) => {
                const { image, subfolder } = splitRel(cardFile(c));
                return { category: c.category || "参考", name: c.name || "",
                         image, subfolder, note: c.note || "",
                         kind: c.kind || "image", pinned: c.pinned !== false };
            }).filter((a) => a.image || a.name || a.note);
            const globalTask = taskKeyFromLabel(g.taskType || taskW?.value);

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
                        refs: (sh.libRefs || []).map(String),
                        assets: [],
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
                        refs: (s.libRefs || []).map(String),
                        assets: [],
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

        // --- 项目库（服务端 user/SceneDirector/projects/） ----------------------
        // 项目 = 工作台全量状态（序列化后的 timeline 对象 + run 名）。
        // run 名即项目名，也是缓存目录名（output/h3_scenedirector/<run>/）。
        projectState() {
            return { timeline: JSON.parse(serialize()), run: resolveRun() };
        },
        applyProject(st) {
            if (!st || typeof st !== "object" || !st.timeline) return false;
            if (tlW) tlW.value = JSON.stringify(st.timeline);   // 纯赋值（契约）
            if (st.run && runW) runW.value = String(st.run);
            reload();
            return true;
        },
    };
}

// 新建空白项目用：默认时间线（t2v，单空段），与 serialize() 的结构兼容
// （_modes 缺省由 loadModes 兜底）
export { defaultState };
