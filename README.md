# ComfyUI-H3-StoryDirector

MiniMax H3 的导演工作台：以"场景 / 动作"的心智模型做长视频——一次 run 是一个**场景**（物理上是连续镜头），每段是场景里的一个**动作**。逐段增量渲染，段间用**运动上下文**真正延续画面与声音。

![工作台界面](docs/workbench.png)

## 特性

- **分镜时间线工作台**（`H3StoryDirectorList` 节点）：场景设定表、资产卡（角色/场景/物品，图片自动编号 `<Picture N>` 注入每段条件）、分镜轨道（缩略图、状态徽标、重摇、排序、段内点播）
- **运动上下文链接**：上一段尾部最多 39 帧作为永不去噪的条件块钉进下一段时间轴——模型读到的是真实的**运动**而不是一张末帧静照；音频从上一段的采样 latent 直切延续，相位级连续
- **增量重渲**：每段缓存到 `output/h3_storydirector/<run>/`（AV latent + mp4 + 海报），改哪段渲哪段，第一个变动段之后级联；改全局设定全链重渲
- **反上帝节点**：采样完全走接线——`model`（可串 Spectrum 等补丁）、`sampler`、`sigmas`、可选 `negative`+`cfg`。文本编码在独立的编码头里完成，CLIP 层优化随意插
- **精确时长**：写 5s 交付 5s（VAE 网格对齐的盈余自动裁掉，连续性锚在实际交付的尾部，接缝无洞）
- 全部代码自研；与同生态旧包同装时补丁带认领养守卫，不会叠加

## 节点

| 节点 | 职责 |
|---|---|
| H3 Story Director List | 工作台载体：场景设定表 + 资产卡 + 分镜时间线 |
| H3 Story Director Conditioning | 逐段条件编码（CLIP/VAE 接线，明面可见可hack） |
| H3 Story Director Chain | 纯循环引擎：钉帧 → 采样 → 解码 → 缓存 → 拼接 |
| H3 Story Director Latent Template | 统一渲染窗口的空 AV latent（MultiRate 类采样器用） |

## 安装

```bash
cd ComfyUI/custom_nodes
git clone <repo> ComfyUI-H3-StoryDirector
# 重启 ComfyUI
```

依赖 ComfyUI 原生 MiniMax H3 支持（模型见 [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)）。示例工作流在 `example_workflows/`。

## 提示词协议（承接句写法）

钉帧只带约 1 秒的运动记忆，跨段的运动逻辑靠文本维持：

1. 设定表加一行固定的**走位与机位**（方向/机位全片统一）
2. 每段开头写 `承接上段：…`（继承的运动/机位状态），结尾写 `收尾状态：…`
3. 段内只写增量动作；要切镜头就显式写"切镜头"并重新建立场景
4. 参考图管身份不管运动——资产图别放姿势感太强的

## 测试

```bash
python tests/test_patch_layout.py  # 布局补丁语义（纯 CPU 离线）
python tests/test_smoke.py         # 节点注册 + 运动上下文 + 裁剪（纯 CPU 离线）
```

## 许可

Apache License 2.0。
