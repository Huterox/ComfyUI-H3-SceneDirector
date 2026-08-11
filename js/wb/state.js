// state.js —— 工作台的单一数据源（v2：Director 引擎适配层）。
//
// 与旧版相同的组件契约：get() / subscribe() / commit(opts) / flush()，
// 组件（timeline/stage/detail/settings/assets/progress）一律不感知
// Director 的存在，只操作下面的旧形状状态：
//
//   { run, global_prompt, globals: [{category, content}],
//     assets: [{category, name, image, subfolder, note}],
//     segments: [{duration, prompt, nonce, assets: [...], firstFrame}],
//     mode, _ed }
//
// 双向翻译：
//   * Director 段 id 就是后端 seg_hash 的 nonce —— 重摇 = 换新 id；
//   * 分类设定表/资产卡元数据用【类别】/【资产·类别】标记行编进
//     tl.global.prompt（后端只把它当文本拼到每段前面，模型也能读懂类别）；
//   * 带图资产卡按顺序映射 tl.global.refs（第 k 张卡 = 图片 k+1），
//     段级图钉映射 seg.refs（编号接在全局带图资产之后，对齐 <Picture N>）；
//   * 写回后调 ed.commit(false, {syncTimeline:true}) 让 Director 序列化
//     timeline_data（隐藏 widget 载体不变）。
//
// 外部同步：包装 ed.commit —— Director 侧任何修改（增强器写提示词、
// 智能分割、模型联动）提交后重读时间线，快照变了就整体通知组件重绘。
//
// 血泪教训沿用：绝不对 widget.value 用 Object.defineProperty。

import { durationToClampedMiniMaxFrames, newBatchSegment } from "../minimax_gen_timeline.js";

// 资产分类与设定标签的预设项（datalist 用，用户可自由输入别的值）
export const ASSET_CATEGORIES = ["角色", "场景", "物品", "风格"];
export const SETTING_CATEGORIES = [
    "视觉风格", "世界观", "角色设定", "走位与机位",
    "镜头语言", "音乐基调", "音效基调", "其他",
];

export function sanitizeRun(name) {
    let v = String(name ?? "").trim().replace(/[\\/]/g, "_").replace(/^\.+/, "");
    if (v.startsWith("{") || v.startsWith("[")) v = "story";
    return v.slice(0, 64) || "story";
}

// 段重摇用 nonce（Date.now 规格）；同时就是 Director 段 id 的新值
export function newNonce() {
    return String(Date.now()) + Math.random().toString(36).slice(2, 6);
}

export function normSetting(g) {
    return {
        category: String(g?.category ?? "").trim() || "通用",
        content: String(g?.content ?? "").trim(),
    };
}

export function normAsset(a, fallbackCategory = "角色") {
    return {
        category: String(a?.category ?? "").trim() || fallbackCategory,
        name: String(a?.name ?? "").trim(),
        image: String(a?.image ?? "").trim(),
        subfolder: String(a?.subfolder ?? "").trim(),
        note: String(a?.note ?? "").trim(),
    };
}

export function normSegment(s) {
    const dur = parseFloat(s?.duration);
    return {
        duration: Number.isFinite(dur) ? dur : 5.0,
        prompt: String(s?.prompt ?? ""),
        nonce: String(s?.nonce ?? "") || newNonce(),
        assets: Array.isArray(s?.assets)
            ? s.assets.map((a) => normAsset(a, "场景"))
            : [],
        firstFrame: s?.firstFrame?.image
            ? { image: String(s.firstFrame.image), subfolder: String(s.firstFrame.subfolder || "") }
            : null,
    };
}

// 全局带图资产数：段级图钉的 <Picture N> 编号从它之后开始
export function globalPicCount(state) {
    return (state.assets || []).filter((a) => a.image).length;
}

