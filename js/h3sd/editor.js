// SceneDirector 工作台主编辑器（自研 UI，我们先前的设计）
// 布局：顶部状态条 / 大舞台+段信息 / 胶片带 / 段编辑区 / 全局提示词 /
//       场景设定表 / 场景资产卡 / 源视频(v2v) / LLM 增强 / 运行状态
import { app } from "../../../scripts/app.js";

// 样式注入
const _css = document.createElement("link");
_css.rel = "stylesheet";
_css.href = new URL("./workbench.css", import.meta.url).href;
document.head.appendChild(_css);
import { backend, onProgress, onStep } from "./api.js";
import { emptyPayload, parseWidgetValue, newSegment, newAsset, TASKS, totalDuration, fmtTime } from "./state.js";
import { buildEnhancer } from "./enhancer.js";

const NODE_NAME = "H3SceneDirectorList";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function pickFile(accept) {
    return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = accept || "*/*";
        inp.onchange = () => resolve(inp.files[0] || null);
        inp.oncancel = () => resolve(null);
        inp.click();
    });
}

function collapse(title, hint) {
    const head = el("div", "h3sd-collapse-head");
    head.appendChild(el("span", "", "▸ " + title));
    if (hint) head.appendChild(el("span", "h3sd-collapse-hint", hint));
    const body = el("div", "h3sd-collapse-body hidden");
    head.addEventListener("click", () => {
        body.classList.toggle("hidden");
        head.firstChild.textContent = (body.classList.contains("hidden") ? "▸ " : "▾ ") + title;
    });
    return { head, body };
}

function hideWidget(w) {
    if (!w) return;
    w.hidden = true;
    if (!w.options) w.options = {};
    w.options.hidden = true;
    w.computeSize = () => [0, 0];
    if (w.element) w.element.style.display = "none";
}

