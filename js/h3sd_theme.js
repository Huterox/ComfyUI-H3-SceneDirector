// SceneDirector 主题装载：注入我们的样式 + 微调展示层结构（不动交互）。
// 视觉对齐我们先前的工作台：实时预览大屏置顶、舞台区紧随工具条。
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
        // 增强结果应用修复：先把文本写进批量卡的 DOM 文本框，
        // 再走原 apply——否则 commit 的 flushBatchPromptInputs 会
        // 用卡里的旧草稿把刚应用的增强结果覆盖回去
        const pe = ed._promptEnhancer;
        if (pe && !pe._h3sdApplyFixed) {
            pe._h3sdApplyFixed = true;
            const origApply = pe.setActivePromptText?.bind(pe);
            if (origApply) {
                pe.setActivePromptText = (text) => {
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
            }
        }
        // 实时预览大屏提到主区最上方（我们旧工作台的位置）
        const live = ed.liveSampleEl;
        if (live && ed.mainBody && live.parentElement === ed.mainBody) {
            ed.mainBody.insertBefore(live, ed.mainBody.firstChild);
            live.classList.remove("hidden");
        }
        // 舞台区提到时间轴画布之前
        const stage = ed.root?.querySelector('.bd-stage');
        const viewport = ed.viewport;
        if (stage && viewport && stage.parentElement === viewport.parentElement) {
            viewport.parentElement.insertBefore(stage, viewport);
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
