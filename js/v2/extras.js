// extras.js —— v2 胶片带 + 状态行 + 实时预览 + WS 事件。
//
// 胶片带：时间尺 + 段卡（海报/状态点/序号/起始时刻），点选同步、双击播片、
// 重摇本段；v2v/rv2v 不挂（设计图取舍）。状态行：缓存/级联/进度文案 +
// 渐变进度条，完成定格 100%。实时预览：采样 step 帧投进预览条。
// 数据：POST /h3_scenedirector/status（body 由 store.statusBody 构建）+
// WS h3_scenedirector_progress / h3_scenedirector_step / execution_success。
import { el, fmtTime, artifactUrl } from "./util.js";

export function createExtras(ed, { api }) {
    const { store } = ed;

    // --- 胶片带 ----------------------------------------------------------------
    const fs = el("div", "sd2-fs");
    const ruler = el("div", "sd2-ruler");
    const track = el("div", "sd2-track");
    fs.appendChild(ruler);
    fs.appendChild(track);

    // --- 状态行 ----------------------------------------------------------------
    const status = el("div", "sd2-status");
    const stText = el("span", "txt", "运行状态：待命");
    const pbar = el("div", "sd2-pbar");
    const pfill = el("u");
    pbar.appendChild(pfill);
    const pct = el("span", "pct", "");
    status.appendChild(stText);
    status.appendChild(pbar);
    status.appendChild(pct);

    // --- 实时预览 ---------------------------------------------------------------
    const liveImg = document.createElement("img");
    const liveTag = el("div", "tag");
    ed.els.live.appendChild(liveImg);
    ed.els.live.appendChild(liveTag);

    let statuses = null;
    let rendering = false;
    let justFinished = false;
    let pollTimer = 0;
    let debounceTimer = 0;
    let inflight = false;
    let again = false;

    function gateMode() {
        // 设计图取舍：v2v/rv2v（视频编辑模式）不挂胶片带
        fs.style.display = store.isVideoMode() ? "none" : "";
    }

    function renderStrip() {
        gateMode();
        const s = store.get();
        const segs = store.isFl2v() ? s.shots : s.segments;
        const keep = track.scrollLeft;
        ruler.innerHTML = "";
        track.innerHTML = "";
        const rulerInner = el("div", "inner");
        ruler.appendChild(rulerInner);
        let t = 0, px = 0;
        const total = segs.reduce((a, x) => a + (parseFloat(x.durationSec) || 5), 0) || 1;
        segs.forEach((seg, i) => {
            const dur = parseFloat(seg.durationSec) || 5;
            // 卡宽 ∝ 时长（23.6px/s，64–118px；设计图基准），刻度尺同公式按像素定位
            const wpx = Math.max(64, Math.min(118, dur * 23.6));
            const tick = el("span", "tick", fmtTime(t));
            tick.style.left = px + "px";
            rulerInner.appendChild(tick);

            const st = statuses?.statuses?.[i];
            const cell = el("div", "cell" + (i === ed.selectedIndex ? " sel" : ""));
            cell.style.width = wpx + "px";
            cell.title = "段 " + (i + 1) + " · " + dur.toFixed(1) + "s"
                + (st?.cached ? " · 已缓存" : st?.will_render ? " · 将重渲" : " · 待渲染")
                + "（点击选中，双击播片）";
            if (st?.poster_file) {
                const img = document.createElement("img");
                img.src = artifactUrl(api, store.resolveRun(), "poster", st.poster_file, statuses?.updated);
                img.loading = "lazy";
                cell.appendChild(img);
            } else {
                cell.appendChild(el("span", "empty", "🎬"));
            }
            const dotCls = st ? (st.cached ? "ok" : st.will_render ? "warn" : "bad") : "";
            cell.appendChild(el("span", "dot " + dotCls));
            cell.appendChild(el("span", "idx", "#" + (i + 1)));
            if (st?.mp4_file) {
                cell.classList.add("playable");
                cell.addEventListener("dblclick", () => {
                    const url = artifactUrl(api, store.resolveRun(), "mp4", st.mp4_file, statuses?.updated);
                    const box = el("div", "sd2-lightbox");
                    const v = document.createElement("video");
                    v.src = url;
                    v.controls = true; v.autoplay = true; v.loop = true;
                    v.addEventListener("click", (ev) => ev.stopPropagation());
                    box.appendChild(v);
                    box.addEventListener("click", () => box.remove());
                    document.body.appendChild(box);
                });
            }
            cell.addEventListener("click", () => {
                ed.selectedIndex = i;
                ed.render();
            });
            track.appendChild(cell);
            t += dur;
            px += wpx + 3;
        });
        const end = el("span", "tick", fmtTime(total));
        end.style.left = px + "px";
        rulerInner.appendChild(end);
        rulerInner.style.width = (px + 46) + "px";
        track.scrollLeft = keep;
        // 刻度尺跟随轨道横向滚动
        track.onscroll = () => {
            rulerInner.style.transform = "translateX(" + (-track.scrollLeft) + "px)";
        };
        rulerInner.style.transform = "translateX(" + (-track.scrollLeft) + "px)";
    }

    function showIdle() {
        if (rendering) return;
        if (justFinished) {
            stText.innerHTML = "运行状态：<b>完成 ✓</b>（" + (statuses ? statuses.total : "?") + " 段）";
            pfill.style.width = "100%";
            pct.textContent = "100%";
            return;
        }
        if (!statuses) { stText.textContent = "运行状态：待命"; return; }
        const cached = statuses.statuses.filter((x) => x.cached).length;
        if (statuses.global_changed) {
            stText.innerHTML = "运行状态：待命 · <b>全局设定已改，下次全链重渲</b>";
        } else if (statuses.first_dirty != null && statuses.first_dirty < statuses.total) {
            stText.innerHTML = "运行状态：待命 · 缓存 " + cached + "/" + statuses.total
                + "，下次从第 <b>" + (statuses.first_dirty + 1) + "</b> 段起重渲";
        } else {
            stText.innerHTML = "运行状态：待命 · <b>全部命中缓存</b>（" + cached + "/" + statuses.total + "）";
        }
        pfill.style.width = "0";
        pct.textContent = "";
    }

    async function refresh() {
        if (inflight) { again = true; return; }
        inflight = true;
        try {
            const r = await api.fetchApi("/h3_scenedirector/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(store.statusBody()),
            });
            if (r.ok) {
                statuses = await r.json();
                ed.statuses = statuses;
                renderStrip();
                showIdle();
            }
        } catch (e) { /* 后端忙/不可达：下轮再试 */ }
        finally {
            inflight = false;
            if (again) { again = false; refreshSoon(); }
        }
    }

    function refreshSoon() {
        justFinished = false;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(refresh, 800);
    }

    // --- WS 事件 ------------------------------------------------------------------
    const onProgress = (ev) => {
        const d = ev.detail || {};
        if (d.run && d.run !== store.resolveRun()) return;
        if (d.done) { onDone(); return; }
        rendering = true;
        stText.innerHTML = "运行状态：<b>渲染中</b>　第 " + d.segment + "/" + d.total
            + " 段（" + (d.cached || 0) + " 段命中缓存）";
        const p = Math.round(100 * (d.segment - 1) / Math.max(1, d.total));
        pfill.style.width = p + "%";
        pct.textContent = p + "%";
        refreshSoon();   // 每段完工件就落盘：海报随渲染逐段出现
    };
    const onStep = (ev) => {
        const d = ev.detail || {};
        if (!ed.liveOn) return;
        if (d.run && d.run !== store.resolveRun()) return;
        if (d.image) {
            liveImg.src = "data:image/jpeg;base64," + d.image;
            liveTag.textContent = "实时预览 · 段 " + d.segment + "/" + d.total
                + " · step " + d.step + "/" + d.steps;
            ed.els.live.classList.remove("hidden");
        }
        // 跟段：正在渲染的段投到选中位（用户打字时不抢）
        const i = (d.segment || 0) - 1;
        const ae = document.activeElement;
        const typing = ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT");
        if (!typing && i >= 0 && i !== ed.selectedIndex) {
            ed.selectedIndex = i;
            renderStrip();
        }
    };
    const onDone = () => {
        rendering = false;
        justFinished = true;
        ed.els.live.classList.add("hidden");
        refresh();
    };

    api.addEventListener("h3_scenedirector_progress", onProgress);
    api.addEventListener("h3_scenedirector_step", onStep);
    api.addEventListener("execution_success", onDone);
    api.addEventListener("execution_end", onDone);

    store.onStatusDirty(refreshSoon);

    return {
        element: fs,
        statusEl: status,
        render() { renderStrip(); showIdle(); },
        start() {
            renderStrip();
            refresh();
            pollTimer = setInterval(refresh, 4000);
        },
        dispose() {
            if (pollTimer) clearInterval(pollTimer);
            if (debounceTimer) clearTimeout(debounceTimer);
            api.removeEventListener("h3_scenedirector_progress", onProgress);
            api.removeEventListener("h3_scenedirector_step", onStep);
            api.removeEventListener("execution_success", onDone);
            api.removeEventListener("execution_end", onDone);
        },
    };
}
