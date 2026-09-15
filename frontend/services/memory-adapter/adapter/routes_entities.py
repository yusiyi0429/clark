"""GET /api/v1/entities/{code}?view=latest|chain."""
from __future__ import annotations

from typing import Annotated, Literal

import psycopg
from fastapi import APIRouter, Depends

from adapter.contracts import GkEntity
from adapter.deps import get_conn
from adapter.errors import mapped
from adapter.settings import Settings, get_settings
from adapter.wm_views import project_entity

router = APIRouter(prefix="/api/v1/entities", tags=["entities"])


@router.get("/{code}", response_model=GkEntity)
@mapped
def entity(
    code: str,
    *,
    view: Literal["latest", "chain"] = "latest",
    conn: Annotated[psycopg.Connection, Depends(get_conn)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> GkEntity:
    """Return one scoped WM entity in M7 P1/P2 shape."""
    return project_entity(
        conn,
        code,
        view=view,
        tenant_id=settings.memory_tenant,
        organization_id=settings.memory_org,
    )
