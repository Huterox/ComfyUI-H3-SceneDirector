// storydirector.js —— 前端扩展入口（薄）。
//
// ComfyUI 把 js/ 根目录的 .js 当扩展自动加载（WEB_DIRECTORY="./js"），
// 本文件被服务在 /extensions/<包名>/storydirector.js，所以到 scripts/
// 的相对路径是 ../../../。js/workbench/ 下的模块一律不 import app/api，
// 由这里注入。

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { attachWorkbench } from "./workbench/main.js";

const NODE_TYPE = "H3StoryDirectorList";

app.registerExtension({
    name: "H3.StoryDirector.Workbench",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // 节点创建（新建/加载/粘贴都会走这里）后挂载工作台
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            try {
                attachWorkbench(this, { app, api });
            } catch (e) {
                // 工作台挂载失败绝不能拖垮节点本身
                console.error("[h3-workbench] 挂载失败", e);
            }
            return result;
        };

        // configure() 恢复 widget 值（工作流加载/撤销/粘贴）；结束后
        // 从 segments widget 重新恢复工作台状态
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = onConfigure?.apply(this, arguments);
            const w = this.widgets?.find((x) => x.name === "segments");
            if (this._h3wb && w) this._h3wb.loadFromValue(w.value);
            return result;
        };

        // 保存工作流前把防抖中的编辑立即写回 widget，避免丢最后几百毫秒
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function () {
            this._h3wb?.flush();
            return onSerialize?.apply(this, arguments);
        };

        // 节点移除时清理：退订 WS 事件、关闭弹层、恢复 widget callback
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._h3wb?.dispose();
            return onRemoved?.apply(this, arguments);
        };
    },
});