// --- 全局提示词文本 <-> 分类设定/资产元数据 -------------------------------
//
// 文本格式（编进 tl.global.prompt，后端原样拼到每段提示词前面）：
//   通用自由文本（可多行，第一个标记行之前的全部内容）
//   【视觉风格】内容……
//   【资产·角色】无畏机甲 | 重型爆弹炮、古代涂装
// 第 k 个【资产·】行与第 k 张带图全局参考（tl.global.refs）配对；
// 没有配图的资产行 = 纯文字卡（只把文本并进全局）。

const SETTING_RE = /^【([^】]+)】(.*)$/;
const ASSET_PREFIX = "资产·";

function parseGlobalText(text) {
    const rows = [];
    const general = [];
    for (const line of String(text || "").split("\n")) {
        const m = SETTING_RE.exec(line.trim());
        if (m) rows.push({ cat: m[1].trim(), body: (m[2] || "").trim() });
        else if (!rows.length) general.push(line);
        // 标记行之后的普通行忽略（防止设定行被意外拆散）
    }
    return { general: general.join("\n").trim(), rows };
}

function composeGlobalText(general, globals, assets) {
    const lines = [];
    const g0 = String(general || "").trim();
    if (g0) lines.push(g0);
    for (const g of globals || []) {
        const row = normSetting(g);
        if (row.content) lines.push("【" + row.category + "】" + row.content);
    }
    for (const a of assets || []) {
        const card = normAsset(a);
        if (!card.image && !card.name && !card.note) continue;
        const body = (card.name || "") + (card.note ? " | " + card.note : "");
        lines.push("【" + ASSET_PREFIX + card.category + "】" + body.trim());
    }
    return lines.join("\n");
}

// --- Director 引用条目 <-> 资产卡 ----------------------------------------

function refToCard(ref) {
    const rel = String(ref?.imageFile || ref?.fileName || "").trim().replace(/\\/g, "/");
    if (!rel) return null;
    let sub = "", name = rel;
    if (rel.includes("/")) [sub, name] = rel.rsplit("/", 1);
    return { image: name, subfolder: sub || "", rel };
}

function cardToRef(card, index) {
    const rel = card.subfolder ? card.subfolder + "/" + card.image : card.image;
    return { index, imageFile: rel, imageB64: "" };
}

// 与后端 payload._task_key_from_label 对齐：'t2v — 文生视频' -> 't2v'
function taskKeyFromLabel(value) {
    let v = String(value || "").split(",[object Object]")[0].trim();
    if (v.includes(" · ")) v = v.split(" · ", 1)[0].trim();
    for (const sep of [" — ", " —— ", " - ", " – "]) {
        if (v.includes(sep)) return v.split(sep, 1)[0].trim();
    }
    return v || "t2v";
}

// ---------------------------------------------------------------------------
// 状态仓库：一个 H3SceneDirectorList 节点一个实例。
// ---------------------------------------------------------------------------

