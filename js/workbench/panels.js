// SceneDirector 工作台：场景设定表 + 资产卡 + 源视频面板
import { t } from "./i18n.js";
import { newAsset } from "./state.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

// 场景设定表：{category, content} 行
export function buildGlobals(ctx) {
    const box = el("div", "h3sd-globals");
    box.appendChild(el("div", "h3sd-sec-title", t("globals")));

    const gp = el("textarea", "h3sd-gp");
    gp.rows = 2;
    gp.placeholder = "global_prompt（场景级自由文本）";
    gp.value = ctx.payload.global_prompt || "";
    gp.addEventListener("input", () => { ctx.payload.global_prompt = gp.value; ctx.sync(); });
    box.appendChild(gp);

    const rows = el("div", "h3sd-grows");
    function render() {
        rows.innerHTML = "";
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
            x.addEventListener("click", () => {
                ctx.payload.globals.splice(i, 1);
                ctx.refresh();
            });
            row.appendChild(cat); row.appendChild(con); row.appendChild(x);
            rows.appendChild(row);
        });
    }
    render();
    const add = el("button", "h3sd-add", t("addRow"));
    add.addEventListener("click", () => {
        ctx.payload.globals.push({ category: "通用", content: "" });
        render();
        ctx.sync();
    });
    box.appendChild(rows);
    box.appendChild(add);
    return { root: box, render };
}

// 资产卡：{category, name, image, kind, note}，支持 图片/视频/音频
export function buildAssets(ctx) {
    const box = el("div", "h3sd-assets");
    box.appendChild(el("div", "h3sd-sec-title", t("assets")));
    const grid = el("div", "h3sd-agrid");

    function card(a, i) {
        const c = el("div", "h3sd-acard");
        const th = el("div", "h3sd-athumb");
        if (a.image && a.kind !== "audio") {
            const img = document.createElement("img");
            img.src = ctx.inputImageUrl(a.image, a.subfolder);
            th.appendChild(img);
            th.addEventListener("click", () => ctx.zoomImage(img.src));
        } else {
            th.appendChild(el("span", "h3sd-thumb-empty",
                a.kind === "video" ? "🎞" : a.kind === "audio" ? "♪" : "🖼"));
        }
        c.appendChild(th);
        const meta = el("div", "h3sd-ameta");
        const name = el("input", "h3sd-aname");
        name.value = a.name || "";
        name.placeholder = "名称";
        name.addEventListener("change", () => { a.name = name.value; ctx.sync(); });
        meta.appendChild(name);
        meta.appendChild(el("span", "h3sd-badge task", a.kind || "image"));
        const note = el("input", "h3sd-anote");
        note.value = a.note || "";
        note.placeholder = "备注（特征描述）";
        note.addEventListener("input", () => { a.note = note.value; ctx.sync(); });
        meta.appendChild(note);
        const tools = el("div", "h3sd-card-tools");
        const up = el("button", "h3sd-mini", t("replace"));
        up.addEventListener("click", async () => {
            const accept = a.kind === "video" ? "video/*" : a.kind === "audio" ? "audio/*" : "image/*";
            const file = await ctx.pickFile(accept);
            if (!file) return;
            if (a.kind === "video") {
                a.image = await ctx.uploadVideo(file);
            } else {
                a.image = await ctx.uploadImage(file);
            }
            ctx.refresh();
        });
        tools.appendChild(up);
        const x = el("button", "h3sd-mini danger", "×");
        x.addEventListener("click", () => {
            ctx.payload.assets.splice(i, 1);
            ctx.refresh();
        });
        tools.appendChild(x);
        meta.appendChild(tools);
        c.appendChild(meta);
        return c;
    }

    function render() {
        grid.innerHTML = "";
        ctx.payload.assets.forEach((a, i) => grid.appendChild(card(a, i)));
    }
    render();
    const bar = el("div", "h3sd-card-tools");
    [["image", "🖼 图"], ["video", "🎞 视频"], ["audio", "♪ 音频"], ["text", "📝 文本"]].forEach(([k, label]) => {
        const b = el("button", "h3sd-mini", label);
        b.addEventListener("click", async () => {
            const a = newAsset(k === "text" ? "image" : k);
            if (k !== "text") {
                const accept = k === "video" ? "video/*" : k === "audio" ? "audio/*" : "image/*";
                const file = await ctx.pickFile(accept);
                if (!file) return;
                a.image = k === "video" ? await ctx.uploadVideo(file) : await ctx.uploadImage(file);
            }
            ctx.payload.assets.push(a);
            ctx.refresh();
        });
        bar.appendChild(b);
    });
    box.appendChild(grid);
    box.appendChild(bar);
    return { root: box, render };
}

// 源视频面板（v2v）：上传/探测/智能分镜 → 生成带 source 的段
export function buildSource(ctx) {
    const box = el("div", "h3sd-source-panel");
    const head = el("div", "h3sd-sec-title", t("source"));
    box.appendChild(head);

    const state = { video: null, info: null };
    const infoLine = el("div", "h3sd-src-info", "—");
    const up = el("button", "h3sd-add", t("uploadSource"));
    up.addEventListener("click", async () => {
        const file = await ctx.pickFile("video/*");
        if (!file) return;
        up.disabled = true;
        try {
            state.video = await ctx.uploadVideo(file, (p) => {
                infoLine.textContent = "上传中 " + Math.round(p * 100) + "%";
            });
            state.info = await ctx.probe(state.video);
            infoLine.textContent = state.video + " · " + state.info.duration + "s · "
                + state.info.width + "x" + state.info.height
                + (state.info.has_audio ? " · ♪" : " · 无音轨");
        } catch (e) {
            infoLine.textContent = t("probeFail") + ": " + e.message;
        } finally {
            up.disabled = false;
        }
    });
    box.appendChild(up);
    box.appendChild(infoLine);

    const splitBar = el("div", "h3sd-card-tools");
    [["均分", "equal"], [t("smartSplit") + "·低", "low"], [t("smartSplit") + "·中", "medium"],
     [t("smartSplit") + "·高", "high"]].forEach(([label, mode]) => {
        const b = el("button", "h3sd-mini", label);
        b.addEventListener("click", async () => {
            if (!state.video || !state.info) return;
            b.disabled = true;
            try {
                let points = [];
                if (mode === "equal") {
                    const n = Math.max(1, Math.round(state.info.duration / 5));
                    for (let k = 1; k < n; k++) points.push(round2(state.info.duration * k / n));
                } else {
                    const r = await ctx.smartSplit(state.video, mode);
                    points = r.cuts || [];
                }
                const bounds = [0].concat(points, [round2(state.info.duration)]);
                for (let k = 0; k + 1 < bounds.length; k++) {
                    const seg = {
                        duration: Math.max(1, round2(bounds[k + 1] - bounds[k])),
                        prompt: "", nonce: "src" + (k + 1), assets: [], enabled: true,
                        first_frame: null, last_frame: null,
                        source: { video: state.video, subfolder: "", start: bounds[k], end: bounds[k + 1] },
                        audio_mode: "generate", task: "v2v",
                    };
                    ctx.payload.segments.push(seg);
                }
                ctx.toast(t("splitDone") + ": " + (bounds.length - 1) + " 段");
                ctx.refresh();
            } catch (e) {
                ctx.toast("分镜失败: " + e.message);
            } finally {
                b.disabled = false;
            }
        });
        splitBar.appendChild(b);
    });
    box.appendChild(splitBar);
    return { root: box, render() { /* 无内部重绘需求 */ } };
}

function round2(x) { return Math.round(x * 100) / 100; }
