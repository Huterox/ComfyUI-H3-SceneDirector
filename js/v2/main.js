// main.js —— v3 前端入口：挂载、尺寸契约、骨架、工具条（模式 tabs + 项目栏）、
// 输出条、模式切换。
//
// 嵌入方式与 v2 逐条对齐（js/AGENTS.md + 本文件头注）：
//   * beforeRegisterNodeDef 包 onNodeCreated（先 orig），loadedGraphNode 兜底；
//     node._h3sdEditor 幂等守卫；
//   * 唯一 DOM widget：div.mmx-host，addDOMWidget 四点高度契约
//     （computeSize / computeLayoutSize / options.getMinHeight / 内联 min-height）；
//   * ensureWidth 在 onDraw/afterResize/onResize/onSelected 四处同步
//     （容器宽 = 节点宽 - 边距），内部全流体布局；
//   * 隐藏原生 widget（纯赋值载体），DOM widget 沉底；
//   * onRemoved 清理：WS 退订、定时器、弹层/遮罩移除。
//
// v3 布局（自上而下）：工具条 → 实时预览 → 全局设置区（library.js：服务状态/
// 全局提示词/资产库）→ 片段卡主区 → 输出条 → 胶片带 → 状态行 → 运行日志。
// 项目栏：项目 = 服务端存档（user/SceneDirector/projects/），项目名即 run 名
// （缓存目录名）；保存/另存为/删除走 /h3_scenedirector/project/* 路由。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { el, TASK_LABELS, taskKeyFromLabel, ASPECTS } from "./util.js";
import { createStore } from "./store.js";
import { createPromptBox } from "./promptbox.js";
import { createCards } from "./cards.js";
import { createLibrary } from "./library.js";
import { createConfig } from "./config.js";
import { createExtras } from "./extras.js";
import { createAgentChat } from "./agentchat.js";
import { createAutopilot } from "./autopilot.js";
import { createVideoEditor } from "./video.js";
import { createLogs } from "./logs.js";

// 皮肤注入（import.meta.url 相对解析，不硬编码包路径）
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./skin.css", import.meta.url).href;
document.head.appendChild(css);

const BASE_H = 960;
const REF_MODELS = {
    gen: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    ref: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
};
const REF_TASKS = new Set(["r2v", "v2v", "rv2v"]);

function uiHeight(ed) {
    // 静态保底高（v1 验证过的姿势）：用户拉高节点时前端会把多余高度分给
    // widget（height:100% 的内容跟着撑满，主区 flex:1 吸收）；内容超出时
    // 主区自己滚。不能用 scrollHeight 动态算——分配高度会回流进测量值，
    // 形成只涨不缩的反馈环（实测 1227 钉死）。
    return BASE_H;
}

function ensureWidth(node) {
    const ed = node._h3sdEditor;
    if (!ed || !ed.container) return;
    const w = Math.max(600, (node.size?.[0] || 940) - 20);   // DOMWidget 默认边距 10×2
    ed.container.style.width = w + "px";
}

// 输出条比例 -> 图里的 ResolutionSelector 节点（Chain/Conditioning 的宽高
// 是从它连线来的，只写 List 自己的 widget 不生效——"比例失效" bug 的根因）。
// 顺带同步 List 的 width/height/ref_max_size widget（store.syncWidgets 在做）。
const RS_ASPECT = {
    "1:1 (方形)": "1:1 (Square)",
    "3:4 (竖版标准)": "3:4 (Portrait Standard)",
    "4:3 (标准)": "4:3 (Standard)",
    "9:16 (竖屏)": "9:16 (Portrait Widescreen)",
    "16:9 (宽屏)": "16:9 (Widescreen)",
    "21:9 (超宽)": "21:9 (Ultrawide)",
};

