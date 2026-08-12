"""ComfyUI-H3-SceneDirector：MiniMax H3 的场景导演工作台（长视频分镜链）。

Director 1.1 工程化重写：功能对齐 Director 生态（多任务模式/选择运行/
智能分镜/提示词增强），差异点是 latent 上下文窗口衔接（可选）+ 色彩
双层一致性 + 可组合节点架构（Spectrum 等加速即插即用）。

导入时应用两个自研补丁（带共存守卫：同生态补丁已在位则认领养，绝不叠加）：

  patch_layout   解除官方只认首/尾帧的关键帧锚定限制，把钉住的音频
                 移到本片自己的时间轴上，并在参考块挪动布局游标时
                 保持锚点坐标对齐
  patch_payload  阻止参考块分支覆盖关键帧的条件 latent，
                 让钉帧视频与钉帧音频可以共存

工作台节点全部为 H3SceneDirector* 类型。
"""

from .core.patch_layout import apply_patch as _apply_layout_patch
from .core.patch_payload import apply_patch as _apply_payload_patch

_apply_layout_patch()
_apply_payload_patch()

# 前端扩展目录：js/workbench 提供 H3SceneDirectorList 的分镜时间线界面
WEB_DIRECTORY = "./js"

from .director.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .director import routes as _routes  # noqa: F401  （导入即注册路由）
from .director import studio as _studio  # noqa: F401  （配置/项目库路由）
from .director import agent_svc as _agent_svc  # noqa: F401  （项目 agent 路由）
from .director import autoplan as _autoplan  # noqa: F401  （自动创作路由+工具注册）

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