export function createStore({ ed, runWidget, app }) {
    let state = readFromDirector();
    let lastSnapshot = snapshotOf(state);
    let timer = 0;
    let writing = false;   // 我们自己写回触发的 ed.commit 不再回读
    const listeners = new Set();

    function currentTaskKey() {
        return String(ed.getTaskKey?.() || "t2v").toLowerCase();
    }

    // Director -> 旧形状
    function readFromDirector() {
        const tl = ed.timeline || {};
        const g = tl.global || {};
        const parsed = parseGlobalText(g.prompt || ed.globalPromptWidget?.value || "");
        const metaRows = parsed.rows.filter((r) => r.cat.startsWith(ASSET_PREFIX));
        const settingRows = parsed.rows.filter((r) => !r.cat.startsWith(ASSET_PREFIX));

        const refs = (g.refs || []).map(refToCard).filter(Boolean);
        const assets = [];
        const n = Math.max(refs.length, metaRows.length);
        for (let k = 0; k < n; k++) {
            const ref = refs[k];
            const meta = metaRows[k];
            const cat = meta ? meta.cat.slice(ASSET_PREFIX.length) || "角色" : "角色";
            let name = "", note = "";
            if (meta) {
                const parts = meta.body.split(" | ");
                name = (parts[0] || "").trim();
                note = parts.slice(1).join(" | ").trim();
            }
            assets.push(normAsset({
                category: cat,
                name: name || (ref ? ref.image.replace(/\.[^.]+$/, "") : ""),
                image: ref ? ref.image : "",
                subfolder: ref ? ref.subfolder : "",
                note,
            }));
        }

        const segs = (tl.segments || []).map((s) => {
            const dur = parseFloat(s.durationSec);
            const fc = parseInt(s.frameCount ?? s.length, 10);
            const pins = (s.refs || [])
                .map((r) => ({ r, card: refToCard(r) }))
                .filter((x) => x.card)
                .sort((a, b) => Number(a.r.index ?? 0) - Number(b.r.index ?? 0))
                .map((x) => normAsset({
                    category: "场景", name: "",
                    image: x.card.image, subfolder: x.card.subfolder, note: "",
                }));
            const ff = refToCard(s.genImage || {});
            return normSegment({
                duration: Number.isFinite(dur) ? dur : (Number.isFinite(fc) ? fc / 24 : 5.0),
                prompt: s.prompt,
                nonce: s.id,
                assets: pins,
                firstFrame: ff ? { image: ff.image, subfolder: ff.subfolder } : null,
            });
        });

        return {
            run: sanitizeRun(runWidget ? runWidget.value : "story"),
            global_prompt: parsed.general,
            globals: settingRows.map((r) => normSetting({ category: r.cat, content: r.body })),
            assets,
            segments: segs,
            mode: currentTaskKey(),
            _ed: ed,
        };
    }

    // 旧形状 -> Director（写回后由调用方触发 ed.commit）
    function writeToDirector(s) {
        const tl = ed.timeline;
        const g = tl.global || (tl.global = { refs: [], refAudios: [], refVideos: [] });
        g.prompt = composeGlobalText(s.global_prompt, s.globals, s.assets);
        // r2v：图片参考由 Director 公共面板管（音频/视频槽也在那里），
        // 适配层不动 refs，只同步文本；t2v/i2v： refs 完全由资产卡决定
        if (currentTaskKey() !== "r2v") {
            g.refs = (s.assets || [])
                .filter((a) => a.image)
                .map((a, k) => cardToRef(normAsset(a), k));
        }
        const picOffset = (g.refs || []).filter((r) => r && (r.imageFile || r.fileName)).length;

        const segs = tl.segments || (tl.segments = []);
        if (!(s.segments || []).length) {
            // 至少保留一段（Director 批量不允许空时间线）
            s.segments.push(normSegment({ duration: 5.0, prompt: "", nonce: newNonce() }));
        }
        (s.segments || []).forEach((seg, i) => {
            const src = normSegment(seg);
            if (!segs[i]) segs[i] = newBatchSegment({ durationSec: src.duration });
            const d = segs[i];
            d.prompt = src.prompt;
            const cur = parseFloat(d.durationSec);
            if (!Number.isFinite(cur) || Math.abs(cur - src.duration) > 1e-6) {
                const r = durationToClampedMiniMaxFrames(src.duration, 24);
                d.durationSec = r.durationSec;
                d.frameCount = r.frames;
                d.length = r.frames;
            }
            if (src.nonce && src.nonce !== d.id) d.id = src.nonce;
            d.refs = src.assets
                .filter((a) => a.image)
                .map((a, k) => cardToRef(a, picOffset + k));
            d.genImage = src.firstFrame
                ? { imageFile: src.firstFrame.subfolder
                    ? src.firstFrame.subfolder + "/" + src.firstFrame.image
                    : src.firstFrame.image }
                : { imageFile: "" };
        });
        segs.length = Math.max(0, (s.segments || []).length);
        tl.run = sanitizeRun(s.run);
    }

    function snapshotOf(s) {
        // 只盯会影响展示/缓存的字段，忽略无关抖动
        return JSON.stringify({
            g: s.global_prompt, rows: s.globals, a: s.assets,
            segs: (s.segments || []).map((x) => [x.duration, x.prompt, x.nonce,
                (x.assets || []).map((p) => p.image + "@" + p.subfolder),
                x.firstFrame ? x.firstFrame.image + "@" + x.firstFrame.subfolder : ""]),
            mode: s.mode,
        });
    }

    const writeNow = () => {
        timer = 0;
        writing = true;
        try {
            writeToDirector(state);
            ed.commit(false, { syncTimeline: true });
        } finally {
            writing = false;
        }
        lastSnapshot = snapshotOf(state);
        app?.graph?.setDirtyCanvas?.(true, true);
    };

    const scheduleWrite = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(writeNow, 250);   // 打字防抖：250ms 落盘一次
    };

    const notify = (info) => {
        for (const fn of Array.from(listeners)) {
            try { fn(info); } catch (e) { console.error("[h3-workbench] 订阅者异常", e); }
        }
    };

    // Director 侧提交（增强器/分割/模式切换/外部操作）→ 回读同步
    const origCommit = ed.commit?.bind(ed);
    if (origCommit && !ed._h3wbCommitWrapped) {
        ed._h3wbCommitWrapped = true;
        ed.commit = (...args) => {
            const out = origCommit(...args);
            if (!writing) {
                try {
                    const fresh = readFromDirector();
                    const snap = snapshotOf(fresh);
                    if (snap !== lastSnapshot) {
                        state.run = fresh.run;   // run 以 widget 为准，不回抢
                        state.global_prompt = fresh.global_prompt;
                        state.globals = fresh.globals;
                        state.assets = fresh.assets;
                        state.segments = fresh.segments;
                        state.mode = fresh.mode;
                        lastSnapshot = snap;
                        notify({ structural: true, external: true });
                    }
                } catch (e) { /* 同步失败不挡 Director */ }
            }
            return out;
        };
    }

    return {
        get: () => state,

        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        commit(opts = {}) {
            scheduleWrite();
            notify({ structural: !!opts.structural, external: false });
        },

        flush() {
            if (timer) { clearTimeout(timer); timer = 0; }
            writeNow();
        },
    };
}

