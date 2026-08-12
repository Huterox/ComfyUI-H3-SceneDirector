// SceneDirector 主题装载：注入我们的样式 + 两个确认过的行为补丁。
// 布局 100% Director 原生（不挪任何 DOM）；这里只做：
//   1. 全局提示词可见性修复（批量/fl2v 模式强制放出底部全局面板）
//   2. 增强结果预览 -> 确认才应用（用户点单的行为）
//   3. 增强器大渐变按钮打类名，颜色交给 css（!important 压内联）
import { app } from "../../../scripts/app.js";

const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("./h3sd_theme.css", import.meta.url).href;
document.head.appendChild(css);

function polish(node) {
    const ed = node._minimaxEditor;
    if (!ed || node._h3sdThemed) return;
    node._h3sdThemed = true;
    try {
        // 全局提示词可见性修复：Director 在批量/fl2v 模式把底部全局面板
        // （全局提示词 + 全局参考）整个 hidden 掉，用户看不到全局提示词。
        // 包一层 applyTaskLayout：布局算完再强制放出全局面板。
        if (!ed._h3sdGpFixed) {
            ed._h3sdGpFixed = true;
            const origLayout = ed.applyTaskLayout?.bind(ed);
            if (origLayout) {
                ed.applyTaskLayout = (...args) => {
                    const out = origLayout(...args);
                    try {
                        const split = ed.root?.querySelector(".bd-split");
                        split?.classList.remove("hidden");
                        const gp = ed.root?.querySelector('[data-r="global-panel"]');
                        if (gp) gp.style.display = "";
                    } catch (e) { /* 忽略 */ }
                    return out;
                };
                ed.applyTaskLayout(ed._directorMode);
            }
        }
        // 增强结果：预览 -> 确认才应用（扩写当前）。
        // apply 前先把文本写进批量卡 DOM——否则 commit 的
        // flushBatchPromptInputs 会用卡里的旧草稿把结果覆盖回去
        const pe = ed._promptEnhancer;
        if (pe && !pe._h3sdApplyFixed) {
            pe._h3sdApplyFixed = true;
            const origApply = pe.setActivePromptText?.bind(pe);
            const applyText = (text) => {
                try {
                    const idx = ed.selectedIndex ?? 0;
                    const ta = ed.batchList?.querySelector(
                        `textarea[data-batch-prompt-index="${idx}"]`);
                    if (ta) {
                        ta.value = text;
                        ta.dispatchEvent(new Event("input"));
                    }
                } catch (e) { /* 忽略，走原路径 */ }
                return origApply(text);
            };
            // 预览块（增强面板顶部）
            const box = document.createElement("div");
            box.className = "h3sd-pe-preview hidden";
            const pre = document.createElement("pre");
            const head = document.createElement("div");
            head.className = "h3sd-pe-preview-head";
            head.textContent = "结果预览 · 确认后应用";
            const btns = document.createElement("div");
            btns.className = "h3sd-pe-preview-btns";
            box.appendChild(head);
            box.appendChild(pre);
            box.appendChild(btns);
            let pending = null;
            const hide = () => { box.classList.add("hidden"); pending = null; };
            const mk = (label, cls, fn) => {
                const b = document.createElement("button");
                b.className = cls;
                b.textContent = label;
                b.addEventListener("click", fn);
                btns.appendChild(b);
                return b;
            };
            mk("应用", "h3sd-btn-primary", () => {
                if (pending != null) applyText(pending);
                hide();
            });
            mk("复制", "h3sd-btn", () => {
                if (pending != null) navigator.clipboard?.writeText(pending);
            });
            mk("丢弃", "h3sd-btn danger", hide);
            pe.body?.insertBefore(box, pe.body.firstChild);
            // 两根全宽渐变按钮（内联 #3b82f6/#6366f1）打类名交给主题
            pe.enhanceCurrentBtn?.classList.add("h3sd-pe-btn", "cur");
            pe.enhanceAllBtn?.classList.add("h3sd-pe-btn", "all");
            if (origApply) {
                pe.setActivePromptText = (text) => {
                    if (pe._h3sdPreviewNext) {
                        pe._h3sdPreviewNext = false;
                        pending = text;
                        pre.textContent = text;
                        box.classList.remove("hidden");
                        return;
                    }
                    return applyText(text);
                };
                // 「扩写当前」走预览；「扩写全部」逐段直接应用
                const cur = pe.enhanceCurrentBtn;
                if (cur) {
                    cur.addEventListener("click", () => { pe._h3sdPreviewNext = true; }, true);
                }
            }
        }
    } catch (e) {
        console.warn("[SceneDirector] 主题微调失败（忽略）", e);
    }
}

app.registerExtension({
    name: "h3.scenedirector.theme",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "H3SceneDirectorList") return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            setTimeout(() => polish(this), 900);
            return r;
        };
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "H3SceneDirectorList") setTimeout(() => polish(node), 900);
    },
});
