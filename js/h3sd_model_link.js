// SceneDirector：任务模式 -> UNET 模型 自动联动
// 规则：t2v/i2v/fl2v -> fl2va；r2v/v2v/rv2v -> ref2va（官方双权重）。
// 切换时同步 Chain 的 cache_tag（换模型 = 全链缓存作废）。
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

export function applyModelLink(taskTypeValue, silent) {
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
            // 直接挂 task_type widget 的回调（自研工作台时代）
            const tw = this.widgets?.find((w) => w.name === "task_type");
            if (tw && !tw._h3sdLinked) {
                tw._h3sdLinked = true;
                const origCb = tw.callback;
                tw.callback = function (...args) {
                    const out = origCb?.apply(this, args);
                    applyModelLink(tw.value, false);
                    return out;
                };
                // 也通过工作台的 payload.task 轮询兜底（UI 改 task 不走 widget 回调）
                if (!this._h3sdLinkTimer) {
                    this._h3sdLinkTimer = setInterval(() => {
                        try {
                            const tl = this.widgets.find((w) => w.name === "timeline_data")?.value || "";
                            const task = JSON.parse(tl || "{}").task;
                            if (task && task !== this._h3sdLastTask) {
                                this._h3sdLastTask = task;
                                applyModelLink(task, true);
                            }
                        } catch (e) { /* 载荷未就绪 */ }
                    }, 1500);
                }
                applyModelLink(tw.value, true);
            }
            return r;
        };
    },
});
