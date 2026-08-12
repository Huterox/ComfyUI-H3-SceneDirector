// main.js —— 装配：旧工作台组件挂到 Director 引擎（组件替换，不动 Director 文件）。
//
// 布局与旧工作台一致（workbench.png）：
//   工具条（SceneDirector / 场景名 / 摘要 / +分镜 / 全部重摇）
//   预览区 stage（点播窗 + 片段信息侧栏）
//   胶片时间线 timeline（刻度尺 + 段卡轨道）
//   滚动区（详情面板 detail + 折叠的设定表/资产卡）
//   底部状态行 progress
//
// 接管的模式：t2v / i2v / r2v（视频批量）。这些模式下被替换的 Director
// 表面全部隐藏：
//   批量卡列表（bd-batch）→ detail 面板取代
//   画布时间轴（bd-viewport）→ 我们的胶片时间线取代
//   Director 舞台/播放条（bd-stage/bd-controls）→ 我们的舞台取代
//   TAE 实时预览条（bd-live-sample）→ 实时帧走我们舞台（STEP_EVENT）
//   底部全局面板（[data-r=global-panel]）→ 设定表/资产卡取代
//     （r2v 例外：面板留着管分类参考图/视频/音频，只藏它的提示词列，
//       我们的资产卡折页此时不挂）
// fl2v / v2v / rv2v：我们的工作台整体隐藏，Director 原样。
//
// 数据流：组件 ↔ store（state.js 适配层）↔ ed.timeline ↔ ed.commit 序列化。
// 尺寸契约：我们的 root 是 ed.mainBody 的普通孩子，高度走 Director 的
// DOM widget 布局；宽度 100%，内部弹性伸缩，不测量、不钉尺寸。

import { createStore, sanitizeRun, newNonce } from "./state.js";
import { createBackend } from "./api.js";
import { createSettings } from "./settings.js";
import { createAssets } from "./assets.js";
import { createTimeline } from "./timeline.js";
import { createStage } from "./stage.js";
import { createDetail } from "./detail.js";
import { createProgress } from "./progress.js";

const STYLE_ID = "h3-scenedirector-style";

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

// 我们接管的任务模式（视频批量）
function isOursMode(ed) {
    const k = String(ed.getTaskKey?.() || "").toLowerCase();
    return !!ed.isImageBatch?.() && (k === "t2v" || k === "i2v" || k === "r2v");
}

