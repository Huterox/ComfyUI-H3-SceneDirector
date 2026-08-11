// timeline.js —— 分镜胶片时间线（v2 核心组件）。
//
// 布局：时间刻度尺（每段起止时刻）+ 横向胶片轨道。段卡以海报铺满，
// 无缓存显示"未渲染"占位；角标：序号 / 起始时刻 / 状态色点
// （绿=已缓存 橙=将级联重渲 红=待渲染 灰=未知）。点击卡片选中
// （选中态由 main 协调：预览窗与详情面板跟着切）。
//
// 交互：纵向滚轮转横向滚动；末尾 + 卡加分镜。重摇/删除/排序等操作
// 统一由预览区侧栏触发（main 的 onAction），卡片本身只负责选中。

import { newNonce } from "./state.js";

const MIN_W = 118;          // 5s 段的卡宽（设计稿基准）
const PX_PER_SEC = 23.6;    // 卡宽 ∝ 时长
const GAP = 6;

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ":" + s.toFixed(s % 1 ? 1 : 0).padStart(2, "0");
}

export function createTimeline({ store, backend, getRun, getSelected, onSelect, onSummary }) {
    const root = el("div", "h3wb-tl");
    const ruler = el("div", "h3wb-ruler");
    const track = el("div", "h3wb-track");
    root.appendChild(ruler);
    root.appendChild(track);

    let lastStatus = null;   // 最近一次 /status 响应（海报/徽标的来源）

    // 纵向滚轮转横向（胶片轨道的常规交互）
    track.addEventListener("wheel", (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            track.scrollLeft += e.deltaY;
            e.preventDefault();
        }
    }, { passive: false });
    // 刻度尺跟随轨道滚动
    track.addEventListener("scroll", () => { ruler.scrollLeft = track.scrollLeft; });

    // 段状态 -> 色点：绿=已缓存，橙=缓存但将级联重渲，红=待渲染，灰=未查询
    function dotClass(i) {
        const st = lastStatus?.statuses?.[i];
        if (!st) return "none";
        if (st.cached && !st.will_render) return "ok";
        if (st.will_render && st.cached) return "warn";
        if (!st.cached) return "bad";
        return "none";
    }

    function starts() {
        // 每段的累计起始秒
        const out = [];
        let acc = 0;
        for (const s of store.get().segments) {
            out.push(acc);
            acc += parseFloat(s.duration) || 5.0;
        }
        return { out, total: acc };
    }

    function render() {
        const segs = store.get().segments;
        const sel = getSelected();
        // 状态刷新也会走这里：保住横向滚动位置，别把用户甩回最左
        const keepScroll = track.scrollLeft;
        track.innerHTML = "";
        ruler.innerHTML = "";
        const { out: startAt, total } = starts();

        segs.forEach((s, i) => {
            const st = lastStatus?.statuses?.[i];
            const card = el("button", "h3wb-seg" + (i === sel ? " sel" : ""));
            card.style.width = Math.max(MIN_W, (parseFloat(s.duration) || 5.0) * PX_PER_SEC) + "px";
            card.title = "片段 #" + (i + 1) + "（点击选中）";
            if (st?.poster_file) {
                const img = document.createElement("img");
                img.src = backend.posterURL(getRun(), st.poster_file, lastStatus?.updated);
                img.alt = "#" + (i + 1);
                card.appendChild(img);
            } else {
                card.appendChild(el("div", "h3wb-seg-empty", "未渲染"));
            }
            card.appendChild(el("span", "h3wb-segno", "#" + (i + 1)));
            card.appendChild(el("span", "h3wb-segdur", fmtTime(startAt[i])));
            card.appendChild(el("span", "h3wb-dot " + dotClass(i)));
            card.addEventListener("click", () => onSelect(i));
            track.appendChild(card);

            // 刻度：每段起始时刻（与卡片相同的宽度公式精确定位）
            const t = el("i", null, fmtTime(startAt[i]));
            const u = document.createElement("u");
            let px = 0;
            for (let k = 0; k < i; k++) {
                px += Math.max(MIN_W, (parseFloat(segs[k].duration) || 5.0) * PX_PER_SEC) + GAP;
            }
            t.style.left = px + "px";
            if (i === 0) t.style.transform = "none";   // 首刻度不居中，防止左缘裁切
            u.style.left = px + "px";
            ruler.appendChild(t);
            ruler.appendChild(u);
        });

        const add = el("button", "h3wb-seg h3wb-segadd", "+");
        add.title = "加分镜";
        add.addEventListener("click", () => {
            const segs2 = store.get().segments;
            segs2.push({ duration: 5.0, prompt: "", nonce: newNonce(), assets: [] });
            store.commit({ structural: true });
            onSelect(segs2.length - 1);
        });
        track.appendChild(add);

        // 末尾总时刻
        let endPx = 0;
        for (const s of segs) endPx += Math.max(MIN_W, (parseFloat(s.duration) || 5.0) * PX_PER_SEC) + GAP;
        const endT = el("i", null, fmtTime(total));
        endT.style.left = endPx + "px";
        ruler.appendChild(endT);

        track.scrollLeft = keepScroll;   // 恢复横向滚动位置
        ruler.scrollLeft = keepScroll;

        // 工具条摘要
        if (onSummary) {
            const cachedN = lastStatus ? lastStatus.statuses.filter((s) => s.cached).length : null;
            onSummary("共 " + segs.length + " 段 · 总长 " + fmtTime(total)
                + (cachedN != null ? " · 已缓存 " + cachedN + "/" + segs.length : ""));
        }
    }

    // /status 响应：刷新海报与色点（不重建选中态以外的结构）
    function applyStatus(res) {
        lastStatus = res;
        render();
    }

    return { element: root, render, applyStatus };
}
