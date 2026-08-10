"""ComfyUI-H3-StoryDirector：MiniMax H3 的导演工作台（长视频分镜链）。

导入时应用两个自研补丁（带共存守卫：同生态补丁已在位则认领养，绝不叠加）：

  patch_layout   解除官方只认首/尾帧的关键帧锚定限制，把钉住的音频
                 移到本片自己的时间轴上，并在参考块挪动布局游标时
                 保持锚点坐标对齐
  patch_payload  阻止参考块分支覆盖关键帧的条件 latent，
                 让钉帧视频与钉帧音频可以共存

工作台节点全部为 H3StoryDirector* 类型。
"""

from .core.patch_layout import apply_patch as _apply_layout_patch
from .core.patch_payload import apply_patch as _apply_payload_patch

_apply_layout_patch()
_apply_payload_patch()

# 前端扩展目录：js/workbench 提供 H3StoryDirectorList 的分镜时间线界面
WEB_DIRECTORY = "./js"

from .storyline.nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .storyline import routes as _routes  # noqa: F401  （导入即注册路由）

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
