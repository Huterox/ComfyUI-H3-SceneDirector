"""运行状态日志桥：把关键动作和 ComfyUI 的模型装卸日志转成前端事件。

事件 h3_scenedirector_log 载荷：msg/src/ts + 显存快照（used/free/total GB）。
我们自己的关键动作由 emit_log 直接发（不经过 logging，防重复）；
root logger 上挂一个 handler 挑 ComfyUI 的模型装卸 INFO 桥接过去。
"""

import logging
import time

import comfy.model_management as mm
from comfy.internal_logging import DETAIL
from server import PromptServer

LOG_EVENT = "h3_scenedirector_log"

# 桥接白名单：模型装卸与任务生命周期。"Model loaded"/"AIMDO free" 是
# DETAIL(15) 级（装载明细：RAM/VRAM 占用、vbar 释放量），装桥时把 root
# 放到 DETAIL 让我们能收到；其余 handler 提到 INFO，控制台不刷屏。
_BRIDGE_KEYS = ("Requested to load", "Model loaded", "models unloaded",
                "AIMDO free", "got prompt", "Prompt executed")

_last = {"msg": None}


def _vram():
    """(used, free, total) GB；拿不到就 (-1, -1, -1)，前端据此不刷新读数。"""
    try:
        free = mm.get_free_memory(mm.get_torch_device())
        total = float(mm.total_vram)
        return (round((total - free) / 1024**3, 2),
                round(free / 1024**3, 2), round(total / 1024**3, 2))
    except Exception:
        return (-1.0, -1.0, -1.0)


def emit_log(msg, src="sd"):
    """发一条运行日志到前端工作台（带显存快照）；连续重复行只发一次。"""
    msg = str(msg)
    if msg == _last["msg"]:
        return
    _last["msg"] = msg
    try:
        used, free, total = _vram()
        PromptServer.instance.send_sync(LOG_EVENT, {
            "msg": msg, "src": src, "ts": time.time(),
            "used_gb": used, "free_gb": free, "total_gb": total})
    except Exception:
        pass


class _ComfyBridge(logging.Handler):
    def emit(self, record):
        try:
            if record.name.startswith("h3_scenedirector"):
                return                      # 自己的 logger 由 emit_log 直发
            msg = record.getMessage()
        except Exception:
            return
        if any(k in msg for k in _BRIDGE_KEYS):
            emit_log(msg, src="comfy")


def install_bridge():
    """root logger 挂桥（幂等；模块 import 即生效）。

    root 降到 DETAIL(15)——只多放行 DETAIL 级，DEBUG(10) 仍被挡在外；
    其余 handler（控制台）提到 INFO，明细只进前端日志条，不刷终端。"""
    root = logging.getLogger()
    if not any(isinstance(h, _ComfyBridge) for h in root.handlers):
        root.addHandler(_ComfyBridge(DETAIL))
    for h in root.handlers:
        if not isinstance(h, _ComfyBridge) and (h.level == 0 or h.level < logging.INFO):
            h.setLevel(logging.INFO)
    if root.level == 0 or root.level > DETAIL:
        root.setLevel(DETAIL)


install_bridge()
