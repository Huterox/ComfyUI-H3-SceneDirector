"""director 子包：节点 / 路由 / 项目 agent。

pi 运行时（pi_ai / pi_agent_core / pi_storage_sqlite，MIT，vendored 自
pi-py-main@0.83.0）随包携带在 ../vendor/，免 pip 安装。引导放在这里
而不是包根 __init__：ComfyUI 以包名导入（走根 __init__ → 本文件），
离线单测以 sys.path 直导 director.agent_svc（也走本文件），两条路
径都能命中同一份 vendor。
"""

import os as _os
import sys as _sys

_vendor = _os.path.join(_os.path.dirname(__file__), "..", "vendor")
_vendor = _os.path.abspath(_vendor)
if _vendor not in _sys.path:
    _sys.path.insert(0, _vendor)
