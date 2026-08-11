"""段间显存清理（可选开关，对应 Director 的 clear_vram_between_segments）。

每段渲染完调用一次：gc + 卸载已缓存模型 + 清 CUDA 缓存。
代价是下一段要重新装载权重——显存吃紧的场景用它换稳定。
"""

import gc
import logging

_LOG = logging.getLogger("h3_scenedirector.vram")


def cleanup_segment_vram(enabled=False):
    """释放段间 GPU 占用；enabled=False 直接返回。"""
    if not enabled:
        return
    gc.collect()
    try:
        import comfy.model_management as mm
        mm.cleanup_models_gc()
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception as e:  # 清理失败不致命，记一笔继续
        _LOG.warning("段间显存清理异常（忽略）: %r", e)
    _LOG.info("段间显存清理完成（模型已卸载，缓存已清空）")
