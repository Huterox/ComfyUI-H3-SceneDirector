// SceneDirector 工作台入口：旧工作台组件整体移植（组件替换），
// 挂到 Director 编辑器实例（node._minimaxEditor）上。
// 模式分工见 wb/main.js 头注释；被替换的 Director 表面只隐藏、不删改。
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { attachWorkbench } from "./wb/main.js";

function mount(node) {
    // Director 编辑器在 onNodeCreated 里异步装配，等它落定再挂
    setTimeout(() => {
        try {
            if (!node._minimaxEditor) return;
            attachWorkbench(node, { app, api });
        } catch (e) {
            console.warn("[SceneDirector] 工作台挂载失败（忽略）", e);
        }
    }, 1000);
}

app.registerExtension({
    name: "h3.scenedirector.workbench",
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
