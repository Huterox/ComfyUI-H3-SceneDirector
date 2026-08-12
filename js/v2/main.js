// main.js —— v2 前端入口：挂载、尺寸契约、骨架、工具条、输出条、模式切换。
//
// 嵌入方式与 Director 逐条对齐（js/AGENTS.md + 本文件头注）：
//   * beforeRegisterNodeDef 包 onNodeCreated（先 orig），loadedGraphNode 兜底；
//     node._h3sdEditor 幂等守卫；
//   * 唯一 DOM widget：div.mmx-host，addDOMWidget 四点高度契约
//     （computeSize / computeLayoutSize / options.getMinHeight / 内联 min-height）；
//   * ensureWidth 在 onDraw/afterResize/onResize/onSelected 四处同步
//     （容器宽 = 节点宽 - 边距），内部全流体布局；
//   * 隐藏原生 widget（纯赋值载体），DOM widget 沉底；
//   * onRemoved 清理：WS 退订、定时器、元素移除。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { el, TASK_LABELS, taskKeyFromLabel, ASPECTS } from "./util.js";
import { createStore } from "./store.js";
import { createCards } from "./cards.js";
import { createExtras } from "./extras.js";
import { createEnhancer } from "./enhance.js";
import { createVideoEditor } from "./video.js";

// 皮肤注入（import.meta.url 相对解析，不硬编码包路径）
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./skin.css", import.meta.url).href;
document.head.appendChild(css);

const MIN_W = 880;
const BASE_H = 700;
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

// 任务模式 -> UNET 模型联动（沿 Chain 的 MODEL 输入找 UNETLoader，兼容中间隔补丁节点）。
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