export function attachWorkbench(node, { app, api }) {
    if (node._h3wb) return node._h3wb;   // 防重复挂载
    const ed = node._minimaxEditor;
    if (!ed || !ed.root) return null;
    const runWidget = node.widgets?.find((w) => w.name === "run_name");
    ensureStyle();

    const backend = createBackend(api);
    const store = createStore({ ed, runWidget, app });

    const resolveRun = () => {
        const w = runWidget ? String(runWidget.value ?? "").trim() : "";
        return sanitizeRun(w || store.get().run);
    };

    // --- 选中态（UI 级状态；与 ed.selectedIndex 双向同步，保证增强器等
    //     Director 侧功能作用的段和我们看到的段一致） ----------------------
    let selected = 0;
    const clampSel = () => {
        const n = store.get().segments.length;
        selected = Math.max(0, Math.min(selected, n - 1));
    };

    // --- DOM 骨架 ------------------------------------------------------------
    const root = el("div", "h3wb");

    const bar = el("div", "h3wb-bar");
    bar.appendChild(el("span", "h3wb-logo", "SceneDirector"));
    bar.appendChild(el("span", "lbl", "场景"));
    const runInput = el("input", "h3wb-run");
    runInput.type = "text";
    runInput.title = "run 名 = 缓存目录名（output/h3_scenedirector/<run>/）；换名即开新场景";
    runInput.value = runWidget ? String(runWidget.value ?? "") : store.get().run;
    runInput.addEventListener("input", () => {
        const v = runInput.value;
        if (runWidget) runWidget.value = v;   // 纯赋值，绝不 defineProperty
        store.get().run = sanitizeRun(v);
        store.commit();
    });
    const sumSpan = el("span", "h3wb-sum");
    bar.appendChild(runInput);
    bar.appendChild(sumSpan);
    bar.appendChild(el("span", "h3wb-sp"));
    const addBtn = el("button", "h3wb-btn primary", "+ 分镜");
    addBtn.title = "在时间线末尾加一段 5 秒分镜";
    const rerollAllBtn = el("button", "h3wb-btn", "全部重摇");
    rerollAllBtn.title = "所有段换新 id：整条链的缓存全部作废，下次执行全量重渲";
    bar.appendChild(addBtn);
    bar.appendChild(rerollAllBtn);
    root.appendChild(bar);

    const timeline = createTimeline({
        store, backend, getRun: resolveRun,
        getSelected: () => selected,
        onSelect: (i) => {
            selected = i;
            // 同步 Director 选中（增强器「扩写当前」等作用在同一段）
            ed.selectedIndex = i;
            ed.updateSelectionUI?.();
            refreshSelection();
        },
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

    // 上半区（预览 + 时间线）与滚动区之间：横向分隔条，拖拽分配高度
    const topwrap = el("div", "h3wb-topwrap");
    topwrap.appendChild(stage.element);
    topwrap.appendChild(timeline.element);
    root.appendChild(topwrap);

    const hsplit = el("div", "h3wb-hsplit");
    hsplit.title = "拖拽调整预览/时间线区的高度";
    root.appendChild(hsplit);
    hsplit.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        hsplit.setPointerCapture(e.pointerId);
        const y0 = e.clientY;
        const h0 = topwrap.getBoundingClientRect().height;
        const rootH = root.getBoundingClientRect().height;
        const move = (ev) => {
            const h = Math.min(rootH - 200, Math.max(200, h0 + ev.clientY - y0));
            topwrap.classList.add("sized");
            topwrap.style.height = Math.round(h) + "px";
        };
        const up = () => {
            hsplit.removeEventListener("pointermove", move);
            hsplit.removeEventListener("pointerup", up);
        };
        hsplit.addEventListener("pointermove", move);
        hsplit.addEventListener("pointerup", up);
    });

    // 滚动区：详情面板 + 折叠的设定表/资产卡
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

    // 挂载到 Director 主区：占住批量卡面板的位置（它在我们模式下被隐藏）
    if (ed.batchPanel && ed.batchPanel.parentElement) {
        ed.batchPanel.parentElement.insertBefore(root, ed.batchPanel);
    } else if (ed.mainBody) {
        ed.mainBody.appendChild(root);
    }

    // --- Director 表面隐藏/还愿 ---------------------------------------------
    const HIDE = "h3wb-hide";
    const q = (sel) => ed.root.querySelector(sel);
    function applyMode() {
        const ours = isOursMode(ed);
        root.style.display = ours ? "" : "none";
        const targets = [
            ed.batchPanel,                          // 批量卡列表
            q(".bd-viewport"),                      // 画布时间轴
            q(".bd-stage"),                         // Director 舞台
            q(".bd-controls"),                      // Director 播放条
            ed.liveSampleEl || q(".bd-live-sample"),// TAE 实时预览条
            q('[data-r="global-panel"]'),           // 底部全局面板
        ];
        for (const t of targets) {
            if (!t) continue;
            t.classList.toggle(HIDE, ours);
        }
        // r2v：公共面板留着（分类参考图/视频/音频归它管），只藏提示词列；
        // 我们的资产卡折页此时不显示（避免两个 UI 抢 tl.global.refs）
        const promptCol = q('[data-r="global-prompt-layout"] .bd-prompt-col');
        if (promptCol) promptCol.classList.toggle(HIDE, ours);
        fold2.style.display = ours && store.get().mode === "r2v" ? "none" : "";
    }

    // Director 每次布局后我们覆盖它的显隐（包 applyTaskLayout，后挂后跑）
    if (!ed._h3wbLayoutWrapped) {
        ed._h3wbLayoutWrapped = true;
        const origLayout = ed.applyTaskLayout?.bind(ed);
        if (origLayout) {
            ed.applyTaskLayout = (...args) => {
                const out = origLayout(...args);
                try { applyMode(); } catch (e) { /* 忽略 */ }
                return out;
            };
        }
    }

    // Director 侧选中变化（比如增强器面板切段）→ 跟段
    if (!ed._h3wbSelWrapped && ed.updateSelectionUI) {
        ed._h3wbSelWrapped = true;
        const origUS = ed.updateSelectionUI.bind(ed);
        ed.updateSelectionUI = (...args) => {
            const out = origUS(...args);
            try {
                const i = ed.selectedIndex ?? 0;
                if (i !== selected) { selected = i; refreshSelection(); }
            } catch (e) { /* 忽略 */ }
            return out;
        };
    }

    // --- 段操作（预览区侧栏按钮的回调） ---------------------------------------
    function onSegAction(action, i) {
        const segs = store.get().segments;
        const seg = segs[i];
        if (!seg) return;
        if (action === "reroll") {
            // 换新 nonce = Director 段换新 id → 后端 seg_hash 变 → 本段及之后级联重渲
            seg.nonce = newNonce();
            store.commit();
        } else if (action === "left" && i > 0) {
            [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
            selected = i - 1;
            ed.selectedIndex = selected;
            store.commit({ structural: true });
        } else if (action === "right" && i < segs.length - 1) {
            [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
            selected = i + 1;
            ed.selectedIndex = selected;
            store.commit({ structural: true });
        } else if (action === "del") {
            segs.splice(i, 1);
            clampSel();
            ed.selectedIndex = selected;
            store.commit({ structural: true });
        }
    }

    addBtn.addEventListener("click", () => {
        const segs = store.get().segments;
        segs.push({ duration: 5.0, prompt: "", nonce: newNonce(), assets: [], firstFrame: null });
        selected = segs.length - 1;
        ed.selectedIndex = selected;
        store.commit({ structural: true });
    });
    rerollAllBtn.addEventListener("click", () => {
        for (const s of store.get().segments) s.nonce = newNonce();
        store.commit();
    });

    // --- 渲染 ----------------------------------------------------------------
    function updateFoldSums() {
        const s = store.get();
        const cats = ["通用"].concat(s.globals.map((g) => g.category).filter(Boolean));
        sum1.innerHTML = "<b>场景设定表</b>　" + cats.join(" · ")
            + "　<span class='lbl'>(改动全链重渲)</span>";
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
        applyMode();   // 模式可能刚切（外部同步也会走这里）
        app.graph?.setDirtyCanvas?.(true, true);
    }

    // 统一订阅：结构变更整体重绘；任何变更都防抖重查缓存状态
    store.subscribe((info) => {
        if (info.structural) renderAll();
        progress.refreshSoon();
    });

    // run_name widget 保持可见：包装 callback 同步回工作台（普通赋值包装）
    let origRunCb = runWidget?.callback;
    if (runWidget) {
        runWidget.callback = function () {
            const out = origRunCb?.apply(this, arguments);
            runInput.value = String(runWidget.value ?? "");
            store.get().run = sanitizeRun(runInput.value);
            store.commit();
            return out;
        };
    }

    // --- WS 事件（dispose 时必须退订） ---------------------------------------
    const offProgress = backend.onProgress((d) => {
        if (d.run && d.run === resolveRun()) {
            progress.setProgress(d);
            progress.refreshSoon();
        }
    });
    const offStep = backend.onStep((d) => {
        if (d.run && d.run !== resolveRun()) return;
        const i = (d.segment || 0) - 1;
        // 跟随正在渲染的段；用户正在输入时不抢焦点
        const ae = document.activeElement;
        const typing = ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT");
        if (!typing && i !== selected) {
            selected = i;
            ed.selectedIndex = i;
            refreshSelection();
        }
        stage.showLive(d);
    });
    const offExecEnd = backend.onExecutionEnd(() => {
        stage.clearLive();
        progress.onDone();
    });

    // 队列序列化前把防抖中的编辑落盘（打字后立刻点运行不丢尾字）
    const origNodeSerialize = node.onSerialize;
    node.onSerialize = function () {
        try { store.flush(); } catch (e) { /* 忽略 */ }
        return origNodeSerialize?.apply(this, arguments);
    };

    function dispose() {
        offProgress();
        offStep();
        offExecEnd();
        progress.dispose();
        detail.dispose();
        if (runWidget) runWidget.callback = origRunCb;
        // 还愿被隐藏的 Director 表面
        for (const t of ed.root.querySelectorAll("." + HIDE)) t.classList.remove(HIDE);
        root.remove();
    }

    const inst = { node, store, ed, resolveRun, dispose };
    node._h3wb = inst;
    const origOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        try { dispose(); } catch (e) { /* 忽略 */ }
        return origOnRemoved?.apply(this, arguments);
    };

    renderAll();
    refreshSelection();
    progress.refresh();
    applyMode();

    return inst;
}
