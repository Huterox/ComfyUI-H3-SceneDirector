// enhance.js —— v3 提示词增强：每段魔法棒（enhanceTarget）+ 内联预览-确认-应用。
//
// v3 起 LLM 配置统一走服务端「服务配置」（user/SceneDirector/config.json），
// 不再读节点上的 llm_* widget（那些 widget 仅为存档兼容保留在 INPUT_TYPES）。
// 调用链：🪄 -> GET /h3_scenedirector/config -> POST /minimax/director/enhance
// -> ed.preview -> promptbox.previewBlock 渲染内联预览 -> 「应用」写回状态。
// 视觉参考（参考图/首帧）经 /minimax/director/image_b64 取 base64 随请求发给 LLM。
import { el, splitRel, taskKeyFromLabel, assetKey, cardFile } from "./util.js";

export function createEnhancer(ed, { api }) {
    const { store } = ed;

    // 服务端配置缓存（config.js 保存后调 reloadConfig 作废）
    let cfgPromise = null;
    function loadConfig() {
        if (!cfgPromise) {
            cfgPromise = api.fetchApi("/h3_scenedirector/config")
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null);
        }
        return cfgPromise;
    }

    function setError(text, target, name) {
        ed.preview = { text: String(text), target, name: name || "扩写", error: true };
        ed.render();
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

    // 段的视觉参考：首帧 + libRefs 解析到的图片卡（常驻图卡也在内——它就在段里）
    function segImageFiles(seg) {
        const s = store.get();
        const lib = s.library || [];
        const files = [];
        const push = (f) => { if (f && !files.includes(f)) files.push(f); };
        if (seg?.genImage?.imageFile) push(seg.genImage.imageFile);
        for (const key of seg?.libRefs || []) {
            const c = lib.find((x) => assetKey(x) === key);
            if (c && (c.kind || "image") === "image") push(cardFile(c));
        }
        return files.filter(Boolean);
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
                imageFiles: (s.library || [])
                    .filter((c) => c.pinned !== false && (c.kind || "image") === "image")
                    .map((c) => cardFile(c)).filter(Boolean),
                duration: Number(d0) || 5.0,
            };
        }
        if (typeof target === "string" && target.startsWith("shot:")) {
            const i = parseInt(target.slice(5), 10);
            const sh = s.shots[i];
            if (!sh) return null;
            const files = [sh.startImage?.imageFile, sh.endImage?.imageFile].filter(Boolean);
            for (const key of sh.libRefs || []) {
                const c = (s.library || []).find((x) => assetKey(x) === key);
                if (c && (c.kind || "image") === "image" && cardFile(c)) files.push(cardFile(c));
            }
            return {
                name: "镜 " + (i + 1),
                taskKey: "fl2v",
                prompt: String(sh.prompt || "").trim(),
                imageFiles: files,
                duration: Number(sh.durationSec) || 5.0,
            };
        }
        const i = Number.isInteger(target) ? target : ed.selectedIndex;
        const seg = s.segments[i];
        if (!seg) return null;
        return {
            name: "片段 " + (i + 1),
            taskKey: taskKeyFromLabel(seg.taskType || mode),
            prompt: String(seg.prompt || "").trim(),
            imageFiles: segImageFiles(seg),
            duration: Number(seg.durationSec) || 5.0,
        };
    }

    async function enhanceTarget(target) {
        const info = targetInfo(target);
        if (!info) return;
        if (!info.prompt) { setError(info.name + " 还没有提示词", target, info.name); return; }
        const cfg = await loadConfig();
        const llm = cfg?.llm || {};
        if (!llm.model || !llm.base_url) {
            setError("LLM 还没配置：点全局设置区右上角的「服务配置」填 Base URL / 模型",
                     target, info.name);
            return;
        }
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
                    llm_url: llm.base_url,
                    model: llm.model,
                    prompt: info.prompt,
                    task_type: info.taskKey,
                    duration: info.duration || 5.0,
                    image_num: Math.max(1, images.length),
                    images,
                    api_format: llm.api_format === "anthropic"
                        ? "Anthropic" : "OpenAI Compatible",
                    api_key: llm.api_key || "",
                    output_language: "中文",
                    character_feature_enhance: false,
                    custom_template: "",
                }),
            });
            const data = await resp.json();
            if (!resp.ok || data.error) {
                setError("扩写失败: " + (data.error || "HTTP " + resp.status), target, info.name);
                return;
            }
            const text = String(data.response || "").trim();
            if (!text) { setError("扩写返回为空", target, info.name); return; }
            ed.preview = { text, target, name: info.name };
            ed.render();
        } catch (e) {
            setError("请求失败: " + (e?.message || e), target, info.name);
        }
    }

    // 「应用」：写回状态 + commit（结构重绘清掉预览块）
    function applyPreview() {
        const p = ed.preview;
        if (!p || p.error) return;
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

    return { element: el("div", "hidden"), enhanceTarget, applyPreview,
             reloadConfig() { cfgPromise = null; } };
}
