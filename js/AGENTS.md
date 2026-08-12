# 前端嵌入契约（js/ 下所有 UI 代码必须遵守）

> 来源：逐条核实自正在运行的代码（minimax_timeline.js / 旧工作台血泪教训）。
> 任何新 UI 只能在此契约内做增量；违反任意一条的代码不许合入。

## 一、挂载（节点嵌入）

1. **入口**：`app.registerExtension` + `beforeRegisterNodeDef` 包 `onNodeCreated`
   （先调 orig 再干我们的），`loadedGraphNode` 兜底；节点识别用
   `nodeData.name === "H3SceneDirectorList"`。挂载必须幂等（`node._xxx` 守卫）。
   （minimax_timeline.js:9577, 9688–9733）
2. **DOM 容器唯一**：全节点只有一个 DOM widget——Director 的
   `addDOMWidget("minimax_director_ui", "director", container.mmx-host, …)`
   （minimax_timeline.js:9742–9765）。我们的 UI 一律挂进 `node._minimaxEditor`
   的 DOM 树（`ed.mainBody` / `ed.root` 内的已有元素）。
   **绝不新建 DOM widget，绝不改 addDOMWidget 的参数。**
3. **编辑器实例**：`node._minimaxEditor` 在 `setTimeout(0)` 之后才建好
   （initDirectorEditor，minimax_timeline.js:1014–1039）。我们的挂载点延迟
   ≥900ms 再读它，读不到就放弃挂载（不可 crash 节点创建流程）。

## 二、尺寸契约（先前所有"UI 甩出节点/塌缩" bug 的根）

4. **高度**：由 Director 的 `computeSize` / `computeLayoutSize` /
   `options.getMinHeight` 驱动（bindDirectorDomWidgetSizing，
   minimax_timeline.js:1000–1012）。我们不覆写 computeSize、不调 setSize 改高。
5. **宽度**：前端会把元素宽钉成内联像素值，Director 用
   `ensureDirectorDomWidgetWidth` 在 onDraw/afterResize/onResize/onSelected
   里跟随（minimax_timeline.js:9747–9794）。我们的内容只用流体布局
   （百分比/flex/minmax）跟宽，**不测量、不钉宽、不用 ResizeObserver**。
6. **容器最低高**：`.mmx-host` 上有 `--comfy-widget-min-height` 变量和内联
   minHeight；我们的内容高度超出时自己滚（overflow:auto），不撑破。

## 三、数据与序列化

7. **序列化载体是隐藏 widget**（timeline_data 等）。写值只准普通赋值
   `widget.value = x`（可加 callback 包装同步）。
   **绝不对 widget.value 用 Object.defineProperty**——前端把它定义成不可配置
   属性，重定义抛 `Cannot redefine property: value`，直接搞崩工作流加载。
8. **一切数据修改走 `ed.commit(false, { syncTimeline: true })`**，让 Director
   自己序列化。注意 commit 链上的 `flushBatchPromptInputs` 会用批量卡 textarea
   的 DOM 值覆盖段数据——**改段提示词必须同步对应 textarea 的 value 并派发
   input 事件**，否则序列化时被旧草稿覆盖回去。
9. **包装方法要链式**：保存 orig、我们的包装里先/后调 orig、onRemoved 里还原；
   WS 监听与定时器必须在 onRemoved 退订/清理。

## 四、皮肤与增量层

10. **皮肤只走 h3sd_theme.css**，所有覆盖选择器加 `.mmx-host` 前缀抬优先级
    （Director 把 `<style>` 注入节点根、创建时才插入，同优先级后插入者胜）。
11. 新 UI 组件只准放在独立文件（`h3sd_*.js`），挂载点用 Director 现有 DOM；
    对 Director 的元素**只隐藏（classList toggle）不删除**，模式切走时要能还原。
12. **`minimax_*.js` 主文件不许改**（fork 自 Director，保持可比对/可升级）。
    例外修补必须单独注明原因并记录在本文件下方"已破例清单"。

## 已破例清单

- minimax_timeline.js:1023–1030：增强面板挂载（上游此版本为死导出，不接不显示）。
- minimax_timeline.js 的 i18n 中文化与 H3SceneDirectorList 节点名认领。
