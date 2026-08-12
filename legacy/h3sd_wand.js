// SceneDirector 分段魔法棒：每个提示词输入位挂一个 🪄，LLM 扩写那一段。
//
// 契约（js/AGENTS.md）落点：
//   * 独立增量文件，minimax_*.js 零改动；
//   * 不新建 DOM widget——按钮注入 Director 现有 label/容器；
//   * 数据只调增强器公开 API（getPromptBlock/getPromptTextForBlock/
//     callEnhanceApi/setPromptTextForBlock），应用走 ed.commit；
//   * 结果不直接写：统一走 theme.js 的预览块（_h3sdShowPreview），
//     用户点「应用」才落回对应输入框；
//   * 卡片随 Director 重渲染会重建 DOM，故用幂等扫描补挂（dataset 守卫），
//     定时器在 onRemoved 清理。
import { app } from "../../../scripts/app.js";
import { resolveTaskKey } from "./minimax_gen_timeline.js";
import { stripFl2vPromptBody } from "./minimax_fl2v.js";

const WAND_CLS = "h3sd-wand";

function makeWand(ed, getTarget, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = WAND_CLS;
    b.textContent = "🪄 " + label;
    b.title = "LLM 扩写这段提示词（用增强器里的配置；结果先预览，确认才应用）";
    b.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pe = ed._promptEnhancer;
        if (!pe || b.disabled) return;
        const target = getTarget();

        let block, taskKey, prompt, name;
        if (target === "global") {
            block = ed.timeline?.global || {};
            taskKey = resolveTaskKey(ed.getTaskKey?.() || "t2v");
            prompt = String(block.prompt || ed.globalPromptWidget?.value || "").trim();
            name = "全局提示词";
        } else {
            const idx = Number.isInteger(target) ? target : (ed.selectedIndex ?? 0);
            if (!ed.timeline?.segments?.[idx]) return;
            const info = pe.getPromptBlock(idx);
            block = info.block;
            taskKey = info.taskKey;
            prompt = pe.getPromptTextForBlock(idx);
            name = "片段 " + (idx + 1);
        }
        if (!prompt) { pe.setStatus?.(name + " 还没有提示词", "error"); return; }

        const cfg = pe.getLlmConfig();
        if (!cfg.model) {
            pe.setStatus?.("请先在下方 LLM 增强器里填好端点与模型", "error");
            pe.host?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
            return;
        }

        b.disabled = true;
        b.classList.add("busy");
        pe.setStatus?.("正在扩写: " + name + "…", "loading");
        try {
            const result = await pe.callEnhanceApi(prompt, taskKey, block, cfg);
            if (!result.ok) {
                pe.setStatus?.(result.error || "扩写失败", "error");
                return;
            }
            let text = result.text || "";
            if (taskKey === "fl2v") text = stripFl2vPromptBody(text);
            if (typeof ed._h3sdShowPreview === "function") {
                ed._h3sdShowPreview(text, target === "global"
                    ? "global"
                    : (Number.isInteger(target) ? target : (ed.selectedIndex ?? 0)));
                pe.setStatus?.(name + " 扩写完成，在预览块里确认", "success");
            } else {
                pe.setStatus?.("预览组件未就绪（theme 未挂载）", "error");
            }
        } catch (err) {
            pe.setStatus?.("请求失败: " + (err?.message || err), "error");
        } finally {
            b.disabled = false;
            b.classList.remove("busy");
        }
    });
    return b;
}

// 幂等扫描：给所有还没有魔法棒的提示词位补挂（Director 重渲染后调用）
function sweep(ed) {
    const root = ed.root;
    if (!root) return;

    // 批量卡（t2v/i2v/r2v）：每卡「提示词」label 后
    root.querySelectorAll("textarea[data-batch-prompt-index]").forEach((ta) => {
        const wrap = ta.closest(".bd-batch-prompts");
        if (!wrap || wrap.querySelector("." + WAND_CLS)) return;
        const idx = parseInt(ta.getAttribute("data-batch-prompt-index"), 10);
        if (!Number.isFinite(idx)) return;
        const w = makeWand(ed, () => idx, "扩写本段");
        const lbl = wrap.querySelector(".bd-label");
        if (lbl) lbl.appendChild(w);
        else wrap.insertBefore(w, ta);
    });

    // 全局提示词（底部全局面板）
    const gl = root.querySelector('[data-r="global-prompt-layout"]');
    if (gl && !gl.querySelector("." + WAND_CLS)) {
        const lbl = gl.querySelector(".bd-label");
        if (lbl) lbl.appendChild(makeWand(ed, () => "global", "扩写全局"));
    }

    // fl2v 单镜详情（选中镜）
    const fl = root.querySelector('[data-r="fl2v-prompt"]');
    if (fl) {
        const wrap = fl.closest(".bd-fl2v-detail") || fl.parentElement;
        if (wrap && !wrap.querySelector("." + WAND_CLS)) {
            const w = makeWand(ed, () => ed.selectedIndex ?? 0, "扩写本镜");
            const lbl = wrap.querySelector(".bd-label");
            if (lbl) lbl.appendChild(w);
            else wrap.insertBefore(w, fl);
        }
    }

    // v2v/rv2v 片段提示词（选中段；全局编辑模式下这个框就是全局提示词）
    const seg = root.querySelector(".bd-v2v-layout .bd-prompt, .bd-rv2v-layout .bd-prompt");
    if (seg) {
        const col = seg.closest(".bd-prompt-col");
        if (col && !col.querySelector("." + WAND_CLS)) {
            const w = makeWand(ed,
                () => (ed.isGlobalMode?.() ? "global" : (ed.selectedIndex ?? 0)), "扩写本段");
            const lbl = col.querySelector(".bd-label");
            if (lbl) lbl.appendChild(w);
            else col.insertBefore(w, seg);
        }
    }
}

function mount(node) {
    // 编辑器异步装配 + theme 的预览块在 900ms 挂载，我们排它后面
    setTimeout(() => {
        try {
            const ed = node._minimaxEditor;
            if (!ed || node._h3sdWand) return;
            node._h3sdWand = true;
            sweep(ed);
            const timer = setInterval(() => sweep(ed), 1600);
            const origRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(timer);
                node._h3sdWand = false;
                return origRemoved?.apply(this, arguments);
            };
        } catch (e) {
            console.warn("[SceneDirector] 魔法棒挂载失败（忽略）", e);
        }
    }, 1100);
}

app.registerExtension({
    name: "h3.scenedirector.wand",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "H3SceneDirectorList") return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            mount(this);
            return r;
        };
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "H3SceneDirectorList") mount(node);
    },
});
