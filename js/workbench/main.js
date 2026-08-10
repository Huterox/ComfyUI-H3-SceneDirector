// main.js —— v3 装配：Director 式主从布局。
//
//   工具条（场景名/摘要/+分镜/全部重摇）
//   预览区 stage（点播窗 + 片段信息侧栏）
//   胶片时间线 timeline（刻度尺 + 段卡轨道）
//   滚动区（详情面板 detail + 折叠的设定表/资产卡）
//   底部状态行 progress
//
// 内核/交互分离：组件只碰 store（state.js）与 backend（api.js），
// 不感知节点内部；节点只做数据载体（segments/run_name widget）。
//
// 尺寸契约（前端 1.48.7 实测）：DOM widget 的高度由前端布局系统经
// addDOMWidget 的 getMinHeight/getMaxHeight（或 CSS 变量）决定，
// widget.computeSize 在新前端里不被调用。因此本工作台：
//   * 用 getMinHeight 保证最小高度（节点永远不会被挤没）；
//   * 不设 maxHeight——用户拉高节点时内容跟着撑满（height:100%），
//     中间滚动区自己滚动；
//   * 不覆写 computeSize、不调 setSize、不测量、不要 ResizeObserver。
//     节点尺寸完全是用户/存档的事，我们永远不碰。
//
// 挂载/同步模式沿用验证过的姿势（隐藏 segments widget 做序列化载体、
// DOM widget 值代理、run_name callback 普通赋值包装、onRemoved dispose）。
// 血泪教训：绝不对 widget.value 用 Object.defineProperty。

import { createStore, sanitizeRun, newNonce } from "./state.js";
import { createBackend } from "./api.js";
import { createSettings } from "./settings.js";
import { createAssets } from "./assets.js";
import { createTimeline } from "./timeline.js";
import { createStage } from "./stage.js";
import { createDetail } from "./detail.js";
import { createProgress } from "./progress.js";

const STYLE_ID = "h3-storydirector-style";
// 工作台的最小可用高度（前端布局保证不会比这个更小）
const MIN_H = 620;

