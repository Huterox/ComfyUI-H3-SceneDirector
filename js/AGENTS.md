# 前端契约（js/v2/ 所有代码必须遵守）

> v2 为自研前端（唯一前端，旧 Director fork 已删）。本契约的每条都来自
> 真实事故/实测，违反的代码不许合入。

## 一、挂载（节点嵌入）

1. **入口**：`app.registerExtension` + `beforeRegisterNodeDef` 包 `onNodeCreated`
   （先调 orig），`loadedGraphNode` 兜底恢复；识别
   `nodeData.name === "H3SceneDirectorList"`；`node._h3sdEditor` 幂等守卫。
   （js/v2/main.js）
2. **DOM 容器唯一**：一个 `div.mmx-host` + `addDOMWidget("h3sd_ui", "div", …)`。
   一切 UI 挂进这个容器，绝不新建第二个 DOM widget。
3. **编辑器实例**：widget 建完后 `setTimeout(0)` 再建（等 widget 就位），
   存 `node._h3sdEditor`；读不到容器就放弃挂载，不可 crash 节点创建。

## 二、尺寸契约（血泪区）

4. **高度**：只给 `getMinHeight` 保底（静态 BASE_H=700）。
   **绝不覆写 computeSize/computeLayoutSize**——这版前端会把高度钉死在
   内容高，节点拉高不跟随（实测 630 钉死 vs 删除后跟随 1236）。
   内容跟高靠 `height:100%` + 主区 `flex:1` 自滚。
   **也不能用 scrollHeight 动态算保底高**——分配高度回流进测量值，
   形成只涨不缩的反馈环（实测 1227 钉死）。
5. **宽度**：`ensureWidth(node)`（容器宽 = 节点宽 - 20）在 onDraw /
   afterResize / onResize / onSelected 四处驱动；容器内部全流体布局，
   不测量、不钉宽、不用 ResizeObserver。

## 三、数据与序列化

6. **序列化载体是隐藏 widget**（timeline_data / run_name / llm_* 等）。
   写值只准普通赋值 `widget.value = x`。**绝不用 Object.defineProperty**
   （前端定义成不可配置，重定义抛错崩工作流加载）。
7. **一切修改走 `store.commit()`**：统一序列化 + 同步关联 widget + 广播。
   打字走轻量 commit（不重绘、保焦点），结构变更才 structural 重绘。
8. **JSON schema 与后端 `parse_director` 逐字段对齐**（director/payload.py）：
   `frameRate / global{prompt,taskType,refs,refAudios,refVideos} /
   output{continuityEnabled,continuityOverlapFrames,audioMode,runSelection} /
   runSelectEnabled / segments[{id,durationSec,frameCount,prompt,taskType,
   refs,refAudios,refVideos,genImage}] / shots / video / videoClips`。
   注意：后端只要 `shots` 非空就无视 `segments`——fl2v 之外的模式序列化时
   shots 必须为空数组。
9. **时长/帧网格**：用户秒数 → 17k+5 帧网格（`util.setDuration`，上限 512 帧）。
   视频模式（v2v/rv2v）的段不参与网格规范化（start/length 由 video.js 精确
   维护，套网格会让帧数与源区间漂移）。
10. **缓存状态体**（/h3_scenedirector/status）从刚序列化的 JSON 构建，
    字段与 make_list 产出的行一一对应（含 r2v 序列化时合入每段的公共音/视）。
11. **存档兼容**：load 时必须规范化旧存档——Director 时代的段可能没有
    `durationSec`（只有 start/length/frameCount），直接用会崩渲染
    （"死了 prompt"事故：渲染崩在半路，编辑不落进段）。

## 四、分层与工程

12. 组件只碰 store 与后端通道（api），不感知节点内部；渲染按模式路由
    （cards.js 批量系 / video.js 视频系），v2v/rv2v 不挂胶片带。
13. WS 监听、定时器一律在 onRemoved 退订/清理（extras.dispose）。
14. 皮肤集中在 skin.css，类名 `sd2-*`、作用域 `.mmx-host`。
