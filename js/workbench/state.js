// state.js —— 工作台的单一数据源。
//
// 职责：
//   * 把 segments widget 里的 payload JSON 解析成规范化的状态对象
//     （容错：JSON 解析失败、裸段列表等旧格式都给默认值）；
//   * 订阅模式：组件改完状态调 commit()，由这里防抖写回 widget 并广播
//     变更（structural 标记区分"结构变化需要整体重绘"和"打字中只写回"）；
//   * 序列化时做与后端 storyline/payload.py 一致的过滤（空内容设定行、
//     空资产卡、空提示词段都不落盘），保证 widget 里的 JSON 永远是后端
//     能直接吃的 v3 载荷。
//
// 血泪教训：绝不对 widget.value 用 Object.defineProperty（前端把它定义成
// 不可配置属性，重定义会抛 "Cannot redefine property: value" 搞崩工作流
// 加载）。这里只普通赋值 widget.value = ...。

// payload schema v3（与后端 payload.SCHEMA 对齐，仅作记录/调试用）
export const PAYLOAD_SCHEMA = 3;

// 资产分类与设定标签的预设项（datalist 用，用户可自由输入别的值）
export const ASSET_CATEGORIES = ["角色", "场景", "物品", "风格"];
export const SETTING_CATEGORIES = [
    "视觉风格", "世界观", "角色设定", "走位与机位",
    "镜头语言", "音乐基调", "音效基调", "其他",
];

// 与后端 payload.sanitize_run 保持一致：目录名不允许 / \ 和前导点，
// 把整个 payload 误粘进 run 名栏的情况回退 "story"。
export function sanitizeRun(name) {
    let v = String(name ?? "").trim().replace(/[\\/]/g, "_").replace(/^\.+/, "");
    if (v.startsWith("{") || v.startsWith("[")) v = "story";
    return v.slice(0, 64) || "story";
}

// 段重摇用 nonce（规格要求 Date.now()）；新建段追加随机后缀避免同毫秒撞名
export function newNonce() {
    return String(Date.now()) + Math.random().toString(36).slice(2, 6);
}

// --- 规范化（镜像后端 norm_globals / norm_assets / parse_payload） ----------

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
    };
}

// 解析 widget 里的 JSON。接受工作台载荷对象或裸的 [{duration, prompt}] 段
// 列表（旧格式）；任何解析失败都回退到空载荷，绝不让工作流加载崩掉。
export function parsePayload(text) {
    let data;
    try {
        data = JSON.parse(text || "{}");
    } catch (e) {
        data = {};
    }
    if (Array.isArray(data)) data = { segments: data };
    if (!data || typeof data !== "object") data = {};
    const nonce = parseInt(data.run_nonce, 10);
    return {
        run: sanitizeRun(data.run),
        run_nonce: Number.isFinite(nonce) ? nonce : 0,
        global_prompt: String(data.global_prompt ?? ""),
        globals: Array.isArray(data.globals) ? data.globals.map(normSetting) : [],
        assets: Array.isArray(data.assets) ? data.assets.map((a) => normAsset(a)) : [],
        segments: Array.isArray(data.segments) ? data.segments.map(normSegment) : [],
    };
}

// 序列化回 widget 的载荷。过滤规则与后端一致：空内容设定行、
// 图/名/备注全空的资产卡、空提示词段都不写入。
export function serializePayload(state) {
    const cleanAsset = (a, fb) => normAsset(a, fb);
    const validAsset = (a) => a.image || a.name || a.note;
    return JSON.stringify({
        run: sanitizeRun(state.run),
        run_nonce: Number.isFinite(+state.run_nonce) ? +state.run_nonce : 0,
        global_prompt: String(state.global_prompt ?? ""),
        globals: (state.globals || []).map(normSetting).filter((g) => g.content),
        assets: (state.assets || []).map((a) => cleanAsset(a)).filter(validAsset),
        segments: (state.segments || [])
            .filter((s) => String(s.prompt ?? "").trim())
            .map((s) => {
                const n = normSegment(s);
                n.assets = n.assets.filter(validAsset);
                return n;
            }),
    });
}

// POST /h3_scenedirector/status 的请求体：payload 子集。段不按 prompt 过滤
// （后端按行索引对齐 statuses，UI 上的空提示词新段也要有徽标位置），
// 但每段的键必须齐全（后端 seg_hash 直接取 duration/prompt/nonce）。
export function statusBody(state, runName) {
    return {
        run: sanitizeRun(runName),
        global_prompt: String(state.global_prompt ?? ""),
        globals: (state.globals || []).map(normSetting),
        assets: (state.assets || []).map((a) => normAsset(a)),
        segments: (state.segments || []).map((s) => {
            const dur = parseFloat(s?.duration);
            return {
                duration: Number.isFinite(dur) ? dur : 5.0,
                prompt: String(s?.prompt ?? ""),
                nonce: String(s?.nonce ?? ""),
                assets: Array.isArray(s?.assets)
                    ? s.assets.map((a) => normAsset(a, "场景"))
                    : [],
            };
        }),
    };
}

// 全局带图资产数：段级图钉的 <Picture N> 编号从它之后开始。
export function globalPicCount(state) {
    return (state.assets || []).filter((a) => a.image).length;
}

// ---------------------------------------------------------------------------
// 状态仓库：一个 H3SceneDirectorList 节点一个实例。
// ---------------------------------------------------------------------------
//
// 组件直接改 get() 返回的对象（引用稳定），改完调 commit()：
//   commit()                    打字等轻量修改：防抖写回 widget，不重绘
//   commit({ structural: true }) 增/删/移动等结构修改：写回 + 通知整体重绘
//
// 外部改写（工作流加载 / 撤销 / 粘贴）走 loadFromValue()，由入口在
// onConfigure 里调用；onSerialize 前先 flush() 把防抖中的编辑落盘。

export function createStore({ widget, app, text }) {
    let state = parsePayload(text);
    let lastSerialized = serializePayload(state);
    let timer = 0;                 // 防抖定时器（0 = 无待写）
    const listeners = new Set();

    const writeNow = () => {
        timer = 0;
        lastSerialized = serializePayload(state);
        widget.value = lastSerialized;   // 纯赋值，绝不 defineProperty
        if (typeof widget.callback === "function") widget.callback(widget.value);
        app?.graph?.setDirtyCanvas?.(true, true);
    };

    const scheduleWrite = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(writeNow, 250);   // 打字防抖：250ms 落盘一次
    };

    const notify = (info) => {
        for (const fn of Array.from(listeners)) {
            try {
                fn(info);
            } catch (e) {
                console.error("[h3-workbench] 订阅者异常", e);
            }
        }
    };

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

        // 立即写回（序列化/保存工作流前调用，防止防抖中的编辑丢失）
        flush() {
            if (timer) clearTimeout(timer);
            writeNow();
        },

        // 外部值恢复：返回状态是否真的变了
        loadFromValue(v) {
            if (timer) { clearTimeout(timer); timer = 0; }
            const text = String(v ?? "");
            if (text === lastSerialized) return false;
            state = parsePayload(text);
            lastSerialized = text;
            notify({ structural: true, external: true });
            return true;
        },
    };
}
