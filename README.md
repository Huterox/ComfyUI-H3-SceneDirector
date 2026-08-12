# ComfyUI-H3-SceneDirector

MiniMax H3 的**场景导演工作台**：多段长视频分镜链插件（Director 1.1 工程化实现）。

功能对齐 Director 生态（多任务模式 / 选择运行 / 智能分镜 / 提示词增强），差异点是
**特征上下文窗口衔接**、**色彩双层一致性**和**可组合节点架构**——不做上帝节点，
model / sampler / sigmas 全部走接线，Spectrum 等加速节点即插即用。

## 节点

| 节点 | 职责 |
|---|---|
| `H3SceneDirectorList` | 导演工作台载荷（分镜时间线 UI），输出 SEGMENTS |
| `H3SceneDirectorConditioning` | 逐段条件编码（CLIP/参考素材/首尾帧/源片段），输出 STORY_COND |
| `H3SceneDirectorChain` | 衔接引擎：钉帧 → 采样 → 解码 → 缓存 → 拼接 |
| `H3SceneDirectorLatentTemplate` | 统一渲染窗口模板（MultiRate T8 类采样器用） |

外部节点照常使用：`UNETLoader` → （可选 `SpectrumApplyMiniMaxH3`）→ Chain；
`CLIPLoader`（type=minimax）、`VAELoader` ×2、`ResolutionSelector`、
`KSamplerSelect`、`BasicScheduler`。

## 特性

- **多任务模式**（逐段）：t2v / i2v / fl2v（首尾帧，可只传尾帧）/ r2v（参考素材
  图9·音频3·视频3）/ v2v / rv2v（源视频 + 参考）；v2v 声音模式 生成/原声/静音
- **特征上下文窗口衔接**（可选，默认开）：上一段尾部 39 帧 + 音频编码为 latent
  条件钉入下一段注意力上下文，交付视图锚定、音画同点收尾；关闭即官方原生逐段
- **色彩双层一致性**：全片逐帧滑动校色 color_lock（治漂移）+ 接缝亮度渐变
  （治接口跳变）+ 接缝回声诊断
- **级联失效缓存 + 选择运行**：改哪段只烧哪段之后；勾选段渲染、未选段缓存填充
- **工作台 UI**（v2 自研前端）：六模式页签、批量提示词组卡、fl2v 镜组卡、
  r2v 公共参数面板（图/音/视分类）、v2v 舞台播放器+段时间轴（拖缘调区间/
  智能分割/均分/追加视频）、缓存胶片带（绿/橙/红状态点+点播）、实时预览、
  状态行进度条、@引用补全、每段魔法棒 LLM 扩写（内联预览-确认-应用）
- **智能分镜**：零依赖帧差切点检测（PyAV），一键把源视频切成 v2v 段
- **LLM 提示词增强**：OpenAI 兼容 / Anthropic 端点，按任务类型的官方模板，
  配置随工作流持久化
- **段间 VRAM 清理**（可选）：显存吃紧时换稳定

## 示例工作流（example_workflows/）

| 文件 | 说明 |
|---|---|
| `场景导演工作台.json` | 全能工作台：任务模式页签切换（t2v/i2v/fl2v/r2v/v2v/rv2v）；r2v/v2v/rv2v 自动联动 UNET 为 ref2va |
| `场景导演工作台_Spec加速.json` | 同款 + Spectrum 加速节点（UNETLoader→Spectrum→Chain/Scheduler） |

## 模型

| 用途 | 文件 | 目录 |
|---|---|---|
| UNET（t2v/i2v/fl2v） | `minimax_h3_fl2va_*_int8_convrot.safetensors` | `models/diffusion_models/` |
| UNET（r2v/v2v/rv2v） | `minimax_h3_ref2va_*_int8_convrot.safetensors` | `models/diffusion_models/` |
| CLIP | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` |
| VAE | `minimax_h3_video_vae_fp16` + `minimax_h3_audio_vae_fp32` | `models/vae/` |

## 一致性实现（简版）

衔接开启时：上一段**交付视图**的尾部帧经视频 VAE 编码为条件块、尾部波形经
音频 VAE 编码为音频步，钉入下一段打包序列的时间轴头部（噪声增强钉在 t≈1），
DiT 注意力将其读作"已知历史"；渲染完裁掉钉帧部分，只交付新内容。缓存按
全局/逐段内容指纹级联失效。详见各模块头部注释（`core/`、`director/`）。

## 许可证

Apache-2.0
