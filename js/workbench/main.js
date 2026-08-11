// SceneDirector 工作台主装配：注册扩展、构建 DOM、状态同步、事件与轮询
import { app } from "../../scripts/app.js";

// 样式注入（ComfyUI 只自动加载 js，css 需要手动挂）
const _css = document.createElement("link");
_css.rel = "stylesheet";
_css.href = new URL("./style.css", import.meta.url).href;
document.head.appendChild(_css);
import { backend, onProgress, onStep } from "./api.js";
import { parseWidgetValue, enabledCount } from "./state.js";
import { t, toggleLang } from "./i18n.js";
import { buildTimeline, buildCards } from "./timeline.js";
import { buildGlobals, buildAssets, buildSource } from "./panels.js";
import { buildStage } from "./stage.js";

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

function toast(msg) {
    const d = el("div", "h3sd-toast", msg);
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3200);
}

function buildWorkbench(node) {
    const widget = node.widgets.find((w) => w.name === "segments");
    if (!widget) return;
    // 隐藏原生 multiline 文本框，工作台接管载荷的编辑与序列化
    widget.type = "hidden";
    const runWidget = node.widgets.find((w) => w.name === "run_name");

    const root = el("div", "h3sd-root");
    node.addDOMWidget("h3sd_workbench", "H3SD Workbench", root, {
        getValue: () => "",
        setValue: () => { },
    });

    const ctx = {
        node,
        payload: parseWidgetValue(widget.value),
        statuses: [],
        selected: 0,
        pickFile,
        toast,
        artifactUrl: (run, kind, file) => backend.artifactUrl(run, kind, file),
        inputImageUrl: (name, subfolder) =>
            "/view?filename=" + encodeURIComponent(name) + "&type=input"
            + (subfolder ? "&subfolder=" + encodeURIComponent(subfolder) : ""),
        uploadImage: (f) => backend.uploadImage(f),
        uploadVideo: (f, cb) => backend.uploadVideo(f, cb),
        probe: (v) => backend.probe(v),
        smartSplit: (v, s) => backend.smartSplit(v, "", s, 1.0),
        enhance: (p, task, dur) => backend.enhance(p, task, dur),
        playVideo(file) {
            const v = document.createElement("video");
            v.src = ctx.artifactUrl(ctx.payload.run, "mp4", file);
            v.controls = true;
            v.autoplay = true;
            stage.lightbox(v);
        },
        zoomImage(src) {
            const img = document.createElement("img");
            img.src = src;
            stage.lightbox(img);
        },
        sync() {
            widget.value = JSON.stringify(ctx.payload);
            app.graph.setDirtyCanvas(true, true);
        },
        refresh() {
            ctx.sync();
            strip.render();
            cards.render();
            scheduleStatus();
        },
        bindMentions(ta) {
            // @ 引用补全：弹出当前可用素材标签，点击插入
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
                refs.push("<Video 1>（源片段）");
                refs.forEach((r) => {
                    const item = el("div", "h3sd-mention", r);
                    item.addEventListener("mousedown", (e) => {
                        e.preventDefault();
                        ta.value = ta.value.slice(0, pos) + r + ta.value.slice(pos);
                        ctx.payload.segments.forEach((s) => {
                            if (s.prompt !== undefined && ta.value.includes(r)) { /* 值已在 ta */ }
                        });
                        menu.remove();
                        ta.dispatchEvent(new Event("input"));
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
        },
    };

    // ---- 工具条 ----
    const bar = el("div", "h3sd-toolbar");
    const runInput = el("input", "h3sd-run");
    runInput.value = ctx.payload.run || "story";
    runInput.title = "run（缓存目录名）";
    runInput.addEventListener("change", () => {
        ctx.payload.run = runInput.value.trim() || "story";
        if (runWidget) runWidget.value = ctx.payload.run;
        ctx.refresh();
    });
    bar.appendChild(runInput);
    const stat = el("span", "h3sd-stat", "");
    bar.appendChild(stat);
    const langBtn = el("button", "h3sd-mini", "EN");
    langBtn.addEventListener("click", () => {
        toggleLang();
        rebuildAll();
    });
    bar.appendChild(langBtn);
    root.appendChild(bar);

    const stage = buildStage(ctx);
    root.appendChild(stage.root);
    const strip = buildTimeline(ctx);
    root.appendChild(strip.root);
    const cols = el("div", "h3sd-cols");
    const cards = buildCards(ctx);
    cols.appendChild(cards.root);
    const side = el("div", "h3sd-side");
    const globals = buildGlobals(ctx);
    const assets = buildAssets(ctx);
    const source = buildSource(ctx);
    side.appendChild(globals.root);
    side.appendChild(assets.root);
    side.appendChild(source.root);
    cols.appendChild(side);
    root.appendChild(cols);

    function rebuildAll() {
        bar.querySelector(".h3sd-stat");
        root.innerHTML = "";
        // 语言切换后整体重建（简单可靠）
        buildWorkbench2();
    }
    function buildWorkbench2() {
        // 重新装配（复用同一 ctx/payload）
        root.appendChild(bar);
        root.appendChild(stage.root);
        root.appendChild(strip.root);
        root.appendChild(cols);
        statUpdate();
    }

    // ---- 状态轮询与事件 ----
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
            statUpdate(r);
            cards.render();
            updateStagePoster();
        } catch (e) { /* 后端不可达时静默 */ }
    }
    function scheduleStatus() {
        clearTimeout(statusTimer);
        statusTimer = setTimeout(fetchStatus, 600);
    }
    function statUpdate(r) {
        const [en, all] = enabledCount(ctx.payload);
        stat.textContent = all + " 段 · 勾选 " + en
            + (r ? " · 缓存 " + r.rendered + "/" + r.total : "");
    }
    function updateStagePoster() {
        const st = ctx.statuses[ctx.selected] || {};
        stage.showPoster(st.poster_file
            ? ctx.artifactUrl(ctx.payload.run, "poster", st.poster_file) : null);
    }

    onProgress((d) => {
        if (d.run && d.run !== ctx.payload.run) return;
        if (d.done) {
            stage.setProgress(100, "100%");
            stage.clearLive();
            fetchStatus();
            return;
        }
        const total = d.total || 1;
        const pct = ((d.cached || 0) + Math.max(0, (d.segment || 1) - 1)) / total * 100;
        stage.setProgress(pct);
        scheduleStatus();
    });
    onStep((d) => {
        if (d.run && d.run !== ctx.payload.run) return;
        stage.showLive(d);
    });

    // 节点尺寸钳制：工作台不能再缩
    const origResize = node.onResize;
    node.onResize = function (size) {
        size[0] = Math.max(880, size[0]);
        size[1] = Math.max(660, size[1]);
        if (origResize) origResize.call(this, size);
    };
    node.size = [1000, 760];

    // 工作流载入时重建
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        if (origConfigure) origConfigure.call(this, info);
        ctx.payload = parseWidgetValue(widget.value);
        runInput.value = ctx.payload.run || "story";
        ctx.refresh();
    };

    statUpdate();
    scheduleStatus();
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
                console.error("H3SceneDirector workbench 构建失败", e);
            }
            return r;
        };
    },
});