function pushResolution(ed) {
    try {
        const g = app.graph;
        const nodes = g?._nodes || [];
        const byId = (id) => nodes.find((n) => String(n.id) === String(id));
        const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
        // 优先找连到 Chain width 输入的那个 ResolutionSelector
        let rs = null;
        const wIn = chain?.inputs?.find((i) => /width/i.test(i.name || "") && i.link != null);
        if (wIn) {
            const cand = byId(g.links[wIn.link]?.origin_id);
            if (cand?.type === "ResolutionSelector") rs = cand;
        }
        if (!rs) rs = nodes.find((n) => n.type === "ResolutionSelector");
        if (!rs) return;
        const o = ed.store.get().output;
        const aspectW = rs.widgets?.find((w) => w.name === "aspect_ratio");
        const mpW = rs.widgets?.find((w) => w.name === "megapixels");
        if (aspectW) aspectW.value = RS_ASPECT[o.aspectRatio] || o.aspectRatio;
        if (mpW) mpW.value = o.megapixels;
    } catch (e) { /* 联动失败不影响编辑 */ }
}

// 两个模型位由输出条的「模型联动」下拉配置，随工作流保存（output.modelGen/modelRef）。
function linkModel(node, modeKey, store) {
    try {
        const g = app.graph;
        const nodes = g?._nodes || [];
        const byId = (id) => nodes.find((n) => String(n.id) === String(id));
        const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
        if (chain?.inputs?.[0]?.link != null) {
            const link = g.links[chain.inputs[0].link];
            let src = byId(link?.origin_id);
            let hops = 0;
            while (src && src.type !== "UNETLoader" && hops < 4) {
                const inp = src.inputs?.find((i) => i.link != null && /MODEL/i.test(i.type || ""));
                if (!inp) break;
                src = byId(g.links[inp.link]?.origin_id);
                hops += 1;
            }
            const out = store?.get?.().output || {};
            const want = REF_TASKS.has(modeKey)
                ? (out.modelRef || REF_MODELS.ref) : (out.modelGen || REF_MODELS.gen);
            const unetW = src?.widgets?.find((w) => w.name === "unet_name");
            if (unetW && unetW.options?.values?.includes?.(want) !== false) unetW.value = want;
            const tagW = chain.widgets?.find((w) => w.name === "cache_tag");
            if (tagW) tagW.value = want.replace(/^minimax_h3_|\.safetensors$/g, "");
        }
    } catch (e) { /* 联动失败不影响编辑 */ }
}

// UNETLoader 的可选模型清单（输出条模型联动的候选）
function modelChoices() {
    try {
        const nodes = app.graph?._nodes || [];
        const byId = (id) => nodes.find((n) => String(n.id) === String(id));
        const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
        let src = chain?.inputs?.[0]?.link != null
            ? byId(app.graph.links[chain.inputs[0].link]?.origin_id) : null;
        let hops = 0;
        while (src && src.type !== "UNETLoader" && hops < 4) {
            const inp = src.inputs?.find((i) => i.link != null && /MODEL/i.test(i.type || ""));
            if (!inp) break;
            src = byId(app.graph.links[inp.link]?.origin_id);
            hops += 1;
        }
        const vals = src?.widgets?.find((w) => w.name === "unet_name")?.options?.values;
        return Array.isArray(vals) && vals.length ? vals : null;
    } catch (e) { return null; }
}

