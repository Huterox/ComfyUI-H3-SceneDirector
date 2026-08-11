// SceneDirector：任务模式 -> UNET 模型 自动联动
// 规则：t2v/i2v/fl2v -> fl2va；r2v/v2v/rv2v -> ref2va（官方双权重）。
// 切换时同时把 Chain 的 cache_tag 改成模型键（模型无法被缓存指纹化，
// 不换标签会误发旧模型渲的段）。
import { app } from "../../../scripts/app.js";

const MODEL_BY_GROUP = {
    gen: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    ref: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
};
const REF_TASKS = new Set(["r2v", "v2v", "rv2v"]);

function taskKey(value) {
    const v = String(value || "").split(" — ")[0].trim();
    return v || "t2v";
}
function groupOf(value) {
    return REF_TASKS.has(taskKey(value)) ? "ref" : "gen";
}

// 找给 Chain 供模型的 UNETLoader（中间可能隔 Spectrum 等补丁节点）；
// 找不到退回图里第一个 UNETLoader。
function findUnetLoader() {
    const g = app.graph;
    const nodes = g?._nodes || [];
    const byId = (id) => nodes.find((n) => String(n.id) === String(id));
    const chain = nodes.find((n) => n.comfyClass === "H3SceneDirectorChain");
    if (chain?.inputs?.[0]?.link != null) {
        const link = g.links[chain.inputs[0].link];
        let src = byId(link?.origin_id);
        let hops = 0;
        while (src && src.type !== "UNETLoader" && hops < 4) {
            const inp = src.inputs?.find((i) => i.link != null && /MODEL/i.test(i.type || ""));
            if (!inp) break;
            const l = g.links[inp.link];
            src = byId(l?.origin_id);
            hops += 1;
        }
        if (src && src.type === "UNETLoader") return src;
    }
    return nodes.find((n) => n.type === "UNETLoader") || null;
}

function findChain() {
    return (app.graph?._nodes || []).find((n) => n.comfyClass === "H3SceneDirectorChain") || null;
}

function applyModelLink(taskTypeValue, silent) {
    const want = MODEL_BY_GROUP[groupOf(taskTypeValue)];
    const loader = findUnetLoader();
    if (!loader) return;
    const w = loader.widgets?.find((x) => x.name === "unet_name");
    if (!w) return;
    const options = w.options?.values || w.values || [];
    if (options.length && !options.includes(want)) {
        console.warn("[SceneDirector] 联动模型不存在于 UNETLoader 选项：", want);
        return;
    }
    if (w.value !== want) {
        w.value = want;
        loader.setDirtyCanvas?.(true, true);
        // 同步缓存标签：换模型 = 全链作废
        const chain = findChain();
        const tag = chain?.widgets?.find((x) => x.name === "cache_tag");
        const key = groupOf(taskTypeValue);
        if (tag && tag.value !== key) tag.value = key;
        if (!silent) {
            console.info("[SceneDirector] 模型联动：", taskKey(taskTypeValue), "->", want,
                "，cache_tag ->", key);
        }
    }
}

app.registerExtension({
    name: "h3.scenedirector.model_link",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "H3SceneDirectorList") return;
        const orig = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = orig ? orig.apply(this, arguments) : undefined;
            // 等 Director 编辑器挂载后再包它的任务切换回调
            setTimeout(() => {
                const ed = this._minimaxEditor;
                if (!ed || this._h3sdModelLinked) return;
                this._h3sdModelLinked = true;
                const origChanged = ed.onTaskTypeChanged?.bind(ed);
                ed.onTaskTypeChanged = (value) => {
                    const out = origChanged ? origChanged(value) : undefined;
                    applyModelLink(value, false);
                    return out;
                };
                // 载入已存工作流时按当前任务模式对齐一次（静默）
                const tw = this.widgets?.find((w) => w.name === "task_type");
                if (tw) applyModelLink(tw.value, true);
            }, 800);
            return r;
        };
    },
});
