"""FastAPI 装配入口；业务逻辑留在各自的 APIRouter 模块。"""
from __future__ import annotations

from fastapi import FastAPI

from adapter.bootstrap import bootstrap  # noqa: E402

bootstrap()

from adapter.routes_dynamic import router as dynamic_router  # noqa: E402
from adapter.routes_entities import router as entities_router  # noqa: E402
from adapter.routes_health import router as health_router  # noqa: E402
from adapter.routes_static import router as static_router  # noqa: E402

app = FastAPI(
    title="clark-memory-adapter",
    version="0.1.0",
    description="M7-shaped read adapter over workspsce memory_service",
)

app.include_router(health_router)
app.include_router(static_router)
app.include_router(entities_router)
app.include_router(dynamic_router)
