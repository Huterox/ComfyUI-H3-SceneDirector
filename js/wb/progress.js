// progress.js —— 底部状态行 + 缓存状态轮询。
//
// 职责：
//   * refresh()      立即 POST /status，把响应扇出给 onStatus（时间线/预览区）
//   * refreshSoon()  编辑后防抖 800ms 重查（重入保护：查询中置 again 补发）
//   * setProgress(d) WS 渲染进度（渲染第 x/total 段）驱动进度条
//   * reapply()      整体重绘后把最近一次状态重新扇出（补徽标/海报）
//   * dispose()      清定时器
//
// 状态行文案：待命 / 全局变更将全链重渲 / 将从第 N 段级联重渲 / 全部命中缓存。

import { statusBody } from "./state.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function createProgress({ backend, store, resolveRun, onStatus }) {
    const root = el("div", "h3wb-status");
    const text = el("span", null, "运行状态：待命");
    const bar = el("div", "h3wb-pbar");
    const fill = document.createElement("u");
    bar.appendChild(fill);
    const pct = el("span", "h3wb-pct", "");
    root.appendChild(text);
    root.appendChild(bar);
    root.appendChild(pct);

    let timer = 0;
    let inflight = false;
    let again = false;
    let lastRes = null;
    let rendering = false;   // 收到 WS 进度期间不覆盖进度文案
    let justFinished = false;   // 跑完一轮：状态行定格"完成 100%"，下个编辑动作清除

    function showIdle(res) {
        if (rendering) return;
        if (justFinished) {
            text.innerHTML = "运行状态：<b>完成 ✓</b>（" + (res ? res.total : "?") + " 段）";
            fill.style.width = "100%";
            pct.textContent = "100%";
            return;
        }
        if (!res) { text.textContent = "运行状态：待命"; return; }
        const cached = res.statuses.filter((s) => s.cached).length;
        if (res.global_changed) {
            text.innerHTML = "运行状态：待命 · <b>全局设定已改，下次全链重渲</b>";
        } else if (res.first_dirty != null && res.first_dirty < res.total) {
            text.innerHTML = "运行状态：待命 · 缓存 " + cached + "/" + res.total
                + "，下次从第 <b>" + (res.first_dirty + 1) + "</b> 段起重渲";
        } else {
            text.innerHTML = "运行状态：待命 · <b>全部命中缓存</b>（" + cached + "/" + res.total + "）";
        }
        fill.style.width = "0";
        pct.textContent = "";
    }

    async function refresh() {
        if (inflight) { again = true; return; }
        inflight = true;
        try {
            const res = await backend.postStatus(statusBody(store.get(), resolveRun()));
            lastRes = res;
            onStatus(res);
            showIdle(res);
        } catch (e) {
            text.textContent = "状态查询失败（后端在跑渲染？稍后会自动重试）";
            console.warn("[h3-workbench] status", e);
        } finally {
            inflight = false;
            if (again) { again = false; refreshSoon(); }
        }
    }

    function refreshSoon() {
        justFinished = false;   // 有新编辑：清掉"完成"定格
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 800);
    }

    // WS：{run, segment, total, cached, done?}——done 由引擎在整轮完成时发出
    // （宿主 0.31 已无 execution_end，完成定格 100% 走这条路最稳）
    function setProgress(d) {
        if (d.done) { onDone(); return; }
        rendering = true;
        text.innerHTML = "运行状态：<b>渲染中</b>　第 " + d.segment + "/" + d.total
            + " 段（" + (d.cached || 0) + " 段命中缓存）";
        const p = Math.round(100 * (d.segment - 1) / Math.max(1, d.total));
        fill.style.width = p + "%";
        pct.textContent = p + "%";
    }

    // 执行结束：定格"完成 100%"并重新拉状态
    function onDone() {
        rendering = false;
        justFinished = true;
        refresh();
    }

    function reapply() {
        if (lastRes) { onStatus(lastRes); showIdle(lastRes); }
    }

    function dispose() { if (timer) clearTimeout(timer); }

    return { element: root, refresh, refreshSoon, setProgress, onDone, reapply, dispose };
}