function buildSkeleton(ed) {
    const root = el("div", "sd2");

    // --- 工具条：模式 tabs + 项目栏 -------------------------------------------
    const bar = el("div", "sd2-bar");
    bar.appendChild(el("span", "sd2-logo", "SceneDirector"));
    const tabs = el("div", "sd2-tabs");
    for (const label of TASK_LABELS) {
        const key = taskKeyFromLabel(label);
        const b = el("button", "", key);
        b.dataset.task = key;
        b.title = label;
        b.addEventListener("click", () => {
            ed.autopilot?.close();      // 从 AI 视图切回模式内容（无开无操作）
            if (ed.store.mode() === key) return;
            ed.store.setMode(key);      // 每模式独立数据舱：收起当前、切出目标
            ed.selectedIndex = 0;
            linkModel(ed.node, key, ed.store);
        });
        tabs.appendChild(b);
    }
    bar.appendChild(tabs);

    // 项目栏：下拉（载入）+ 保存 + 另存为 + 删除
    bar.appendChild(el("span", "lbl", "项目"));
    const projSel = el("select", "sd2-inp sd2-proj");
    projSel.title = "项目库：一个项目 = 一个场景（分段/资产库/输出设置全量存档），"
        + "项目名即 run 名（缓存目录名）";
    bar.appendChild(projSel);
    const saveBtn = el("button", "sd2-btn", "保存");
    saveBtn.title = "把当前工作台全量状态存到项目库（同名覆盖）";
    const saveAsBtn = el("button", "sd2-btn", "另存为");
    saveAsBtn.title = "换个名字存成新项目（当前场景随之改名）";
    const delProjBtn = el("button", "sd2-btn sm danger", "删");
    delProjBtn.title = "从项目库删除当前项目（缓存目录不动）";
    bar.appendChild(saveBtn);
    bar.appendChild(saveAsBtn);
    bar.appendChild(delProjBtn);

    const sum = el("span", "sd2-sum");
    bar.appendChild(sum);
    bar.appendChild(el("span", "sp"));
    const aiBtn = el("button", "sd2-btn ai", "✨ AI 自动创作");
    aiBtn.title = "从一句话想法到整条分镜：agent 自动规划/生图/写提示词"
        + "（与模式页签同级的一个内容舱，再点一次切回）";
    aiBtn.addEventListener("click", () => {
        if (ed.autopilot?.isOpen) ed.autopilot.close();
        else ed.autopilot?.open();
    });
    bar.appendChild(aiBtn);
    const addBtn = el("button", "sd2-btn primary", "+ 分镜");
    addBtn.addEventListener("click", () => {
        const s = ed.store.get();
        if (ed.store.isFl2v()) s.shots.push(ed.store.newShot(5.0));
        else s.segments.push(ed.store.newSegment(5.0));
        ed.selectedIndex = (ed.store.isFl2v() ? s.shots : s.segments).length - 1;
        ed.store.commit({ structural: true });
    });
    const rerollBtn = el("button", "sd2-btn", "全部重摇");
    rerollBtn.title = "所有段换新 id：整条链缓存作废，下次全量重渲";
    rerollBtn.addEventListener("click", () => {
        const s = ed.store.get();
        for (const seg of s.segments) seg.id = ed.store.newSegment().id;
        for (const sh of s.shots) sh.id = ed.store.newShot().id;
        ed.store.commit({ structural: true });
    });
    const selBtn = el("button", "sd2-btn", "选择运行");
    selBtn.title = "开启后只渲染勾选的段";
    selBtn.addEventListener("click", () => {
        const s = ed.store.get();
        s.runSelectEnabled = !s.runSelectEnabled;
        if (s.runSelectEnabled && !s.runSelection.length) s.runSelection = [ed.selectedIndex];
        ed.store.commit({ structural: true });
    });
    bar.appendChild(addBtn);
    bar.appendChild(rerollBtn);
    bar.appendChild(selBtn);
    root.appendChild(bar);

    const live = el("div", "sd2-live hidden");
    root.appendChild(live);
    const globalArea = el("div", "sd2-global");
    root.appendChild(globalArea);
    const main = el("div", "sd2-main");
    root.appendChild(main);

    // --- 项目栏逻辑 -------------------------------------------------------------
    const CUR = "__current__";   // 下拉里"未入库的当前场景"占位值
    async function refreshProjects() {
        let list = [];
        try {
            const r = await api.fetchApi("/h3_scenedirector/projects");
            if (r.ok) list = (await r.json()).projects || [];
        } catch (e) { /* 后端忙：保持现状 */ }
        const run = ed.store.resolveRun();
        projSel.innerHTML = "";
        const names = list.map((p) => p.name);
        if (!names.includes(run)) {
            projSel.appendChild(new Option("（未保存）" + run, CUR));
        }
        for (const p of list) projSel.appendChild(new Option(p.name, p.name));
        projSel.value = names.includes(run) ? run : CUR;
    }
    async function saveProject(saveAs) {
        let name = ed.store.resolveRun();
        if (saveAs) {
            const n = window.prompt("另存为项目名：", name);
            if (!n || !n.trim()) return;
            name = n.trim();
            const w = ed.store.runWidget();
            if (w) w.value = name;
            ed.store.commit();
        }
        const btn = saveAs ? saveAsBtn : saveBtn;
        const old = btn.textContent;
        btn.disabled = true;
        try {
            const r = await api.fetchApi("/h3_scenedirector/project/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, state: ed.store.projectState() }),
            });
            if (!r.ok) throw new Error("HTTP " + r.status);
            btn.textContent = "已保存 ✓";
            await refreshProjects();
        } catch (e) {
            btn.textContent = "保存失败 ✗";
            console.error("[sd2] 项目保存失败", e);
        } finally {
            btn.disabled = false;
            setTimeout(() => { btn.textContent = old; }, 1400);
        }
    }
    async function loadProject(name) {
        try {
            const r = await api.fetchApi("/h3_scenedirector/project/load", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            const doc = await r.json();
            if (!r.ok) throw new Error(doc.error || ("HTTP " + r.status));
            if (ed.store.applyProject(doc.state)) {   // reload → structural 重绘
                linkModel(ed.node, ed.store.mode(), ed.store);
                pushResolution(ed);
                ed.selectedIndex = 0;
            }
        } catch (e) {
            console.error("[sd2] 项目载入失败", e);
            await refreshProjects();   // 回弹选择
        }
    }
    saveBtn.addEventListener("click", () => saveProject(false));
    saveAsBtn.addEventListener("click", () => saveProject(true));
    delProjBtn.addEventListener("click", async () => {
        const name = ed.store.resolveRun();
        if (!window.confirm("从项目库删除「" + name + "」？（缓存目录与当前编辑不受影响）")) return;
        try {
            await api.fetchApi("/h3_scenedirector/project/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
        } catch (e) { /* 忽略 */ }
        await refreshProjects();
    });
    projSel.addEventListener("change", () => {
        const v = projSel.value;
        if (v && v !== CUR && v !== ed.store.resolveRun()) loadProject(v);
        else refreshProjects();
    });

    // --- 输出条 ------------------------------------------------------------------
    const out = el("div", "sd2-out");
    const o = () => ed.store.get().output;
    out.appendChild(el("span", "lbl", "宽高比"));
    const asp = el("select", "sd2-inp");
    for (const a of ASPECTS) asp.appendChild(new Option(a[0], a[0]));
    asp.value = o().aspectRatio;
    asp.addEventListener("change", () => {
        o().aspectRatio = asp.value;
        ed.store.commit();
        pushResolution(ed);
    });
    out.appendChild(asp);
    out.appendChild(el("span", "lbl", "百万像素"));
    const mp = el("input", "sd2-inp num");
    mp.type = "number"; mp.min = "0.1"; mp.max = "16"; mp.step = "0.1"; mp.value = o().megapixels;
    mp.addEventListener("change", () => {
        o().megapixels = Math.min(16, Math.max(0.1, parseFloat(mp.value) || 1.0));
        mp.value = o().megapixels;
        ed.store.commit();
        pushResolution(ed);
    });
    out.appendChild(mp);
    out.appendChild(el("span", "lbl", "帧率"));
    const fps = el("input", "sd2-inp num");
    fps.type = "number"; fps.min = "1"; fps.max = "240"; fps.value = 24;
    fps.addEventListener("change", () => {
        const w = ed.store.fpsWidget();
        if (w) w.value = Math.min(240, Math.max(1, parseFloat(fps.value) || 24));
        fps.value = ed.store.fpsWidget()?.value ?? 24;
        ed.store.commit();
    });
    out.appendChild(fps);
    const contLbl = el("label", "lbl chk");
    const cont = document.createElement("input");
    cont.type = "checkbox"; cont.checked = o().continuityEnabled;
    cont.addEventListener("change", () => { o().continuityEnabled = cont.checked; ed.store.commit(); });
    contLbl.appendChild(cont);
    contLbl.appendChild(document.createTextNode(" 段间引导"));
    contLbl.title = "开启：上一段尾帧+音频 latent 钉入下一段（特征上下文窗口衔接）";
    out.appendChild(contLbl);
    const mkChk = (label, key, tip) => {
        const lb = el("label", "lbl chk");
        const ck = document.createElement("input");
        ck.type = "checkbox"; ck.checked = !!o()[key];
        ck.addEventListener("change", () => { o()[key] = ck.checked; ed.store.commit(); });
        lb.appendChild(ck);
        lb.appendChild(document.createTextNode(" " + label));
        lb.title = tip;
        return lb;
    };
    out.appendChild(mkChk("色彩一致", "colorLock",
        "全片逐帧校色：整段均值/方差对齐第 1 段，压制逐段渲染的白平衡/曝光漂移（光照需要渐变的片子别开）"));
    out.appendChild(mkChk("亮度一致", "lumaLock",
        "逐段平均亮度归一到第 1 段（Rec.601，比例夹 0.55–1.8）：只稳亮度，不动色相与对比度结构"));
    out.appendChild(el("span", "lbl", "上下文帧数"));
    const ctxN = el("input", "sd2-inp num");
    ctxN.type = "number"; ctxN.min = "5"; ctxN.max = "39"; ctxN.value = o().continuityOverlapFrames;
    ctxN.addEventListener("change", () => {
        o().continuityOverlapFrames = Math.min(39, Math.max(5, parseInt(ctxN.value, 10) || 22));
        ctxN.value = o().continuityOverlapFrames;
        ed.store.commit();
    });
    out.appendChild(ctxN);
    out.appendChild(el("span", "lbl", "声音"));
    const au = el("select", "sd2-inp");
    au.appendChild(new Option("生成声音", "generate"));
    au.appendChild(new Option("使用原声", "original"));
    au.appendChild(new Option("静音", "mute"));
    au.value = o().audioMode;
    au.addEventListener("change", () => { o().audioMode = au.value; ed.store.commit(); });
    out.appendChild(au);
    // 模型联动（v3 从增强器面板挪到输出条；切模式自动换 UNETLoader）
    const opts = modelChoices();
    const modelSel = (label, field, fallback) => {
        const sel = el("select", "sd2-inp model");
        for (const v of (opts || [fallback])) {
            sel.appendChild(new Option(v.replace(/^minimax_h3_|\.safetensors$/g, ""), v));
        }
        const cur = o()[field] || fallback;
        if (![...sel.options].some((x) => x.value === cur)) sel.appendChild(new Option(cur, cur));
        sel.value = cur;
        sel.title = "切模式时自动换 UNETLoader 的模型（此处只是选文件，切换是自动的）";
        sel.addEventListener("change", () => {
            o()[field] = sel.value;
            ed.store.commit();
            ed.linkModel?.(ed.store.mode());
        });
        return sel;
    };
    out.appendChild(el("span", "lbl", "模型"));
    out.appendChild(modelSel("生成系", "modelGen", REF_MODELS.gen));
    out.appendChild(modelSel("参考系", "modelRef", REF_MODELS.ref));
    out.appendChild(el("span", "sp"));
    const liveBtn = el("button", "sd2-btn", "实时预览：开");
    liveBtn.addEventListener("click", () => {
        ed.liveOn = !ed.liveOn;
        liveBtn.textContent = ed.liveOn ? "实时预览：开" : "实时预览：关";
        liveBtn.classList.toggle("active", ed.liveOn);
        if (!ed.liveOn) live.classList.add("hidden");
    });
    liveBtn.classList.add("active");
    out.appendChild(liveBtn);
    const exp = el("select", "sd2-inp");
    exp.appendChild(new Option("全部导出", "all"));
    exp.appendChild(new Option("仅导出勾选段", "selected"));
    exp.value = o().exportMode;
    exp.title = "导出方式（分段导出=每段单独输出，在 Chain/落盘侧生效）";
    exp.addEventListener("change", () => { o().exportMode = exp.value; ed.store.commit(); });
    out.appendChild(exp);
    root.appendChild(out);

    return { root, bar, tabs, projSel, saveBtn, saveAsBtn, delProjBtn, aiBtn, sum,
             addBtn, rerollBtn, selBtn, live, globalArea, main, out, asp, mp, fps,
             cont, ctxN, au, exp, refreshProjects };
}

function initEditor(node) {
    if (node._h3sdEditor) return node._h3sdEditor;
    const container = node._h3sdDomWidget?.element;
    if (!container) return null;

    const store = createStore({ node, app, api });
    const ed = {
        node, store, container,
        selectedIndex: 0,
        chatState: {},   // 各目标（段/镜/全局）的对话改写面板状态（跨重绘存活）
        liveOn: true,
        statuses: null,  // 最近一次 /status 响应
    };
    node._h3sdEditor = ed;

    ed.els = buildSkeleton(ed);
    container.appendChild(ed.els.root);

    ed.promptbox = createPromptBox(ed, { api });
    ed.library = createLibrary(ed, { api });
    ed.els.globalArea.appendChild(ed.library.element);
    ed.config = createConfig(ed, { api });
    ed.cards = createCards(ed, { api });
    ed.extras = createExtras(ed, { api });
    ed.els.root.appendChild(ed.extras.element);    // 胶片带：输出条之后
    ed.els.root.appendChild(ed.extras.statusEl);   // 状态行
    ed.agentchat = createAgentChat(ed, { api });   // 项目 agent 对话改写（🪄）
    ed.autopilot = createAutopilot(ed, { api });   // AI 自动创作抽屉（✨）
    ed.videoEditor = createVideoEditor(ed, { api });
    ed.logs = createLogs(ed, { api });
    ed.els.root.appendChild(ed.logs.element);      // 运行日志条：沉底

    // 模式主区渲染
    ed.render = () => {
        const s = store.get();
        const mode = store.mode();
        // 工具条
        ed.els.tabs.querySelectorAll("button").forEach((b) => {
            b.classList.toggle("on", b.dataset.task === mode);
        });
        const segs = store.isFl2v() ? s.shots : s.segments;
        const total = segs.reduce((a2, x) => a2 + (parseFloat(x.durationSec) || 5), 0);
        const cached = ed.statuses ? ed.statuses.statuses.filter((x) => x.cached).length : null;
        ed.els.sum.textContent = "共 " + segs.length + " 段 · 总长 " + Math.floor(total / 60)
            + ":" + String(Math.floor(total % 60)).padStart(2, "0")
            + (cached != null ? " · 已缓存 " + cached + "/" + segs.length : "");
        ed.els.selBtn.classList.toggle("active", !!s.runSelectEnabled);
        ed.selectedIndex = Math.max(0, Math.min(ed.selectedIndex, segs.length - 1));

        // 全局设置区（资产库）+ 主区
        ed.library.render();
        ed.cards.render(ed.els.main);
        ed.extras.render();
        app.graph?.setDirtyCanvas?.(true, true);
    };

    store.subscribe((info) => { if (info.structural) ed.render(); });

    // widget 值外部恢复（工作流加载/撤销重做）；
    // commit 自己写回时 callback 也会触发——用 isWriting 挡住，不然每次击键
    // 都会 reload+render，输入框被替换成新元素（实测：打字只进一个字符）
    const tlW = store.tlWidget();
    if (tlW) {
        const origCb = tlW.callback;
        tlW.callback = function () {
            const out = origCb?.apply(this, arguments);
            if (!store.isWriting()) {
                store.reload();
                ed.render();
                ed.els.refreshProjects();
            }
            return out;
        };
    }

    linkModel(node, store.mode(), store);
    ed.linkModel = (key) => linkModel(node, key, store);
    pushResolution(ed);   // 加载即把输出条的比例/像素推到图里的 ResolutionSelector
    // 旧存档迁移落盘一次：tl JSON 还没有 library 键时轻量 commit，
    // 让后续所有消费者（后端/状态查询）都拿到 v4.1 结构
    try {
        const raw = JSON.parse(store.tlWidget()?.value || "{}");
        if (!Array.isArray(raw.library)) store.commit();
    } catch (e) { /* 解析失败不挡加载 */ }
    ed.render();
    ed.els.refreshProjects();
    ed.library.refreshConfig();
    ed.extras.start();
    return ed;
}

// --- 挂载（v2 对齐） -----------------------------------------------------------

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, -4];
}