// 样式只注入一次（多个工作台节点共享）。用 <link> 经 import.meta.url
// 相对本模块解析，避免硬编码 /extensions/<包名>/ 路径。
function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = new URL("./style.css", import.meta.url).href;
    document.head.appendChild(link);
}

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function attachWorkbench(node, { app, api }) {
    if (node._h3wb) return node._h3wb;   // 防重复挂载
    const segWidget = node.widgets?.find((w) => w.name === "segments");
    const runWidget = node.widgets?.find((w) => w.name === "run_name");
    if (!segWidget || typeof node.addDOMWidget !== "function") return null;
    ensureStyle();

    // 原始 payload widget 隐藏但保留（序列化载体）；-4 抵消隐藏后的行距
    segWidget.hidden = true;
    segWidget.computeSize = () => [0, -4];

    const backend = createBackend(api);
    const store = createStore({ widget: segWidget, app, text: segWidget.value });

    // run 名解析与后端一致：run_name widget 非空时优先，否则用 payload.run
    const resolveRun = () => {
        const w = runWidget ? String(runWidget.value ?? "").trim() : "";
        return sanitizeRun(w || store.get().run);
    };

    // --- 选中态（UI 级状态，不进 payload） ------------------------------------
    let selected = 0;
    const clampSel = () => {
        const n = store.get().segments.length;
        selected = Math.max(0, Math.min(selected, n - 1));
    };

    // --- DOM 骨架 ------------------------------------------------------------
    const root = el("div", "h3wb");

    // 工具条
    const bar = el("div", "h3wb-bar");
    bar.appendChild(el("span", "h3wb-logo", "StoryDirector"));
    bar.appendChild(el("span", "lbl", "场景"));
    const runInput = el("input", "h3wb-run");
    runInput.type = "text";
    runInput.title = "run 名 = 缓存目录名（output/h3_storydirector/<run>/）；换名即开新场景";
    runInput.value = runWidget ? String(runWidget.value ?? "") : store.get().run;
    runInput.addEventListener("input", () => {
        const v = runInput.value;
        if (runWidget) runWidget.value = v;
        const t = v.trim();
        if (t) store.get().run = sanitizeRun(t);
        store.commit();
    });
    const sumSpan = el("span", "h3wb-sum");
    bar.appendChild(runInput);
    bar.appendChild(sumSpan);
    bar.appendChild(el("span", "h3wb-sp"));
    const addBtn = el("button", "h3wb-btn primary", "+ 分镜");
    addBtn.title = "在时间线末尾加一段 5 秒分镜";
    const rerollAllBtn = el("button", "h3wb-btn", "全部重摇");
    rerollAllBtn.title = "run_nonce + 1：整条链的缓存全部作废，下次执行全量重渲";
    bar.appendChild(addBtn);
    bar.appendChild(rerollAllBtn);
    root.appendChild(bar);

    // 组件
    const timeline = createTimeline({
        store, backend, getRun: resolveRun,
        getSelected: () => selected,
        onSelect: (i) => { selected = i; refreshSelection(); },
        onSummary: (t) => { sumSpan.textContent = t; },
    });
    const stage = createStage({
        store, backend, getRun: resolveRun,
        getSelected: () => selected,
        onAction: onSegAction,
    });
    const detail = createDetail({ store, backend, getSelected: () => selected });
    const settings = createSettings({ store });
    const assets = createAssets({ store, backend });
    const progress = createProgress({
        backend, store, resolveRun,
        onStatus: (res) => { timeline.applyStatus(res); stage.applyStatus(res); },
    });

    root.appendChild(stage.element);
    root.appendChild(timeline.element);

    // 滚动区：详情面板 + 折叠的设定表/资产卡（高度不够时这里滚）
    const scroller = el("div", "h3wb-scroll");
    scroller.appendChild(detail.element);

    const fold1 = el("details", "h3wb-fold");
    const sum1 = el("summary");
    const body1 = el("div", "body");
    body1.appendChild(settings.element);
    fold1.appendChild(sum1);
    fold1.appendChild(body1);
    scroller.appendChild(fold1);

    const fold2 = el("details", "h3wb-fold");
    const sum2 = el("summary");
    const body2 = el("div", "body");
    body2.appendChild(assets.element);
    fold2.appendChild(sum2);
    fold2.appendChild(body2);
    scroller.appendChild(fold2);

    root.appendChild(scroller);
    root.appendChild(progress.element);

    // --- 段操作（预览区侧栏按钮的回调） ---------------------------------------
    function onSegAction(action, i) {
        const segs = store.get().segments;
        const seg = segs[i];
        if (!seg) return;
        if (action === "reroll") {
            seg.nonce = newNonce();
            store.commit();
        } else if (action === "left" && i > 0) {
            [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
            selected = i - 1;
            store.commit({ structural: true });
        } else if (action === "right" && i < segs.length - 1) {
            [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
            selected = i + 1;
            store.commit({ structural: true });
        } else if (action === "del") {
            segs.splice(i, 1);
            clampSel();
            store.commit({ structural: true });
        }
    }

    addBtn.addEventListener("click", () => {
        const segs = store.get().segments;
        segs.push({ duration: 5.0, prompt: "", nonce: newNonce(), assets: [] });
        selected = segs.length - 1;
        store.commit({ structural: true });
    });
    rerollAllBtn.addEventListener("click", () => {
        const s = store.get();
        s.run_nonce = (Number.isFinite(+s.run_nonce) ? +s.run_nonce : 0) + 1;
        store.commit();
    });

    // --- 渲染 ----------------------------------------------------------------
    function updateFoldSums() {
        const s = store.get();
        // 设定表摘要：直接列出分类名，不收起来也能看到有哪些设定
        const cats = ["通用"].concat(s.globals.map((g) => g.category).filter(Boolean));
        sum1.innerHTML = "<b>场景设定表</b>　" + cats.join(" · ")
            + "　<span class='lbl'>(改动全链重渲)</span>";
        // 资产卡摘要：带图卡的缩略图直接贴进摘要行（P 序号可见）
        const pics = s.assets.filter((a) => a.image);
        sum2.innerHTML = "<b>场景资产卡</b>　" + s.assets.length + " 张 · " + pics.length
            + " 张带图　";
        pics.forEach((a, k) => {
            const img = document.createElement("img");
            img.src = backend.inputURL(a);
            img.title = "P" + (k + 1) + " " + (a.name || a.image);
            img.style.cssText = "width:22px;height:22px;object-fit:cover;border-radius:3px;"
                + "vertical-align:-6px;margin-right:2px;border:1px solid var(--line);";
            sum2.appendChild(img);
        });
        sum2.appendChild(el("span", "lbl",
            pics.length ? "（P1..P" + pics.length + "，改动全链重渲）" : "（改动全链重渲）"));
    }

    function refreshSelection() {
        clampSel();
        timeline.render();
        stage.setSegment(selected);
        detail.setSegment(selected);
    }

    function renderAll() {
        clampSel();
        settings.render();
        assets.render();
        timeline.render();
        stage.setSegment(selected);
        detail.setSegment(selected);
        updateFoldSums();
        progress.reapply();
        app.graph?.setDirtyCanvas?.(true, true);
    }

    // 统一订阅：结构变更整体重绘；任何变更都防抖重查缓存状态
    store.subscribe((info) => {
        if (info.structural) renderAll();
        progress.refreshSoon();
    });

    // DOM widget：值代理到隐藏的 segments widget；高度契约交给前端布局：
    // 尺寸契约（前端 1.48.7 bundle 实测）：
    //   * 高度：getMinHeight 保底，不设上限，内容 height:100% 撑满 +
    //     中间滚动区自滚；
    //   * 宽度：前端会量一次元素宽并钉成内联值（prepareElement），
    //     所以由我们显式钉成 节点宽-边距，并挂 afterResize 随拖动同步。
    //   不覆写 computeSize，不调 setSize 改高度，不要 ResizeObserver。
    const HMARGIN = 10;   // DOMWidgetImpl.DEFAULT_MARGIN
    const syncWidth = () => {
        root.style.width = Math.max((node.size?.[0] || 920) - HMARGIN * 2, 600) + "px";
    };
    const domWidget = node.addDOMWidget("h3_workbench", "div", root, {
        getValue: () => segWidget.value,
        setValue: (v) => { segWidget.value = v; store.loadFromValue(v); },
        serialize: false,
        getMinHeight: () => MIN_H,
        afterResize: syncWidth,   // 节点拖动变宽时跟着变宽
    });
    domWidget.serialize = false;
    syncWidth();

    // run_name widget 保持可见：包装 callback 同步回工作台（普通赋值包装，
    // 不是 defineProperty），用户在节点原生 UI 上改名也能跟上
    let origRunCb = runWidget?.callback;
    if (runWidget) {
        runWidget.callback = function () {
            const out = origRunCb?.apply(this, arguments);
            runInput.value = String(runWidget.value ?? "");
            const t = runInput.value.trim();
            if (t) store.get().run = sanitizeRun(t);
            store.commit();
            return out;
        };
    }

    // --- WS 事件（dispose 时必须退订） ---------------------------------------
    const offProgress = backend.onProgress((d) => {
        if (d.run && d.run === resolveRun()) {
            progress.setProgress(d);
            // 每段渲完工件就落盘：进度事件到了就防抖拉一次状态，
            // 让海报/点播随渲染逐段出现，不用等整轮结束
            progress.refreshSoon();
        }
    });
    const offExecEnd = backend.onExecutionEnd(() => progress.onDone());

    // --- 对外实例接口（入口经 node._h3wb 调用） ------------------------------
    function loadFromValue(v) {
        if (runWidget) runInput.value = String(runWidget.value ?? "");
        store.loadFromValue(v);       // 变了会经订阅触发 renderAll
        progress.refreshSoon();
        syncWidth();   // configure 恢复了存档尺寸，宽度跟着走
    }

    function dispose() {
        offProgress();
        offExecEnd();
        progress.dispose();
        detail.dispose();
        if (runWidget) runWidget.callback = origRunCb;
        root.remove();
    }

    const inst = { node, store, resolveRun, loadFromValue, flush: store.flush, dispose };
    node._h3wb = inst;

    renderAll();
    refreshSelection();
    progress.refresh();

    // 一次性宽度兜底：新建节点/旧存档太窄时撑到可用宽度（仅在全部加载
    // 落定后执行一次；用户此后怎么拖都不干预）
    setTimeout(() => {
        if ((node.size?.[0] || 0) < 880) {
            node.setSize([920, node.size[1] || 1150]);
        }
        syncWidth();
        app.graph?.setDirtyCanvas?.(true, true);
    }, 50);

    return inst;
}
