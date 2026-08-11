// SceneDirector 工作台：分镜时间线条 + 段卡片编辑器
// 交互：拖时间轴块右缘调时长、拖块换序、分割/删除、勾选运行（run mask）
import { t } from "./i18n.js";
import { newSegment } from "./state.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// ---------------------------------------------------------------------------
// 时间轴条（比例块 + 拖缘调时长 + 拖块换序）
// ---------------------------------------------------------------------------
export function buildTimeline(ctx) {
    const bar = el("div", "h3sd-strip");
    let dragIdx = -1;

    function render() {
        bar.innerHTML = "";
        const segs = ctx.payload.segments;
        const total = segs.reduce((a, s) => a + (parseFloat(s.duration) || 0), 0) || 1;
        segs.forEach((s, i) => {
            const blk = el("div", "h3sd-blk" + (s.enabled === false ? " off" : "")
                + (i === ctx.selected ? " sel" : ""));
            blk.style.width = Math.max(4, (parseFloat(s.duration) || 0) / total * 100) + "%";
            blk.textContent = (i + 1) + "";
            blk.title = (s.nonce || ("段 " + (i + 1))) + " · " + s.duration + "s";
            blk.dataset.idx = i;

            // 拖块换序
            blk.draggable = true;
            blk.addEventListener("dragstart", (e) => {
                dragIdx = i;
                e.dataTransfer.effectAllowed = "move";
            });
            blk.addEventListener("dragover", (e) => e.preventDefault());
            blk.addEventListener("drop", (e) => {
                e.preventDefault();
                if (dragIdx < 0 || dragIdx === i) return;
                const [m] = segs.splice(dragIdx, 1);
                segs.splice(i, 0, m);
                dragIdx = -1;
                ctx.selected = i;
                ctx.refresh();
            });
            blk.addEventListener("click", () => {
                ctx.selected = i;
                ctx.refresh();
            });

            // 右缘拖调时长：每 6px ≈ 0.1s，最小 1s
            const edge = el("div", "h3sd-blk-edge");
            edge.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                edge.setPointerCapture(e.pointerId);
                let acc = 0;
                const move = (ev) => {
                    acc += ev.movementX;
                    const steps = Math.trunc(acc / 6);
                    if (steps) {
                        acc -= steps * 6;
                        s.duration = Math.max(1, Math.round(((parseFloat(s.duration) || 1) + steps * 0.1) * 10) / 10);
                        ctx.sync();
                        render();
                    }
                };
                const up = () => {
                    edge.removeEventListener("pointermove", move);
                    edge.removeEventListener("pointerup", up);
                    ctx.refresh();
                };
                edge.addEventListener("pointermove", move);
                edge.addEventListener("pointerup", up);
            });
            blk.appendChild(edge);
            bar.appendChild(blk);
        });
    }
    render();
    return { root: bar, render };
}

