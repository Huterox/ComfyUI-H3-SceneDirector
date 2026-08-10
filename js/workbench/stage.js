// stage.js —— 预览区（内嵌点播窗 + 片段信息侧栏）。
//
// 左侧 16:9 点播窗：选中段有 mp4 时显示海报+播放键，点击换成 <video>
// 内嵌播放（不是弹层）；只有海报显示海报；啥都没有显示"未渲染"。
// 右侧信息侧栏：片段号、状态徽标、时间区间/帧数/seed、级联提示、
// 操作按钮（重摇/左右移/删除——经 onAction 回调给 main 统一处理）。

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

export function createStage({ store, backend, getRun, getSelected, onAction }) {
    const root = el("div", "h3wb-stage");
    const screen = el("div", "h3wb-screen");
    const side = el("div", "h3wb-side");
    root.appendChild(screen);
    root.appendChild(side);

    let lastStatus = null;
    let cur = -1;   // 当前展示的段索引（切段时停掉播放）

    function segRange(i) {
        let acc = 0;
        const segs = store.get().segments;
        for (let k = 0; k < i && k < segs.length; k++) acc += parseFloat(segs[k].duration) || 5.0;
        const dur = parseFloat(segs[i]?.duration) || 5.0;
        return [acc, acc + dur];
    }

    function statusOf(i) { return lastStatus?.statuses?.[i]; }

    function tagOf(i) {
        const st = statusOf(i);
        if (!st) return ["none", "未查询"];
        if (st.cached && !st.will_render) return ["ok", "已缓存"];
        if (st.will_render && st.cached) return ["warn", "将级联重渲"];
        if (!st.cached) return ["bad", "待渲染"];
        return ["none", "未知"];
    }

    function renderScreen(i) {
        screen.innerHTML = "";
        const st = statusOf(i);
        if (st?.poster_file) {
            const img = document.createElement("img");
            img.src = backend.posterURL(getRun(), st.poster_file, lastStatus?.updated);
            screen.appendChild(img);
            if (st.mp4_file) {
                const play = el("button", "h3wb-play");
                play.title = "点播本段";
                play.appendChild(el("span", null, "▶"));
                play.addEventListener("click", () => {
                    const v = document.createElement("video");
                    v.src = backend.mp4URL(getRun(), st.mp4_file, lastStatus?.updated);
                    v.controls = true; v.autoplay = true; v.loop = true;
                    screen.innerHTML = "";
                    screen.appendChild(v);
                });
                screen.appendChild(play);
            }
        } else {
            screen.appendChild(el("div", "h3wb-empty", "未渲染"));
        }
    }

    function renderSide(i) {
        side.innerHTML = "";
        const segs = store.get().segments;
        if (!segs[i]) {
            side.appendChild(el("div", "h3wb-kv", "（没有分镜，点轨道末尾的 + 加一段）"));
            return;
        }
        const [cls, label] = tagOf(i);
        const title = el("div", "h3wb-segtitle");
        title.appendChild(document.createTextNode("片段 #" + (i + 1) + " "));
        title.appendChild(el("span", "h3wb-tag " + cls, label));
        side.appendChild(title);

        const [a, b] = segRange(i);
        const st = statusOf(i);
        const kv1 = el("div", "h3wb-kv");
        kv1.innerHTML = "时间 <b>" + fmtTime(a) + " – " + fmtTime(b) + "</b>"
            + (st?.frames ? " · <b>" + st.frames + " 帧</b> @24fps" : "");
        side.appendChild(kv1);

        if (st?.seed != null) {
            const kv2 = el("div", "h3wb-kv");
            kv2.innerHTML = "seed <b>" + st.seed + "</b>";
            side.appendChild(kv2);
        }
        if (lastStatus && lastStatus.first_dirty != null && i >= lastStatus.first_dirty && st) {
            side.appendChild(el("div", "h3wb-hint",
                i === lastStatus.first_dirty
                    ? "本段是第一个变动段：渲染从它开始级联"
                    : "本段在级联范围内：会跟随重渲"));
        }

        const acts = el("div", "h3wb-acts");
        const mk = (txt, action, title2, cls2) => {
            const btn = el("button", "h3wb-btn" + (cls2 ? " " + cls2 : ""), txt);
            btn.title = title2;
            btn.addEventListener("click", () => onAction(action, i));
            acts.appendChild(btn);
        };
        mk("↻ 重摇本段", "reroll", "换新 nonce，强制本段（及之后）重渲");
        mk("◀", "left", "左移"); mk("▶", "right", "右移");
        mk("删除", "del", "删除本段（其后的段会级联重渲）", "danger");
        side.appendChild(acts);
    }

    // 选中段变化时整体刷新；force 时同段也重绘画布（状态晚到要补海报），
    // 但正在播视频时不打断
    function setSegment(i, force) {
        const playing = !!screen.querySelector("video");
        if (i !== cur || (force && !playing)) { cur = i; renderScreen(i); }
        renderSide(i);
    }

    function applyStatus(res) {
        lastStatus = res;
        if (cur >= 0) setSegment(cur, true);
    }

    return { element: root, setSegment, applyStatus };
}
