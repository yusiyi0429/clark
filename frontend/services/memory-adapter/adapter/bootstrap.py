"""把 workspsce 的 memory_service 挂进 sys.path（宿主注入，不 import aw）。

默认指向本机 workspsce 检出；可用 env MEMORY_SERVICE_SRC 覆盖。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_DEFAULT = Path("/Users/renhaoliu/Desktop/workspsce/src")


def bootstrap() -> Path:
    """把 memory_service 的父目录放进 sys.path，返回该目录。"""
    src = Path(os.environ.get("MEMORY_SERVICE_SRC", str(_DEFAULT))).resolve()
    if not (src / "memory_service").is_dir():
        raise RuntimeError(
            f"MEMORY_SERVICE_SRC 下没有 memory_service 包：{src}（检查 workspsce 检出位置或设置该 env）"
        )
    entry = str(src)
    if entry not in sys.path:
        sys.path.insert(0, entry)
    return src