function buildWorkbench(node) {
    const tlWidget = node.widgets.find((w) => w.name === "timeline_data");
    if (!tlWidget) return;
    // 全部原生 widget 隐藏，工作台接管
    for (const w of node.widgets) hideWidget(w);

    const root = el("div", "h3sd-wb");
    const _minH = () => 620;
    node.addDOMWidget("h3sd_wb", "SceneDirector", root, {
        getValue: () => "", setValue: () => { },
        getMinHeight: _minH,
        hideOnZoom: false,
        afterResize() {
            root.style.minHeight = _minH() + "px";
        },
    });
    root.style.minHeight = _minH() + "px";

    const ctx = {
        node,
        payload: parseWidgetValue(tlWidget.value),
        statuses: [],
        selected: 0,
        getWidgetValue(name) {
            return node.widgets.find((w) => w.name === name)?.value;
        },
        setWidgetValue(name, v) {
            const w = node.widgets.find((x) => x.name === name);
            if (w) w.value = v;
        },
        selectedSegment() {
            return ctx.payload.segments[ctx.selected] || null;
        },
        applyEnhancedText(text) {
            const seg = ctx.selectedSegment();
            if (seg) seg.prompt = text;
            promptTa.value = text;
            ctx.sync();
        },
        sync() {
            tlWidget.value = JSON.stringify(ctx.payload);
            ctx.setWidgetValue("task_type", taskLabel(ctx.payload.task));
            ctx.setWidgetValue("global_prompt", ctx.payload.global_prompt || "");
            ctx.setWidgetValue("run_name", ctx.payload.run || "story");
            app.graph.setDirtyCanvas(true, true);
            updateStats();
        },
        refresh() {
            ctx.sync();
            filmstrip();
            segInfo();
            sourcePanelRefresh();
            scheduleStatus();
        },
    };

    function taskLabel(key) {
        const full = {
            t2v: "t2v — 文生视频(Text to Video)",
            i2v: "i2v — 图生视频(Image to Video)",
            fl2v: "fl2v — 首尾帧生视频(First-Last Frame)",
            r2v: "r2v — 参考主体生视频(Reference to Video)",
            v2v: "v2v — 视频转视频(Video to Video)",
            rv2v: "rv2v — 参考素材改视频(Reference Video Edit)",
        };
        return full[key] || full.t2v;
    }

    // ================= 顶部状态条 =================
    const bar = el("div", "h3sd-topbar");
    bar.appendChild(el("span", "h3sd-logo", "SceneDirector"));
    bar.appendChild(el("span", "h3sd-dim", "· 场景"));
    const runIn = el("input", "h3sd-run");
    runIn.value = ctx.payload.run || "story";
    runIn.addEventListener("change", () => {
        ctx.payload.run = runIn.value.trim() || "story";
        ctx.refresh();
    });
    bar.appendChild(runIn);
    const stats = el("span", "h3sd-stats", "");
    bar.appendChild(stats);
    const taskSel = el("select", "h3sd-task");
    TASKS.forEach(([k, label]) => {
        const o = el("option", "", label);
        o.value = k;
        taskSel.appendChild(o);
    });
    taskSel.value = ctx.payload.task || "t2v";
    taskSel.addEventListener("change", () => {
        ctx.payload.task = taskSel.value;
        ctx.refresh();
    });
    bar.appendChild(taskSel);
    const splitBtn = el("button", "h3sd-btn", "✂ 智能分镜");
    splitBtn.addEventListener("click", doSmartSplit);
    bar.appendChild(splitBtn);
    const rerollAll = el("button", "h3sd-btn danger", "全部重摇");
    rerollAll.addEventListener("click", () => {
        ctx.payload.run_nonce = (ctx.payload.run_nonce || 0) + 1;
        ctx.refresh();
    });
    bar.appendChild(rerollAll);
    // 分割当前段 / 均分当前段
    const halve = el("button", "h3sd-btn", "✂ 分割");
    halve.title = "当前段一分为二";
    halve.addEventListener("click", () => splitSeg(2));
    bar.appendChild(halve);
    const nIn = el("input", "h3sd-num");
    nIn.type = "number";
    nIn.value = 2;
    nIn.min = 2;
    nIn.max = 12;
    nIn.title = "均分段数";
    bar.appendChild(nIn);
    const equal = el("button", "h3sd-btn", "均分");
    equal.title = "当前段均分为 N 段";
    equal.addEventListener("click", () => splitSeg(Math.max(2, parseInt(nIn.value) || 2)));
    bar.appendChild(equal);
    // 段间引导 + 上下文帧数（latent 一致性开关）
    const contWrap = el("label", "h3sd-cont");
    const contCb = el("input");
    contCb.type = "checkbox";
    contCb.checked = ctx.payload.continuity !== false;
    contCb.addEventListener("change", () => { ctx.payload.continuity = contCb.checked; ctx.sync(); });
    contWrap.appendChild(contCb);
    contWrap.appendChild(el("span", "", "段间引导"));
    bar.appendChild(contWrap);
    const ctxSel = el("select", "h3sd-ctx");
    [5, 22, 39].forEach((v) => {
        const o = el("option", "", String(v));
        o.value = v;
        if ((ctx.payload.context_length || 22) === v) o.selected = true;
        ctxSel.appendChild(o);
    });
    ctxSel.title = "上下文帧数";
    ctxSel.addEventListener("change", () => { ctx.payload.context_length = parseInt(ctxSel.value); ctx.sync(); });
    bar.appendChild(ctxSel);
    root.appendChild(bar);

    function splitSeg(n) {
        const segs = ctx.payload.segments;
        const seg = ctx.selectedSegment();
        if (!seg) return;
        const dur = parseFloat(seg.duration) || 1;
        if (dur / n < 1) return;
        const each = Math.round(dur / n * 100) / 100;
        const base = JSON.parse(JSON.stringify(seg));
        const parts = [];
        for (let k = 0; k < n; k++) {
            const p = JSON.parse(JSON.stringify(base));
            p.duration = k === n - 1 ? Math.round((dur - each * (n - 1)) * 100) / 100 : each;
            if (k > 0) { p.first_frame = null; p.source = null; }
            parts.push(p);
        }
        segs.splice(ctx.selected, 1, ...parts);
        ctx.refresh();
    }

    // ================= 大舞台 + 段信息 =================
    const stageRow = el("div", "h3sd-stage-row");
    const screen = el("div", "h3sd-screen");
    const empty = el("span", "h3sd-screen-empty", "🎬");
    screen.appendChild(empty);
    screen.addEventListener("click", () => {
        const st = ctx.statuses[ctx.selected] || {};
        if (st.mp4_file) playVideo(st.mp4_file);
    });
    const info = el("div", "h3sd-seginfo");
    stageRow.appendChild(screen);
    stageRow.appendChild(info);
    root.appendChild(stageRow);

    function playVideo(file) {
        const wrap = el("div", "h3sd-lightbox");
        const v = document.createElement("video");
        v.src = backend.artifactUrl(ctx.payload.run, "mp4", file);
        v.controls = true;
        v.autoplay = true;
        wrap.appendChild(v);
        wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
        document.body.appendChild(wrap);
    }

    function segInfo() {
        info.innerHTML = "";
        const segs = ctx.payload.segments;
        const seg = ctx.selectedSegment();
        if (!seg) {
            info.appendChild(el("div", "h3sd-dim", "没有分段——点胶片带末尾 + 加一段"));
            return;
        }
        const st = ctx.statuses[ctx.selected] || {};
        const head = el("div", "h3sd-seg-head");
        head.appendChild(el("b", "", "片段 #" + (ctx.selected + 1)));
        const badge = st.cached ? el("span", "h3sd-badge ok", "已缓存")
            : st.will_render ? el("span", "h3sd-badge warn", "将重渲")
            : el("span", "h3sd-badge", "待渲染");
        head.appendChild(badge);
        if (seg.enabled === false) head.appendChild(el("span", "h3sd-badge bad", "未勾选"));
        info.appendChild(head);
        let start = 0;
        for (let i = 0; i < ctx.selected; i++) start += parseFloat(segs[i].duration) || 0;
        info.appendChild(el("div", "h3sd-dim",
            "时间 " + fmtTime(start) + " – " + fmtTime(start + (parseFloat(seg.duration) || 0))
            + (st.frames ? " · " + st.frames + " 帧 @24fps" : "")));
        if (st.seed != null) info.appendChild(el("div", "h3sd-dim", "seed " + st.seed));
        const ops = el("div", "h3sd-seg-ops");
        const en = el("input");
        en.type = "checkbox";
        en.checked = seg.enabled !== false;
        en.title = "选择运行：勾选才参与渲染";
        en.addEventListener("change", () => { seg.enabled = en.checked; ctx.refresh(); });
        ops.appendChild(en);
        const rb = el("button", "h3sd-btn", "↻ 重摇本段");
        rb.addEventListener("click", () => {
            segs.forEach((s, i) => { s.enabled = i === ctx.selected; });
            ctx.refresh();
        });
        ops.appendChild(rb);
        const prev = el("button", "h3sd-btn", "◀");
        prev.addEventListener("click", () => selectSeg(Math.max(0, ctx.selected - 1)));
        const next = el("button", "h3sd-btn", "▶");
        next.addEventListener("click", () => selectSeg(Math.min(segs.length - 1, ctx.selected + 1)));
        ops.appendChild(prev);
        ops.appendChild(next);
        const del = el("button", "h3sd-btn danger", "删除");
        del.addEventListener("click", () => {
            segs.splice(ctx.selected, 1);
            selectSeg(Math.max(0, ctx.selected - 1));
            ctx.refresh();
        });
        ops.appendChild(del);
        info.appendChild(ops);
    }

    function showScreen(url, live) {
        screen.innerHTML = "";
        if (url) {
            const img = document.createElement("img");
            img.src = url;
            screen.appendChild(img);
        } else {
            screen.appendChild(el("span", "h3sd-screen-empty", "🎬"));
        }
        if (live) screen.appendChild(el("div", "h3sd-live-tag", live));
    }

    function refreshScreen() {
        const st = ctx.statuses[ctx.selected] || {};
        showScreen(st.poster_file
            ? backend.artifactUrl(ctx.payload.run, "poster", st.poster_file) : null);
    }

    // ================= 胶片带 =================
    const fsBox = el("div", "h3sd-filmstrip");
    const ruler = el("div", "h3sd-fs-ruler");
    const track = el("div", "h3sd-fs-track");
    fsBox.appendChild(ruler);
    fsBox.appendChild(track);
    root.appendChild(fsBox);

    function filmstrip() {
        ruler.innerHTML = "";
        track.innerHTML = "";
        const segs = ctx.payload.segments;
        const total = totalDuration(ctx.payload) || 1;
        let t = 0;
        segs.forEach((s, i) => {
            const dur = parseFloat(s.duration) || 0;
            const tick = el("span", "h3sd-fs-tick", fmtTime(t));
            tick.style.left = (t / total * 100) + "%";
            ruler.appendChild(tick);
            const st = ctx.statuses[i] || {};
            const cell = el("div", "h3sd-fs-cell" + (i === ctx.selected ? " sel" : "")
                + (s.enabled === false ? " off" : ""));
            cell.style.width = Math.max(5, dur / total * 100) + "%";
            cell.title = "段 " + (i + 1) + " · " + dur + "s";
            if (st.poster_file) {
                const img = document.createElement("img");
                img.src = backend.artifactUrl(ctx.payload.run, "poster", st.poster_file);
                img.loading = "lazy";
                cell.appendChild(img);
            } else {
                cell.appendChild(el("span", "h3sd-fs-empty", "🎬"));
            }
            cell.appendChild(el("span", "h3sd-fs-dot " + (st.cached ? "ok" : st.will_render ? "warn" : "dim")));
            cell.appendChild(el("span", "h3sd-fs-idx", String(i + 1)));
            // 勾选（选择运行）
            const cb = el("input", "h3sd-fs-cb");
            cb.type = "checkbox";
            cb.checked = s.enabled !== false;
            cb.title = "勾选参与渲染";
            cb.addEventListener("click", (e) => e.stopPropagation());
            cb.addEventListener("change", () => { s.enabled = cb.checked; ctx.refresh(); });
            cell.appendChild(cb);
            // 右缘拖调时长：每 6px ≈ 0.1s
            const edge = el("div", "h3sd-fs-edge");
            edge.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                edge.setPointerCapture(e.pointerId);
                let acc = 0;
                const mv = (ev) => {
                    acc += ev.movementX;
                    const steps = Math.trunc(acc / 6);
                    if (steps) {
                        acc -= steps * 6;
                        s.duration = Math.max(1, Math.round(((parseFloat(s.duration) || 1) + steps * 0.1) * 10) / 10);
                        ctx.sync();
                        filmstrip();
                    }
                };
                const up = () => {
                    edge.removeEventListener("pointermove", mv);
                    edge.removeEventListener("pointerup", up);
                    ctx.refresh();
                };
                edge.addEventListener("pointermove", mv);
                edge.addEventListener("pointerup", up);
            });
            cell.appendChild(edge);
            // 拖拽换序
            cell.draggable = true;
            cell.addEventListener("dragstart", (e) => {
                e.dataTransfer.setData("text/h3sd-seg", String(i));
                e.dataTransfer.effectAllowed = "move";
            });
            cell.addEventListener("dragover", (e) => e.preventDefault());
            cell.addEventListener("drop", (e) => {
                e.preventDefault();
                const from = parseInt(e.dataTransfer.getData("text/h3sd-seg"), 10);
                if (!Number.isFinite(from) || from === i) return;
                const [m] = ctx.payload.segments.splice(from, 1);
                ctx.payload.segments.splice(i, 0, m);
                selectSeg(i);
                ctx.refresh();
            });
            cell.addEventListener("click", () => selectSeg(i));
            cell.addEventListener("dblclick", () => { if (st.mp4_file) playVideo(st.mp4_file); });
            track.appendChild(cell);
            t += dur;
        });
        const add = el("button", "h3sd-fs-add", "＋");
        add.title = "加一段";
        add.addEventListener("click", () => {
            ctx.payload.segments.push(newSegment(5));
            selectSeg(ctx.payload.segments.length - 1);
            ctx.refresh();
        });
        track.appendChild(add);
        const end = el("span", "h3sd-fs-tick", fmtTime(t));
        end.style.left = "calc(100% - 26px)";
        ruler.appendChild(end);
    }

    function selectSeg(i) {
        ctx.selected = Math.max(0, Math.min(ctx.payload.segments.length - 1, i));
        const seg = ctx.selectedSegment();
        promptTa.value = seg?.prompt || "";
        durIn.value = seg?.duration ?? 5;
        filmstrip();
        segInfo();
        editorRight();
        refreshScreen();
    }

    // ================= 段编辑区 =================
    const editRow = el("div", "h3sd-edit-row");
    const promptTa = el("textarea", "h3sd-prompt");
    promptTa.placeholder = "本段提示词：这一段发生什么（动作/镜头/声音）…";
    promptTa.rows = 5;
    promptTa.addEventListener("input", () => {
        const seg = ctx.selectedSegment();
        if (seg) seg.prompt = promptTa.value;
        ctx.sync();
    });
    editRow.appendChild(promptTa);

    // @ 引用补全：输入 @ 弹出可用素材标签
    function bindMentions(ta) {
        ta.addEventListener("input", () => {
            const pos = ta.selectionStart;
            if (ta.value[pos - 1] !== "@") return;
            const menu = el("div", "h3sd-mentions");
            const refs = [];
            let pic = 0, vid = 0, aud = 0;
            (ctx.payload.assets || []).forEach((a) => {
                if (!a.image) return;
                const k = a.kind || "image";
                if (k === "video") refs.push("<Video " + (++vid) + ">");
                else if (k === "audio") refs.push("<Audio " + (++aud) + ">");
                else refs.push("<Picture " + (++pic) + ">");
            });
            if (!refs.length) refs.push("<Picture 1>");
            refs.forEach((r) => {
                const item = el("div", "h3sd-mention", r);
                item.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    ta.value = ta.value.slice(0, pos) + r + ta.value.slice(pos);
                    ta.dispatchEvent(new Event("input"));
                    menu.remove();
                    ta.focus();
                });
                menu.appendChild(item);
            });
            document.body.appendChild(menu);
            const rect = ta.getBoundingClientRect();
            menu.style.left = rect.left + "px";
            menu.style.top = rect.bottom + 4 + "px";
            const close = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener("mousedown", close);
                }
            };
            setTimeout(() => document.addEventListener("mousedown", close), 0);
        });
    }
    bindMentions(promptTa);
    const right = el("div", "h3sd-edit-right");
    const durRow = el("div", "h3sd-field");
    durRow.appendChild(el("span", "h3sd-dim", "时长(秒)"));
    const durIn = el("input", "h3sd-dur");
    durIn.type = "number";
    durIn.step = "0.5";
    durIn.min = "1";
    durIn.addEventListener("change", () => {
        const seg = ctx.selectedSegment();
        if (seg) seg.duration = Math.max(1, parseFloat(durIn.value) || 1);
        ctx.refresh();
    });
    durRow.appendChild(durIn);
    right.appendChild(durRow);

    function frameSlot(key, label) {
        const slot = el("div", "h3sd-slot");
        const cur = ctx.selectedSegment()?.[key];
        if (cur && cur.image) {
            const img = document.createElement("img");
            img.src = backend.inputImageUrl(cur.image, cur.subfolder);
            slot.appendChild(img);
            slot.addEventListener("click", () => {
                ctx.selectedSegment()[key] = null;
                ctx.refresh();
            });
            slot.title = label + "（点击移除）";
        } else {
            slot.appendChild(el("span", "h3sd-slot-empty", label));
            slot.addEventListener("click", async () => {
                const f = await pickFile("image/*");
                if (!f) return;
                const name = await backend.uploadImage(f);
                ctx.selectedSegment()[key] = { image: name, subfolder: "" };
                ctx.refresh();
            });
            slot.title = label + "（点击上传）";
        }
        return slot;
    }

    function editorRight() {
        right.innerHTML = "";
        right.appendChild(durRow);
        durIn.value = ctx.selectedSegment()?.duration ?? 5;
        const seg = ctx.selectedSegment();
        if (!seg) return;
        const fl = el("div", "h3sd-field");
        fl.appendChild(frameSlot("first_frame", "首帧"));
        fl.appendChild(frameSlot("last_frame", "尾帧"));
        right.appendChild(fl);
        // 段级图钉（本段参考图，kind=image 的段资产）
        const pin = el("div", "h3sd-field");
        const pinSlot = el("div", "h3sd-slot");
        const a0 = (seg.assets || [])[0];
        if (a0 && a0.image) {
            const img = document.createElement("img");
            img.src = backend.inputImageUrl(a0.image, a0.subfolder);
            pinSlot.appendChild(img);
            pinSlot.title = "段级图钉（点击移除）";
            pinSlot.addEventListener("click", () => { seg.assets = []; ctx.refresh(); });
        } else {
            pinSlot.appendChild(el("span", "h3sd-slot-empty", "图钉"));
            pinSlot.title = "段级图钉（本段参考图，点击上传）";
            pinSlot.addEventListener("click", async () => {
                const f = await pickFile("image/*");
                if (!f) return;
                const name = await backend.uploadImage(f);
                seg.assets = [{ category: "参考", name: "", image: name, subfolder: "", note: "", kind: "image" }];
                ctx.refresh();
            });
        }
        pin.appendChild(pinSlot);
        right.appendChild(pin);
        if (seg.source) {
            const srcRow = el("div", "h3sd-field h3sd-src");
            srcRow.appendChild(el("span", "h3sd-badge warn", "v2v"));
            srcRow.appendChild(el("span", "h3sd-dim",
                seg.source.video + " " + seg.source.start + "-" + seg.source.end + "s"));
            const am = el("select");
            [["generate", "生成"], ["original", "原声"], ["mute", "静音"]].forEach(([v, label]) => {
                const o = el("option", "", label);
                o.value = v;
                if ((seg.audio_mode || "generate") === v) o.selected = true;
                am.appendChild(o);
            });
            am.addEventListener("change", () => { seg.audio_mode = am.value; ctx.sync(); });
            srcRow.appendChild(am);
            const x = el("button", "h3sd-btn danger", "×");
            x.addEventListener("click", () => { seg.source = null; ctx.refresh(); });
            srcRow.appendChild(x);
            right.appendChild(srcRow);
        }
    }
    editRow.appendChild(right);
    root.appendChild(editRow);

    // ================= 全局提示词 =================
    const gpWrap = el("div", "h3sd-gp");
    gpWrap.appendChild(el("div", "h3sd-sec-title", "全局提示词（所有段共享的前缀：主角设定/风格/世界观）"));
    const gpTa = el("textarea", "h3sd-prompt");
    gpTa.rows = 3;
    gpTa.value = ctx.payload.global_prompt || "";
    gpTa.addEventListener("input", () => { ctx.payload.global_prompt = gpTa.value; ctx.sync(); });
    gpWrap.appendChild(gpTa);
    bindMentions(gpTa);
    root.appendChild(gpWrap);

    // ================= 场景设定表 =================
    const setC = collapse("场景设定表", "改动全链重渲");
    const gRows = el("div", "h3sd-grows");
    function renderGlobals() {
        gRows.innerHTML = "";
        ctx.payload.globals.forEach((g, i) => {
            const row = el("div", "h3sd-grow");
            const cat = el("input", "h3sd-gcat");
            cat.value = g.category || "";
            cat.placeholder = "分类";
            cat.addEventListener("change", () => { g.category = cat.value; ctx.sync(); });
            const con = el("input", "h3sd-gcon");
            con.value = g.content || "";
            con.placeholder = "内容";
            con.addEventListener("input", () => { g.content = con.value; ctx.sync(); });
            const x = el("button", "h3sd-mini danger", "×");
            x.addEventListener("click", () => { ctx.payload.globals.splice(i, 1); renderGlobals(); ctx.sync(); });
            row.appendChild(cat);
            row.appendChild(con);
            row.appendChild(x);
            gRows.appendChild(row);
        });
        const add = el("button", "h3sd-mini", "+ 加一行");
        add.addEventListener("click", () => {
            ctx.payload.globals.push({ category: "通用", content: "" });
            renderGlobals();
            ctx.sync();
        });
        gRows.appendChild(add);
    }
    renderGlobals();
    setC.body.appendChild(gRows);
    root.appendChild(setC.head);
    root.appendChild(setC.body);

    // ================= 场景资产卡 =================
    const asC = collapse("场景资产卡", "带文件的卡注入每段（改动全链重渲）");
    const aGrid = el("div", "h3sd-agrid");
    function renderAssets() {
        aGrid.innerHTML = "";
        const counts = { image: 0, video: 0, audio: 0 };
        ctx.payload.assets.forEach((a, i) => {
            if (a.image) counts[a.kind || "image"]++;
            const card = el("div", "h3sd-acard");
            const th = el("div", "h3sd-athumb");
            if (a.image && (a.kind || "image") === "image") {
                const img = document.createElement("img");
                img.src = backend.inputImageUrl(a.image, a.subfolder);
                th.appendChild(img);
            } else {
                th.appendChild(el("span", "h3sd-thumb-empty",
                    a.kind === "video" ? "🎞" : a.kind === "audio" ? "♪" : "🖼"));
            }
            card.appendChild(th);
            const meta = el("div", "h3sd-ameta");
            const name = el("input", "h3sd-aname");
            name.value = a.name || "";
            name.placeholder = "名称";
            name.addEventListener("change", () => { a.name = name.value; ctx.sync(); });
            meta.appendChild(name);
            meta.appendChild(el("span", "h3sd-badge task",
                (a.kind === "video" ? "V" + counts.video : a.kind === "audio" ? "A" + counts.audio : "P" + counts.image)
                + " · " + (a.kind || "image")));
            const note = el("input", "h3sd-anote");
            note.value = a.note || "";
            note.placeholder = "备注（特征描述）";
            note.addEventListener("input", () => { a.note = note.value; ctx.sync(); });
            meta.appendChild(note);
            const tools = el("div", "h3sd-card-tools");
            const up = el("button", "h3sd-mini", "替换");
            up.addEventListener("click", async () => {
                const accept = a.kind === "video" ? "video/*" : a.kind === "audio" ? "audio/*" : "image/*";
                const f = await pickFile(accept);
                if (!f) return;
                a.image = a.kind === "video" ? await backend.uploadVideo(f) : await backend.uploadImage(f);
                a.subfolder = "";
                renderAssets();
                ctx.refresh();
            });
            tools.appendChild(up);
            const x = el("button", "h3sd-mini danger", "×");
            x.addEventListener("click", () => { ctx.payload.assets.splice(i, 1); renderAssets(); ctx.refresh(); });
            tools.appendChild(x);
            meta.appendChild(tools);
            card.appendChild(meta);
            aGrid.appendChild(card);
        });
    }
    renderAssets();
    asC.body.appendChild(aGrid);
    const aBar = el("div", "h3sd-card-tools");
    [["image", "🖼 图"], ["video", "🎞 视频"], ["audio", "♪ 音频"], ["text", "📝 文本"]].forEach(([k, label]) => {
        const b = el("button", "h3sd-mini", label);
        b.addEventListener("click", async () => {
            const a = newAsset(k === "text" ? "image" : k);
            if (k !== "text") {
                const f = await pickFile(k === "video" ? "video/*" : k === "audio" ? "audio/*" : "image/*");
                if (!f) return;
                a.image = k === "video" ? await backend.uploadVideo(f) : await backend.uploadImage(f);
            }
            ctx.payload.assets.push(a);
            renderAssets();
            ctx.refresh();
        });
        aBar.appendChild(b);
    });
    asC.body.appendChild(aBar);
    root.appendChild(asC.head);
    root.appendChild(asC.body);

    // ================= 源视频（v2v） =================
    const srcC = collapse("源视频（v2v/rv2v：上传后分镜成段）");
    const srcBody = el("div", "h3sd-src-panel");
    const srcInfo = el("div", "h3sd-dim", "未上传源视频");
    const srcUp = el("button", "h3sd-btn", "上传源视频");
    const srcState = { video: null, info: null };
    srcUp.addEventListener("click", async () => {
        const f = await pickFile("video/*");
        if (!f) return;
        srcUp.disabled = true;
        try {
            srcState.video = await backend.uploadVideo(f, (p) => {
                srcInfo.textContent = "上传中 " + Math.round(p * 100) + "%";
            });
            srcState.info = await backend.probe(srcState.video);
            srcInfo.textContent = srcState.video + " · " + srcState.info.duration + "s · "
                + srcState.info.width + "x" + srcState.info.height
                + (srcState.info.has_audio ? " · ♪" : " · 无音轨");
        } catch (e) {
            srcInfo.textContent = "探测失败: " + e.message;
        } finally {
            srcUp.disabled = false;
        }
    });
    srcBody.appendChild(srcUp);
    const srcAppend = el("button", "h3sd-btn", "追加视频");
    srcAppend.title = "再传一个源视频，按智能分镜切成段追加到末尾";
    srcAppend.addEventListener("click", async () => {
        const f = await pickFile("video/*");
        if (!f) return;
        srcAppend.disabled = true;
        try {
            const v = await backend.uploadVideo(f);
            const info = await backend.probe(v);
            const r = await backend.smartSplit(v, "medium", 24, Math.round(info.duration * 24));
            const frames = (r.cutFrames || []).filter((x) => x > 0);
            const bounds = [0].concat(frames.map((x) => x / 24));
            let added = 0;
            for (let k = 0; k + 1 < bounds.length; k++) {
                const seg = newSegment(Math.max(1, Math.round((bounds[k + 1] - bounds[k]) * 100) / 100));
                seg.source = { video: v, subfolder: "",
                               start: Math.round(bounds[k] * 100) / 100,
                               end: Math.round(bounds[k + 1] * 100) / 100 };
                seg.nonce = "app" + (ctx.payload.segments.length + 1);
                ctx.payload.segments.push(seg);
                added++;
            }
            if (!added) {
                const seg = newSegment(Math.max(1, Math.round(info.duration * 100) / 100));
                seg.source = { video: v, subfolder: "", start: 0,
                               end: Math.round(info.duration * 100) / 100 };
                ctx.payload.segments.push(seg);
            }
            ctx.refresh();
        } catch (e) {
            srcInfo.textContent = "追加失败: " + e.message;
        } finally {
            srcAppend.disabled = false;
        }
    });
    srcBody.appendChild(srcAppend);
    srcBody.appendChild(srcInfo);
    srcC.body.appendChild(srcBody);
    root.appendChild(srcC.head);
    root.appendChild(srcC.body);

    function sourcePanelRefresh() {
        // 有源视频或任务为 v2v/rv2v 时展开面板提示
        const isV2v = ["v2v", "rv2v"].includes(ctx.payload.task);
        srcC.head.style.display = "";
        splitBtn.style.display = (srcState.video || isV2v) ? "" : "none";
    }

    async function doSmartSplit() {
        if (!srcState.video || !srcState.info) {
            srcInfo.textContent = "请先上传源视频";
            srcC.body.classList.remove("hidden");
            return;
        }
        splitBtn.disabled = true;
        splitBtn.textContent = "分镜中…";
        try {
            const r = await backend.smartSplit(srcState.video, "medium", 24,
                Math.round(srcState.info.duration * 24));
            const frames = (r.cutFrames || []).filter((x) => x > 0);
            const bounds = [0].concat(frames.map((f) => f / 24));
            for (let k = 0; k + 1 < bounds.length; k++) {
                const seg = newSegment(Math.max(1, Math.round((bounds[k + 1] - bounds[k]) * 100) / 100));
                seg.source = { video: srcState.video, subfolder: "",
                               start: Math.round(bounds[k] * 100) / 100,
                               end: Math.round(bounds[k + 1] * 100) / 100 };
                seg.nonce = "src" + (k + 1);
                ctx.payload.segments.push(seg);
            }
            ctx.payload.task = "v2v";
            taskSel.value = "v2v";
            ctx.refresh();
        } catch (e) {
            srcInfo.textContent = "分镜失败: " + e.message;
        } finally {
            splitBtn.disabled = false;
            splitBtn.textContent = "✂ 智能分镜";
        }
    }

    // ================= LLM 增强 =================
    const enhancer = buildEnhancer(ctx);
    root.appendChild(enhancer.root);

    // ================= 运行状态 =================
    const runBar = el("div", "h3sd-runbar");
    const runText = el("span", "h3sd-run-text", "运行状态：待命");
    const prog = el("div", "h3sd-progress");
    const progFill = el("div", "h3sd-progress-fill");
    prog.appendChild(progFill);
    runBar.appendChild(runText);
    runBar.appendChild(prog);
    root.appendChild(runBar);

    function updateStats() {
        const segs = ctx.payload.segments;
        const cached = ctx.statuses.filter((s) => s.cached).length;
        stats.textContent = "共 " + segs.length + " 段 · 总长 " + fmtTime(totalDuration(ctx.payload))
            + " · 已缓存 " + cached + "/" + segs.length;
    }

    let statusTimer = null;
    async function fetchStatus() {
        try {
            const r = await backend.status({
                run: ctx.payload.run,
                global_prompt: ctx.payload.global_prompt,
                globals: ctx.payload.globals,
                assets: ctx.payload.assets,
                segments: ctx.payload.segments,
            });
            ctx.statuses = r.statuses || [];
            updateStats();
            filmstrip();
            segInfo();
            refreshScreen();
            const next = r.first_dirty;
            runText.textContent = "运行状态：待命 · 缓存 " + r.rendered + "/" + r.total
                + (next != null && next < r.total ? "，下次从第 " + (next + 1) + " 段起重渲" : "");
        } catch (e) { /* 静默 */ }
    }
    function scheduleStatus() {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(fetchStatus, 600);
    }

    onProgress((d) => {
        if (d.run && d.run !== ctx.payload.run) return;
        if (d.done) {
            progFill.style.width = "100%";
            runText.textContent = "运行状态：完成";
            fetchStatus();
            return;
        }
        const total = d.total || 1;
        const pct = ((d.cached || 0) + Math.max(0, (d.segment || 1) - 1)) / total * 100;
        progFill.style.width = pct + "%";
        runText.textContent = "运行状态：渲染中 段 " + d.segment + "/" + total;
        scheduleStatus();
    });
    onStep((d) => {
        if (d.run && d.run !== ctx.payload.run) return;
        showScreen("data:image/jpeg;base64," + d.image,
            "实时预览 · 段 " + d.segment + "/" + d.total + " · step " + d.step + "/" + d.steps);
    });

    // 节点尺寸钳制 + 载入时强制最小尺寸（老工作流里节点可能很小）
    const origResize = node.onResize;
    node.onResize = function (size) {
        size[0] = Math.max(900, size[0]);
        size[1] = Math.max(700, size[1]);
        if (origResize) origResize.call(this, size);
    };
    const forceMinSize = () => {
        const w = Math.max(900, node.size?.[0] || 0);
        const h = Math.max(700, node.size?.[1] || 0);
        if (w !== node.size?.[0] || h !== node.size?.[1]) node.setSize([w, h]);
    };
    forceMinSize();

    // 工作流载入
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        if (origConfigure) origConfigure.call(this, info);
        ctx.payload = parseWidgetValue(tlWidget.value);
        runIn.value = ctx.payload.run || "story";
        gpTa.value = ctx.payload.global_prompt || "";
        taskSel.value = ctx.payload.task || "t2v";
        renderGlobals();
        renderAssets();
        forceMinSize();
        selectSeg(ctx.selected);
        ctx.refresh();
    };

    // 初始化
    if (!ctx.payload.segments.length) ctx.payload.segments.push(newSegment(5));
    selectSeg(0);
    sourcePanelRefresh();
    ctx.refresh();
}

app.registerExtension({
    name: "h3.scenedirector.workbench",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            try {
                buildWorkbench(this);
            } catch (e) {
                console.error("SceneDirector 工作台构建失败", e);
            }
            return r;
        };
    },
});
