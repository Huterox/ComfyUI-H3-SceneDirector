// config.js —— v3 服务配置弹窗：LLM（双格式 + 上下文窗口）+ 生图服务
// （Seedream / nanobanana / 不启用）。配置存服务端 user/SceneDirector/
// config.json（key 不进工作流、不进项目文件）；「测试连接」支持拿未保存
// 的草稿直接测。保存后刷新全局设置区的服务状态摘要。
import { el } from "./util.js";

export function createConfig(ed, { api }) {
    let overlay = null;
    let draft = null;

    function field(labelText, input, hint) {
        const r = el("div", "sd2-cfg-row");
        r.appendChild(el("span", "lbl", labelText));
        r.appendChild(input);
        if (hint) r.appendChild(el("span", "meta", hint));
        return r;
    }

    function text(value, placeholder, type) {
        const i = el("input", "sd2-inp");
        i.type = type || "text";
        i.value = value ?? "";
        i.placeholder = placeholder || "";
        return i;
    }

    function select(opts, value) {
        const s = el("select", "sd2-inp");
        for (const [label, v] of opts) s.appendChild(new Option(label, v));
        s.value = value;
        return s;
    }

    function build() {
        overlay = el("div", "sd2-cfg-overlay hidden");
        const dlg = el("div", "sd2-cfg");
        dlg.addEventListener("pointerdown", (e) => e.stopPropagation());
        overlay.addEventListener("pointerdown", () => close());

        const head = el("div", "sd2-cfg-head");
        head.appendChild(el("b", "", "服务配置"));
        head.appendChild(el("span", "meta",
            "存服务端 config.json · 全项目共享 · 不随工作流外泄"));
        head.appendChild(el("span", "sp"));
        const x = el("button", "sd2-btn sm", "×");
        x.addEventListener("click", () => close());
        head.appendChild(x);
        dlg.appendChild(head);

        const body = el("div", "sd2-cfg-body");
        dlg.appendChild(body);
        overlay.appendChild(dlg);
        document.body.appendChild(overlay);
        return { dlg, body };
    }

    async function open() {
        let cfg;
        try {
            const r = await api.fetchApi("/h3_scenedirector/config");
            cfg = await r.json();
        } catch (e) {
            cfg = { llm: {}, image: {} };
        }
        draft = cfg;
        if (!overlay) build();
        renderBody();
        overlay.classList.remove("hidden");
    }

    function close() {
        overlay?.classList.add("hidden");
    }

    function renderBody() {
        const body = overlay.querySelector(".sd2-cfg-body");
        body.innerHTML = "";
        const llm = draft.llm || {};
        const img = draft.image || {};

        // --- LLM 区 -------------------------------------------------------------
        const s1 = el("div", "sd2-cfg-sec");
        s1.appendChild(el("div", "ttl", "LLM（故事 / 提示词写作模型）"));
        const fmt = select([["OpenAI 兼容", "openai"], ["Anthropic", "anthropic"]],
            llm.api_format || "openai");
        const base = text(llm.base_url, "https://api.anthropic.com / http://127.0.0.1:11434/v1");
        const key = text(llm.api_key, "sk-...", "password");
        const model = text(llm.model, "claude-sonnet-4-5 / qwen3 等");
        const ctx = text(llm.context_window ?? 200000, "200000", "number");
        ctx.title = "会话接近上下文窗口时，由 pi-agent-core compaction 自动摘要压缩";
        s1.appendChild(field("API 格式", fmt));
        s1.appendChild(field("Base URL", base));
        s1.appendChild(field("API Key", key));
        s1.appendChild(field("模型", model));
        s1.appendChild(field("上下文窗口", ctx, "tokens · 超窗由 agent 自动压缩"));
        s1.appendChild(el("div", "note",
            "pi-ai 统一调用（OpenAI 兼容 / Anthropic 双格式，自带重试与流式）；"
            + "会话接近上下文窗口时 pi-agent-core compaction 自动摘要压缩，长项目不断片。"));
        body.appendChild(s1);

        // --- 生图区 -------------------------------------------------------------
        const s2 = el("div", "sd2-cfg-sec");
        s2.appendChild(el("div", "ttl", "生图服务（角色 / 场景定妆图）"));
        const prov = select([
            ["不启用", "disabled"],
            ["Doubao Seedream（火山方舟 · 国内直连）", "seedream"],
            ["nanobanana（Gemini 中转）", "nanobanana"],
        ], img.provider || "disabled");
        const ibase = text(img.base_url, "https://ark.cn-beijing.volces.com/api/v3");
        const ikey = text(img.api_key, "", "password");
        const isize = select([
            ["2048×2048", "2048x2048"], ["2304×1728（横）", "2304x1728"],
            ["1728×2304（竖）", "1728x2304"], ["1024×1024", "1024x1024"],
        ], img.size || "2048x2048");
        s2.appendChild(field("厂商", prov));
        s2.appendChild(field("Base URL", ibase));
        s2.appendChild(field("API Key", ikey));
        const sizeRow = field("默认尺寸", isize);
        const testImg = el("button", "sd2-btn sm", "测试连接");
        sizeRow.appendChild(testImg);
        s2.appendChild(sizeRow);
        s2.appendChild(el("div", "note",
            "Seedream：OpenAI 兼容 images 接口，多图参考 + 图像编辑，便宜直连（主力）；"
            + "nanobanana：角色一致性/改角度最强（正/侧/背三视图），走中转（精修）。"));
        body.appendChild(s2);

        // --- 底栏 ---------------------------------------------------------------
        const status = el("span", "meta st", "");
        const foot = el("div", "sd2-cfg-foot");
        foot.appendChild(el("span", "meta", "改动即存即生效，无需重启"));
        const testLlm = el("button", "sd2-btn", "测试 LLM");
        foot.appendChild(testLlm);
        foot.appendChild(status);
        foot.appendChild(el("span", "sp"));
        const cancel = el("button", "sd2-btn", "取消");
        cancel.addEventListener("click", () => close());
        const save = el("button", "sd2-btn primary", "保存");
        foot.appendChild(cancel);
        foot.appendChild(save);
        body.appendChild(foot);

        const collect = () => ({
            llm: { api_format: fmt.value, base_url: base.value.trim(),
                   api_key: key.value.trim(), model: model.value.trim(),
                   context_window: parseInt(ctx.value, 10) || 200000 },
            image: { provider: prov.value, base_url: ibase.value.trim(),
                     api_key: ikey.value.trim(), size: isize.value },
        });

        const test = async (kind, btn) => {
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = "测试中…";
            status.textContent = "";
            try {
                const r = await api.fetchApi("/h3_scenedirector/config/test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ kind, config: collect() }),
                });
                const d = await r.json();
                status.textContent = (d.ok ? "✓ " : "✗ ") + (d.detail || "");
                status.className = "meta st " + (d.ok ? "ok" : "bad");
            } catch (e) {
                status.textContent = "✗ 请求失败：" + (e?.message || e);
                status.className = "meta st bad";
            } finally {
                btn.disabled = false;
                btn.textContent = old;
            }
        };
        testLlm.addEventListener("click", () => test("llm", testLlm));
        testImg.addEventListener("click", () => test("image", testImg));

        save.addEventListener("click", async () => {
            save.disabled = true;
            try {
                const r = await api.fetchApi("/h3_scenedirector/config", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(collect()),
                });
                if (!r.ok) throw new Error("HTTP " + r.status);
                close();
                ed.library?.refreshConfig?.();
                ed.enhancer?.reloadConfig?.();
            } catch (e) {
                status.textContent = "✗ 保存失败：" + (e?.message || e);
                status.className = "meta st bad";
            } finally {
                save.disabled = false;
            }
        });
    }

    function dispose() {
        overlay?.remove();
        overlay = null;
    }

    return { open, dispose };
}