// ---------------------------------------------------------------------------
// 段卡片列表（提示词 / 勾选 / 时长 / 首尾帧 / 源片段 / 状态徽标 / 缩略图）
// ---------------------------------------------------------------------------
export function buildCards(ctx) {
    const list = el("div", "h3sd-cards");

    function head(s, i) {
        const h = el("div", "h3sd-card-head");
        const en = el("input");
        en.type = "checkbox";
        en.checked = s.enabled !== false;
        en.title = t("enabled");
        en.addEventListener("change", () => { s.enabled = en.checked; ctx.refresh(); });
        h.appendChild(en);
        h.appendChild(el("span", "h3sd-card-idx", "#" + (i + 1)));
        const dur = el("input", "h3sd-card-dur");
        dur.value = s.duration;
        dur.title = t("duration");
        dur.addEventListener("change", () => {
            s.duration = Math.max(1, parseFloat(dur.value) || 1);
            ctx.refresh();
        });
        h.appendChild(dur);
        const nonce = el("input", "h3sd-card-nonce");
        nonce.placeholder = "nonce";
        nonce.value = s.nonce || "";
        nonce.addEventListener("change", () => { s.nonce = nonce.value; ctx.sync(); });
        h.appendChild(nonce);
        if (s.task && s.task !== "t2v") h.appendChild(el("span", "h3sd-badge task", s.task));
        const st = ctx.statuses[i] || {};
        if (s.enabled === false && !st.cached)
            h.appendChild(el("span", "h3sd-badge bad", t("noCache")));
        else if (st.will_render)
            h.appendChild(el("span", "h3sd-badge warn", t("willRender")));
        else if (st.cached)
            h.appendChild(el("span", "h3sd-badge ok", t("cached")));
        else
            h.appendChild(el("span", "h3sd-badge", t("dirty")));
        const splitBtn = el("button", "h3sd-mini", "✂");
        splitBtn.title = "分割本段";
        splitBtn.addEventListener("click", () => {
            const half = Math.round((parseFloat(s.duration) || 4) / 2 * 10) / 10;
            if (half < 1) return;
            s.duration = half;
            const b = newSegment(half);
            b.prompt = s.prompt;
            ctx.payload.segments.splice(i + 1, 0, b);
            ctx.refresh();
        });
        h.appendChild(splitBtn);
        const del = el("button", "h3sd-mini danger", "×");
        del.addEventListener("click", () => {
            ctx.payload.segments.splice(i, 1);
            ctx.refresh();
        });
        h.appendChild(del);
        return h;
    }

    function thumb(s, i) {
        const box = el("div", "h3sd-thumb");
        const st = ctx.statuses[i] || {};
        const url = st.poster_file
            ? ctx.artifactUrl(ctx.payload.run, "poster", st.poster_file) : null;
        if (url) {
            const img = document.createElement("img");
            img.src = url;
            img.loading = "lazy";
            box.appendChild(img);
        } else {
            box.appendChild(el("span", "h3sd-thumb-empty", "🎬"));
        }
        if (st.mp4_file) {
            box.classList.add("playable");
            box.title = "▶";
            box.addEventListener("click", () => ctx.playVideo(st.mp4_file));
        }
        return box;
    }

    function frameSlot(s, i, key, label) {
        const slot = el("div", "h3sd-slot");
        slot.title = label;
        const cur = s[key];
        if (cur && cur.image) {
            const img = document.createElement("img");
            img.src = ctx.inputImageUrl(cur.image, cur.subfolder);
            slot.appendChild(img);
            const x = el("button", "h3sd-mini danger", "×");
            x.addEventListener("click", (e) => {
                e.stopPropagation();
                s[key] = null;
                ctx.refresh();
            });
            slot.appendChild(x);
        } else {
            slot.appendChild(el("span", "h3sd-slot-empty", label));
        }
        slot.addEventListener("click", async () => {
            const file = await ctx.pickFile("image/*");
            if (!file) return;
            const name = await ctx.uploadImage(file);
            s[key] = { image: name, subfolder: "" };
            ctx.refresh();
        });
        return slot;
    }

    function sourceRow(s, i) {
        if (!s.source) return null;
        const row = el("div", "h3sd-source");
        row.appendChild(el("span", "h3sd-badge task", "v2v"));
        row.appendChild(el("span", "h3sd-src-name",
            s.source.video + " · " + s.source.start + "-" + s.source.end + "s"));
        const sel = el("select", "h3sd-src-audio");
        [["generate", t("audioGenerate")], ["original", t("audioOriginal")], ["mute", t("audioMute")]]
            .forEach(([v, label]) => {
                const o = el("option", "", label);
                o.value = v;
                if ((s.audio_mode || "generate") === v) o.selected = true;
                sel.appendChild(o);
            });
        sel.addEventListener("change", () => { s.audio_mode = sel.value; ctx.sync(); });
        row.appendChild(sel);
        const x = el("button", "h3sd-mini danger", "×");
        x.addEventListener("click", () => { s.source = null; ctx.refresh(); });
        row.appendChild(x);
        return row;
    }

    function render() {
        list.innerHTML = "";
        ctx.payload.segments.forEach((s, i) => {
            const card = el("div", "h3sd-card" + (i === ctx.selected ? " sel" : "")
                + (s.enabled === false ? " off" : ""));
            card.appendChild(head(s, i));
            const body = el("div", "h3sd-card-body");
            body.appendChild(thumb(s, i));
            const right = el("div", "h3sd-card-right");
            const ta = el("textarea", "h3sd-prompt");
            ta.value = s.prompt || "";
            ta.rows = 4;
            ta.spellcheck = false;
            ta.addEventListener("input", () => { s.prompt = ta.value; ctx.sync(); });
            ctx.bindMentions(ta);
            right.appendChild(ta);
            const tools = el("div", "h3sd-card-tools");
            tools.appendChild(frameSlot(s, i, "first_frame", t("firstFrame")));
            tools.appendChild(frameSlot(s, i, "last_frame", t("lastFrame")));
            const enh = el("button", "h3sd-mini", "✨ " + t("enhance"));
            enh.addEventListener("click", async () => {
                enh.disabled = true;
                try {
                    const r = await ctx.enhance(s.prompt, s.task || "t2v", s.duration);
                    s.prompt = r.prompt;
                    ta.value = s.prompt;
                    ctx.sync();
                } catch (e) {
                    ctx.toast("增强失败: " + e.message);
                } finally {
                    enh.disabled = false;
                }
            });
            tools.appendChild(enh);
            right.appendChild(tools);
            const sr = sourceRow(s, i);
            if (sr) right.appendChild(sr);
            body.appendChild(right);
            card.appendChild(body);
            card.addEventListener("click", () => { ctx.selected = i; });
            list.appendChild(card);
        });
        // 加段按钮
        const add = el("button", "h3sd-add", t("addSeg"));
        add.addEventListener("click", () => {
            ctx.payload.segments.push(newSegment(5));
            ctx.selected = ctx.payload.segments.length - 1;
            ctx.refresh();
        });
        list.appendChild(add);
    }
    render();
    return { root: list, render };
}