function buildSkeleton(ed) {
    const root = el("div", "sd2");

    // 工具条
    const bar = el("div", "sd2-bar");
    bar.appendChild(el("span", "sd2-logo", "SceneDirector"));
    const tabs = el("div", "sd2-tabs");
    for (const label of TASK_LABELS) {
        const key = taskKeyFromLabel(label);
        const b = el("button", "", key);
        b.dataset.task = key;
        b.title = label;
        b.addEventListener("click", () => {
            if (ed.store.mode() === key) return;
            ed.store.setMode(key);      // 每模式独立数据舱：收起当前、切出目标
            ed.selectedIndex = 0;
            linkModel(ed.node, key, ed.store);
        });
        tabs.appendChild(b);
    }
    bar.appendChild(tabs);
    bar.appendChild(el("span", "lbl", "场景"));
    const runInput = el("input", "sd2-run");
    runInput.type = "text";
    runInput.title = "run 名 = 缓存目录名（output/h3_scenedirector/<run>/）；换名即开新场景";
    runInput.value = ed.store.resolveRun();
    runInput.addEventListener("input", () => {
        const w = ed.store.runWidget();
        if (w) w.value = runInput.value;
        ed.store.commit();
    });
    bar.appendChild(runInput);
    const sum = el("span", "sd2-sum");
    bar.appendChild(sum);
    bar.appendChild(el("span", "sp"));
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
    const main = el("div", "sd2-main");
    root.appendChild(main);
    const globalArea = el("div", "sd2-global");
    root.appendChild(globalArea);

    // 输出条
    const out = el("div", "sd2-out");
    const o = () => ed.store.get().output;
    out.appendChild(el("span", "lbl", "宽高比"));
    const asp = el("select", "sd2-inp");
    for (const a of ASPECTS) asp.appendChild(new Option(a[0], a[0]));
    asp.value = o().aspectRatio;
    asp.addEventListener("change", () => { o().aspectRatio = asp.value; ed.store.commit(); });
    out.appendChild(asp);
    out.appendChild(el("span", "lbl", "百万像素"));
    const mp = el("input", "sd2-inp num");
    mp.type = "number"; mp.min = "0.1"; mp.max = "16"; mp.step = "0.1"; mp.value = o().megapixels;
    mp.addEventListener("change", () => {
        o().megapixels = Math.min(16, Math.max(0.1, parseFloat(mp.value) || 1.0));
        mp.value = o().megapixels;
        ed.store.commit();
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
    out.appendChild(el("span", "sp"));
    // 模型联动：两系模型位（切模式自动换 UNETLoader 的 unet_name）
    const modelOpts = (() => {
        try {
            const nodes = app.graph?._nodes || [];
            const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
            const link = chain?.inputs?.[0]?.link != null ? g_links(app.graph, chain.inputs[0].link) : null;
            let src = link ? byId(app.graph, link.origin_id) : null;
            let hops = 0;
            while (src && src.type !== "UNETLoader" && hops < 4) {
                const inp = src.inputs?.find((i) => i.link != null && /MODEL/i.test(i.type || ""));
                if (!inp) break;
                src = byId(app.graph, g_links(app.graph, inp.link)?.origin_id);
                hops += 1;
            }
            const vals = src?.widgets?.find((w) => w.name === "unet_name")?.options?.values;
            return Array.isArray(vals) && vals.length ? vals : null;
        } catch (e) { return null; }
        function g_links(g, id) { return g.links[id]; }
        function byId(g, id) { return (g._nodes || []).find((n) => String(n.id) === String(id)); }
    })();
    const mkModelSel = (label, field, fallback) => {
        out.appendChild(el("span", "lbl", label));
        const sel = el("select", "sd2-inp model");
        const opts = modelOpts || [fallback];
        for (const v of opts) sel.appendChild(new Option(v.replace(/^minimax_h3_|\.safetensors$/g, ""), v));
        const cur = o()[field] || fallback;
        if (![...sel.options].some((x) => x.value === cur)) sel.appendChild(new Option(cur, cur));
        sel.value = cur;
        sel.title = label + "（切模式时自动换 UNETLoader 的模型）";
        sel.addEventListener("change", () => {
            o()[field] = sel.value;
            ed.store.commit();
            linkModel(ed.node, ed.store.mode(), ed.store);
        });
        out.appendChild(sel);
        return sel;
    };
    mkModelSel("生成系模型", "modelGen", REF_MODELS.gen);
    mkModelSel("参考系模型", "modelRef", REF_MODELS.ref);
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

    return { root, bar, tabs, runInput, sum, addBtn, rerollBtn, selBtn,
             live, main, globalArea, out, asp, mp, fps, cont, ctxN, au, exp };
}

function initEditor(node) {
    if (node._h3sdEditor) return node._h3sdEditor;
    const container = node._h3sdDomWidget?.element;
    if (!container) return null;

    const store = createStore({ node, app, api });
    const ed = {
        node, store, container,
        selectedIndex: 0,
        preview: null,     // {text, target: 段号|"global"|"shot:N", name}
        liveOn: true,
        statuses: null,    // 最近一次 /status 响应
    };
    node._h3sdEditor = ed;

    ed.els = buildSkeleton(ed);
    container.appendChild(ed.els.root);

    ed.cards = createCards(ed, { api });
    ed.extras = createExtras(ed, { api });
    ed.els.root.appendChild(ed.extras.element);    // 胶片带：输出条之后
    ed.els.root.appendChild(ed.extras.statusEl);   // 状态行
    ed.enhancer = createEnhancer(ed, { api });
    ed.els.root.appendChild(ed.enhancer.element);
    ed.videoEditor = createVideoEditor(ed, { api });

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

        // 主区 + 全局区按模式
        ed.cards.render(ed.els.main, ed.els.globalArea);
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
            }
            return out;
        };
    }

    linkModel(node, store.mode());
    ed.render();
    ed.extras.start();
    return ed;
}

// --- 挂载（Director 对齐） ---------------------------------------------------

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
                }
                ensureWidth(node);
            } catch (e) {
                console.warn("[sd2] loadedGraphNode 失败（忽略）", e);
            }
        }, 300);
    },
});
