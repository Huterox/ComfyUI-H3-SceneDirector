// SceneDirector 工作台：LLM 提示词增强面板（预览-确认-应用）
import { backend } from "./api.js";

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function buildEnhancer(ctx) {
    const box = el("div", "h3sd-enhancer");
    const head = el("div", "h3sd-collapse-head", "✨ LLM 提示词增强（预览后确认才应用）");
    const body = el("div", "h3sd-enhancer-body hidden");
    head.addEventListener("click", () => body.classList.toggle("hidden"));
    box.appendChild(head);

    // 配置行
    const cfgRow = el("div", "h3sd-enh-cfg");
    const fmtSel = el("select", "h3sd-enh-fmt");
    [["OpenAI Compatible", "OpenAI 兼容 (/v1/chat/completions)"],
     ["Anthropic", "Anthropic (/v1/messages)"]].forEach(([v, label]) => {
        const o = el("option", "", label);
        o.value = v;
        fmtSel.appendChild(o);
    });
    const urlIn = el("input", "h3sd-enh-url");
    urlIn.placeholder = "http://127.0.0.1:11434/v1";
    const keyIn = el("input", "h3sd-enh-key");
    keyIn.type = "password";
    keyIn.placeholder = "API Key（本地可空）";
    const modelIn = el("input", "h3sd-enh-model");
    modelIn.placeholder = "qwen3";
    cfgRow.appendChild(fmtSel);
    cfgRow.appendChild(urlIn);
    cfgRow.appendChild(modelIn);
    cfgRow.appendChild(keyIn);
    body.appendChild(cfgRow);

    fmtSel.addEventListener("change", () => {
        if (fmtSel.value === "Anthropic") {
            urlIn.value = "https://api.anthropic.com";
            modelIn.value = "claude-sonnet-4-5";
            keyIn.placeholder = "Anthropic API Key（必填）";
        } else {
            urlIn.value = "http://127.0.0.1:11434/v1";
            modelIn.value = "qwen3";
            keyIn.placeholder = "OpenAI 兼容 API Key（本地可空）";
        }
        saveCfg();
    });

    // 从节点 widget 恢复配置
    const w = (n) => ctx.getWidgetValue("llm_" + n);
    fmtSel.value = w("api_format") || "OpenAI Compatible";
    urlIn.value = w("url") || "http://127.0.0.1:11434/v1";
    modelIn.value = w("model") || "qwen3";
    keyIn.value = w("api_key") || "";

    function saveCfg() {
        ctx.setWidgetValue("llm_api_format", fmtSel.value);
        ctx.setWidgetValue("llm_url", urlIn.value);
        ctx.setWidgetValue("llm_model", modelIn.value);
        ctx.setWidgetValue("llm_api_key", keyIn.value);
    }
    [urlIn, keyIn, modelIn].forEach((i) => i.addEventListener("change", saveCfg));

    // 操作行
    const opRow = el("div", "h3sd-enh-ops");
    const goBtn = el("button", "h3sd-btn primary", "扩写当前段");
    const status = el("span", "h3sd-enh-status", "");
    opRow.appendChild(goBtn);
    opRow.appendChild(status);
    body.appendChild(opRow);

    // 预览块
    const preview = el("div", "h3sd-pe-preview hidden");
    const pHead = el("div", "h3sd-pe-preview-head", "结果预览 · 确认后应用");
    const pre = el("pre");
    const pBtns = el("div", "h3sd-pe-preview-btns");
    const applyBtn = el("button", "h3sd-btn-primary", "应用");
    const copyBtn = el("button", "h3sd-btn", "复制");
    const dropBtn = el("button", "h3sd-btn danger", "丢弃");
    pBtns.appendChild(applyBtn);
    pBtns.appendChild(copyBtn);
    pBtns.appendChild(dropBtn);
    preview.appendChild(pHead);
    preview.appendChild(pre);
    preview.appendChild(pBtns);
    body.appendChild(preview);
    box.appendChild(body);

    let pending = null;
    applyBtn.addEventListener("click", () => {
        if (pending != null) ctx.applyEnhancedText(pending);
        pending = null;
        preview.classList.add("hidden");
    });
    copyBtn.addEventListener("click", () => {
        if (pending != null) navigator.clipboard?.writeText(pending);
    });
    dropBtn.addEventListener("click", () => {
        pending = null;
        preview.classList.add("hidden");
    });

    goBtn.addEventListener("click", async () => {
        const seg = ctx.selectedSegment();
        const prompt = (seg?.prompt || ctx.payload.global_prompt || "").trim();
        if (!prompt) {
            status.textContent = "请先输入提示词";
            return;
        }
        goBtn.disabled = true;
        status.textContent = "扩写中…";
        try {
            const r = await backend.enhance(prompt, ctx.payload.task || "t2v", {
                llm_url: urlIn.value, model: modelIn.value || "qwen3",
                api_key: keyIn.value, api_format: fmtSel.value,
                duration: seg?.duration || 5,
            });
            pending = r.response || "";
            pre.textContent = pending;
            preview.classList.remove("hidden");
            status.textContent = "扩写成功，" + (r.han_count != null ? r.han_count + " 汉字" : pending.length + " 字符");
        } catch (e) {
            status.textContent = "失败: " + e.message;
        } finally {
            goBtn.disabled = false;
        }
    });

    return { root: box };
}