// POST /h3_scenedirector/status 的请求体：复刻后端 parse_director 的行
// 结构（hash 字段逐个对齐），否则缓存状态会全部误判为"待渲染"。
// 全局资产直接从 ed.timeline.global.refs 读（与 make_list 同源），
// 段行携带 task/audio_mode/first_frame 等 v4 字段。
export function statusBody(state, runName) {
    const ed = state._ed;
    const tl = ed?.timeline || {};
    const g = tl.global || {};
    const seen = new Set();
    const toAsset = (item) => {
        const card = refToCard(item);
        if (!card) return null;
        const key = card.subfolder + "/" + card.image;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
            category: "参考",
            name: card.image.replace(/\.[^.]+$/, ""),
            image: card.image, subfolder: card.subfolder, note: "", kind: "image",
        };
    };
    const globalTask = taskKeyFromLabel(g.taskType || ed?.taskTypeWidget?.value);
    const assets = (g.refs || []).map(toAsset).filter(Boolean);

    const segments = (tl.segments || []).map((s, i) => {
        const storeSeg = (state.segments || [])[i];
        const dur = parseFloat(storeSeg?.duration);
        const ff = refToCard(s.genImage || {});
        return {
            duration: Number.isFinite(dur) ? dur : 5.0,
            prompt: String(s.prompt ?? ""),
            nonce: String(s.id ?? storeSeg?.nonce ?? ""),
            task: taskKeyFromLabel(s.taskType || globalTask),
            audio_mode: null,
            assets: (s.refs || []).map((item) => {
                const card = refToCard(item);
                return card ? {
                    category: "场景", name: "",
                    image: card.image, subfolder: card.subfolder, note: "", kind: "image",
                } : null;
            }).filter(Boolean),
            first_frame: ff ? { image: ff.image, subfolder: ff.subfolder } : null,
            last_frame: null,
        };
    });

    return {
        run: sanitizeRun(runName),
        global_prompt: String(g.prompt ?? ed?.globalPromptWidget?.value ?? ""),
        globals: [],
        assets,
        segments,
    };
}
