// enhance.js —— v2 提示词增强器：配置面板（llm_* widget 持久化）+
// 每段魔法棒（enhanceTarget）+ 内联预览-确认-应用。
//
// 调用链：🪄 -> POST /minimax/director/enhance -> ed.preview -> cards.js
// 渲染内联预览块 -> 「应用」-> applyPreview() 写回状态 + commit。
// 视觉参考（参考图/首帧）经 /minimax/director/image_b64 取 base64 随请求发给 LLM。
import { app } from "../../../scripts/app.js";
import { el, splitRel, taskKeyFromLabel } from "./util.js";

export function createEnhancer(ed, { api }) {
    const { store } = ed;
    const W = (name) => (node_widgets()).find((w) => w.name === name);
    function node_widgets() { return ed.node.widgets || []; }

    // --- 配置面板（折叠） -------------------------------------------------------
    const root = el("div", "sd2-pe");
    const head = el("div", "sd2-pe-head");
    const headTitle = el("span", "ttl", "LLM 提示词增强器");
    const headSum = el("span", "meta");
    const foldBtn = el("button", "sd2-btn sm", "展开");
    head.appendChild(headTitle);
    head.appendChild(headSum);
    head.appendChild(el("span", "sp"));
    head.appendChild(foldBtn);
    root.appendChild(head);

    const body = el("div", "sd2-pe-body hidden");
    root.appendChild(body);

    const fields = {};
    function row(label, input) {
        const r = el("div", "sd2-pe-row");
        r.appendChild(el("span", "lbl", label));
        r.appendChild(input);
        body.appendChild(r);
        return input;
    }
    function textInput(wname, placeholder, type) {
        const inp = el("input", "sd2-inp");
        inp.type = type || "text";
        inp.placeholder = placeholder || "";
        fields[wname] = inp;
        inp.addEventListener("change", () => { save(wname, inp.value); updateSum(); });
        return inp;
    }

    const fmt = el("select", "sd2-inp");
    fmt.appendChild(new Option("OpenAI Compatible", "OpenAI Compatible"));
    fmt.appendChild(new Option("Anthropic", "Anthropic"));
    fields.llm_api_format = fmt;
    fmt.addEventListener("change", () => {
        save("llm_api_format", fmt.value);
        // 格式默认端点提示
        if (!fields.llm_url.value || fields.llm_url.value === fields.llm_url.placeholder) {
            fields.llm_url.placeholder = fmt.value === "Anthropic"
                ? "https://api.anthropic.com" : "http://127.0.0.1:11434/v1";
        }
        updateSum();
    });

    row("API 格式", fmt);
    row("端点", textInput("llm_url", "http://127.0.0.1:11434/v1"));
    row("密钥", textInput("llm_api_key", "sk-...（可留空）", "password"));
    row("模型", textInput("llm_model", "qwen3"));
    const lang = el("select", "sd2-inp");
    lang.appendChild(new Option("中文", "中文"));
    lang.appendChild(new Option("English", "English"));
    fields.llm_output_language = lang;
    lang.addEventListener("change", () => save("llm_output_language", lang.value));
    row("扩写语言", lang);

    const detail = document.createElement("input");
    detail.type = "checkbox";
    fields.llm_character_feature_enhance = detail;
    detail.addEventListener("change", () => save("llm_character_feature_enhance", detail.checked));
    const detailLbl = el("label", "lbl chk");
    detailLbl.appendChild(detail);
    detailLbl.appendChild(document.createTextNode(" 角色特征增强（提示词补到 ~300 汉字）"));
    const detailRow = el("div", "sd2-pe-row");
    detailRow.appendChild(el("span", "lbl", "选项"));
    detailRow.appendChild(detailLbl);
    body.appendChild(detailRow);

    const tpl = el("textarea", "sd2-prompt");
    tpl.rows = 3;
    tpl.placeholder = "自定义模板（留空 = 官方 task 模板）";
    fields.llm_custom_template = tpl;
    tpl.addEventListener("change", () => save("llm_custom_template", tpl.value));
    const tplRow = el("div", "sd2-pe-row");
    tplRow.appendChild(el("span", "lbl", "模板"));
    tplRow.appendChild(tpl);
    body.appendChild(tplRow);

    // 模型联动（两系模型位；切模式自动换 UNETLoader，无需手动）
    const modelOpts = (() => {
        try {
            const nodes = app.graph?._nodes || [];
            const byId = (id) => nodes.find((n) => String(n.id) === String(id));
            const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
            let src = chain?.inputs?.[0]?.link != null
                ? byId(app.graph.links[chain.inputs[0].link]?.origin_id) : null;
            let hops = 0;
            while (src && src.type !== "UNETLoader" && hops < 4) {
                const inp = src.inputs?.find((i) => i.link != null && /MODEL/i.test(i.type || ""));
                if (!inp) break;
                src = byId(app.graph.links[inp.link]?.origin_id);
                hops += 1;
            }
            const vals = src?.widgets?.find((w) => w.name === "unet_name")?.options?.values;
            return Array.isArray(vals) && vals.length ? vals : null;
        } catch (e) { return null; }
    })();
    function modelSel(label, field, fallback) {
        const sel = el("select", "sd2-inp");
        for (const v of (modelOpts || [fallback])) {
            sel.appendChild(new Option(v.replace(/^minimax_h3_|\.safetensors$/g, ""), v));
        }
        const out = store.get().output;
        const cur = out[field] || fallback;
        if (![...sel.options].some((x) => x.value === cur)) sel.appendChild(new Option(cur, cur));
        sel.value = cur;
        sel.title = "切模式时自动换 UNETLoader 的模型（此处只是选文件，切换是自动的）";
        sel.addEventListener("change", () => {
            out[field] = sel.value;
            store.commit();
            ed.linkModel?.(store.mode());
        });
        const wrap = el("span", "sd2-pe-model");
        wrap.appendChild(el("span", "lbl", label));
        wrap.appendChild(sel);
        return wrap;
    }
    const modelRow = el("div", "sd2-pe-row");
    modelRow.appendChild(el("span", "lbl", "模型联动"));
    modelRow.appendChild(modelSel("生成系(t2v/i2v/fl2v)", "modelGen",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors"));
    modelRow.appendChild(modelSel("参考系(r2v/v2v/rv2v)", "modelRef",
        "minimax_h3_ref2va_pruned_int8_convrot.safetensors"));
    body.appendChild(modelRow);

    const statusLine = el("div", "sd2-pe-status", "");
    body.appendChild(statusLine);

    foldBtn.addEventListener("click", () => {
        const open = body.classList.toggle("hidden");
        foldBtn.textContent = open ? "收起" : "展开";
    });

    function save(wname, value) {
        const w = W(wname);
        if (w) w.value = value;   // 纯赋值（契约第 7 条）
        app_setdirty();
    }
    function app_setdirty() { /* graph dirty 由 commit 统一负责；配置改动轻量 */ 
        try { ed.node.setDirtyCanvas?.(true, true); } catch (e) { /* 忽略 */ }
    }
    function loadAll() {
        for (const [name, inp] of Object.entries(fields)) {
            const w = W(name);
            if (!w) continue;
            if (inp.type === "checkbox") inp.checked = !!w.value;
            else inp.value = String(w.value ?? "");
        }
        updateSum();
    }
    function updateSum() {
        headSum.textContent = (fields.llm_api_format.value || "OpenAI Compatible")
            + " · " + (fields.llm_model.value || "未配模型")
            + " · " + (fields.llm_output_language.value || "中文");
    }
    loadAll();

    function setStatus(text, kind) {
        statusLine.textContent = text || "";
        statusLine.className = "sd2-pe-status" + (kind ? " " + kind : "");
        // 错误发生在折叠面板里用户看不见——自动展开让人知道死在哪
        if (kind === "error" && body.classList.contains("hidden")) {
            body.classList.remove("hidden");
            foldBtn.textContent = "收起";
        }
    }

    // --- LLM 调用 ---------------------------------------------------------------

    async function imageB64(imageFile) {
        const { image, subfolder } = splitRel(imageFile);
        if (!image) return null;
        try {
            const r = await api.fetchApi("/minimax/director/image_b64", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageFile: image, subfolder }),
            });
            if (r.ok) return (await r.json()).image_b64 || null;
        } catch (e) { /* 单图失败不挡主流程 */ }
        return null;
    }

    function targetInfo(target) {
        const s = store.get();
        const mode = store.mode();
        if (target === "global") {
            const d0 = s.segments[0]?.durationSec;
            return {
                name: "全局提示词",
                taskKey: mode,
                prompt: String(s.global.prompt || "").trim(),
                imageFiles: (s.global.refs || []).map((r) => r.imageFile).filter(Boolean),
                duration: Number(d0) || 5.0,
            };
        }
        if (typeof target === "string" && target.startsWith("shot:")) {
            const i = parseInt(target.slice(5), 10);
            const sh = s.shots[i];
            if (!sh) return null;
            return {
                name: "镜 " + (i + 1),
                taskKey: "fl2v",
                prompt: String(sh.prompt || "").trim(),
                imageFiles: [sh.startImage?.imageFile, sh.endImage?.imageFile].filter(Boolean),
                duration: Number(sh.durationSec) || 5.0,
            };
        }
        const i = Number.isInteger(target) ? target : ed.selectedIndex;
        const seg = s.segments[i];
        if (!seg) return null;
        const files = (seg.refs || []).map((r) => r.imageFile).filter(Boolean);
        if (seg.genImage?.imageFile) files.unshift(seg.genImage.imageFile);
        return {
            name: "片段 " + (i + 1),
            taskKey: taskKeyFromLabel(seg.taskType || mode),
            prompt: String(seg.prompt || "").trim(),
            imageFiles: files,
            duration: Number(seg.durationSec) || 5.0,
        };
    }

    async function enhanceTarget(target) {
        const info = targetInfo(target);
        if (!info) return;
        if (!info.prompt) { setStatus(info.name + " 还没有提示词", "error"); return; }
        const model = fields.llm_model.value.trim();
        if (!model) {
            setStatus("请先填模型名", "error");
            body.classList.remove("hidden");
            foldBtn.textContent = "收起";
            return;
        }
        setStatus("正在扩写: " + info.name + "…", "loading");
        // 视觉参考最多 3 张（参考图/首帧），失败静默降级为纯文本扩写
        const images = [];
        for (const f of info.imageFiles.slice(0, 3)) {
            const b64 = await imageB64(f);
            if (b64) images.push(b64);
        }
        try {
            const resp = await api.fetchApi("/minimax/director/enhance", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    llm_url: fields.llm_url.value.trim(),
                    model,
                    prompt: info.prompt,
                    task_type: info.taskKey,
                    duration: info.duration || 5.0,
                    image_num: Math.max(1, images.length),
                    images,
                    api_format: fields.llm_api_format.value,
                    api_key: fields.llm_api_key.value,
                    output_language: fields.llm_output_language.value,
                    character_feature_enhance: fields.llm_character_feature_enhance.checked,
                    custom_template: fields.llm_custom_template.value.trim(),
                }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) {
                setStatus("扩写失败: " + (data.error || "HTTP " + resp.status), "error");
                return;
            }
            const text = String(data.response || "").trim();
            if (!text) { setStatus("扩写返回为空", "error"); return; }
            ed.preview = { text, target, name: info.name };
            setStatus(info.name + " 扩写完成（" + text.length + " 字符），在卡片里确认", "success");
            ed.render();
        } catch (e) {
            setStatus("请求失败: " + (e?.message || e), "error");
        }
    }

    // 「应用」：写回状态 + commit（结构重绘清掉预览块）
    function applyPreview() {
        const p = ed.preview;
        if (!p) return;
        const s = store.get();
        if (p.target === "global") {
            s.global.prompt = p.text;
        } else if (typeof p.target === "string" && p.target.startsWith("shot:")) {
            const sh = s.shots[parseInt(p.target.slice(5), 10)];
            if (sh) sh.prompt = p.text;
        } else if (Number.isInteger(p.target)) {
            const seg = s.segments[p.target];
            if (seg) seg.prompt = p.text;
        }
        ed.preview = null;
        store.commit({ structural: true });
    }

    return { element: root, enhanceTarget, applyPreview, setStatus };
}
