"""GET /healthz for adapter readiness and configuration diagnostics."""
from __future__ import annotations

from typing import Annotated

import psycopg
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from memory_service import working

from adapter.contracts import HealthzReport
from adapter.settings import Settings, get_settings

router = APIRouter(tags=["health"])


def _health_report(settings: Settings) -> HealthzReport:
    warnings: list[str] = []
    db_ok = False
    chains = 0
    conn: psycopg.Connection | None = None
    try:
        # 期限不能省，理由整段写在 `deps.get_conn` 上 —— 这一条尤其要紧：
        # 健康探针按固定频率来，每一次挂住都占一个线程池线程不还。
        conn = psycopg.connect(
            settings.database_url, connect_timeout=settings.db_connect_timeout
        )
        conn.execute("SELECT 1").fetchone()
        db_ok = True
        chains = len(
            working.list_chains(
                conn,
                tenant_id=settings.memory_tenant,
                organization_id=settings.memory_org,
            )
        )
    except psycopg.Error as exc:
        warnings.append(f"数据库不可达：{exc}")
    finally:
        if conn is not None:
            conn.close()

    embedding = settings.embedding_configured
    if not embedding:
        warnings.append(
            "embedding 未配置（MEMORY_EMBEDDING_API_KEY/BASE_URL/MODEL），P3 将不可用"
        )
    if not settings.adapter_auth:
        warnings.append("ADAPTER_AUTH 未配置，本服务不校验 Basic Auth")
    elif ":" not in settings.adapter_auth:
        warnings.append("ADAPTER_AUTH 不是 user:password 形式，本服务不校验 Basic Auth")
    if not settings.viewer_user_id:
        warnings.append("VIEWER_USER_ID 未配置，依赖 viewer 的端点将不可用")

    return HealthzReport(
        ok=db_ok,
        db=db_ok,
        embedding=embedding,
        chains=chains,
        warnings=warnings,
    )


@router.get("/healthz", response_model=HealthzReport)
def healthz(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthzReport | JSONResponse:
    """Return the report; a database outage is a 503, never a 404.

    The report body remains the stable ``HealthzReport`` shape on 503 so probes
    can explain whether the failure is database or configuration related.
    """
    report = _health_report(settings)
    if not report.db:
        return JSONResponse(status_code=503, content=report.model_dump(mode="json"))
    return report