app.registerExtension({
    name: "h3.scenedirector.v2",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "H3SceneDirectorList") return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated ? onCreated.apply(this, arguments) : undefined;

            const container = document.createElement("div");
            container.className = "mmx-host";
            container.style.minHeight = uiHeight(null) + "px";
            container.style.setProperty("--comfy-widget-min-height", uiHeight(null) + "px");
            const self = this;
            const widget = this.addDOMWidget("h3sd_ui", "div", container, {
                getValue: () => "",
                setValue: () => {},
                getMinHeight: () => uiHeight(self._h3sdEditor),
                hideOnZoom: false,
                onDraw() { ensureWidth(self); },
                afterResize() { ensureWidth(self); },
            });
            // 高度契约（v1 验证过的姿势）：只给 getMinHeight 保底，
            // 不覆写 computeSize/computeLayoutSize——覆写会把高度钉死成
            // 内容高，用户拉高节点时内容不再跟随（实测：覆写后 630 钉死，
            // 删掉后跟随到 1263）。
            if (widget.options) widget.options.getMinHeight = () => uiHeight(self._h3sdEditor);
            widget.element = container;
            self._h3sdDomWidget = widget;

            // 隐藏全部原生 widget（载体仍在，只是不显示），DOM widget 沉底
            for (const w of [...(this.widgets || [])]) {
                if (w !== widget) hideWidget(w);
            }
            this.widgets.splice(this.widgets.indexOf(widget), 1);
            this.widgets.push(widget);

            ensureWidth(self);
            setTimeout(() => { initEditor(self); ensureWidth(self); }, 0);
            return r;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            ensureWidth(this);
            return onResize?.apply(this, arguments);
        };
        const onSelected = nodeType.prototype.onSelected;
        nodeType.prototype.onSelected = function () {
            ensureWidth(this);
            return onSelected?.apply(this, arguments);
        };
        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            try { this._h3sdEditor?.extras?.dispose?.(); } catch (e) { /* 忽略 */ }
            try { this._h3sdEditor?.logs?.dispose?.(); } catch (e) { /* 忽略 */ }
            try { this._h3sdEditor?.config?.dispose?.(); } catch (e) { /* 忽略 */ }
            try { this._h3sdEditor?.autopilot?.dispose?.(); } catch (e) { /* 忽略 */ }
            try {
                document.querySelectorAll(".sd2-refpick, .sd2-asset-edit").forEach((p) => p.remove());
            } catch (e) { /* 忽略 */ }
            return origRemoved?.apply(this, arguments);
        };
    },
    loadedGraphNode(node) {
        if (node.comfyClass !== "H3SceneDirectorList") return;
        // 恢复存档：widget 已就位，编辑器异步建好；隐藏原生 widget + 沉底
        setTimeout(() => {
            try {
                const dom = node._h3sdDomWidget;
                if (dom) {
                    for (const w of [...(node.widgets || [])]) {
                        if (w !== dom) hideWidget(w);
                    }
                    const i = node.widgets.indexOf(dom);
                    if (i >= 0) { node.widgets.splice(i, 1); node.widgets.push(dom); }
                }
                const ed = initEditor(node);
                if (ed) {
                    ed.store.reload();
                    ed.render();
                    ed.els.refreshProjects();
                }
                ensureWidth(node);
            } catch (e) {
                console.warn("[sd2] loadedGraphNode 失败（忽略）", e);
            }
        }, 300);
    },
});
