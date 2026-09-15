"""与 clark 侧 M7 客户端逐字段对齐的线上形状（冻结文件，主会话所有）。

规格来源：~/clark/src/lib/graphknowledge/client.ts:69-93。
GkEntity/GkVersion/GkSeed/GkDynamic 的字段名与可空性以那份 TS 定义为唯一真源；
peer 的投影代码必须能通过"用 TS 定义抄出来的断言"（见各任务书）。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class GkVersion(BaseModel):
    """P2 版本链中的一版。全部可空——服务端缺字段不崩，消费方按缺省处理。"""

    index: int | None = None
    status: str | None = None
    at: str | None = None
    statement: str | None = None
    meetingLabel: str | None = None


class GkEntity(BaseModel):
    """P1/P2 返回体。relations 是 {关系名: [对方短码]} 的袋子（M7 语义）。"""

    code: str | None = None
    label: str | None = None
    properties: dict[str, object] | None = None
    relations: dict[str, list[str]] | None = None
    versions: list[GkVersion] | None = None


class GkSeed(BaseModel):
    """P3 召回种子。code 必须是稳定业务短码（见 adapter/codes.py）。"""

    code: str | None = None
    type: str | None = None
    score: float | None = None


class GkDynamic(BaseModel):
    """P3 返回体。warning 是服务端自报的降级（如 embedding 未缓存），不是错误。"""

    query: str | None = None
    seeds: list[GkSeed] | None = None
    text: str | None = None
    warning: str | None = None


class HealthzReport(BaseModel):
    """GET /healthz 返回体。mode 固定 memory_service，便于与 tkos 后端区分。"""

    ok: bool
    mode: str = "memory_service"
    db: bool = False
    embedding: bool = False
    chains: int = 0
    warnings: list[str] = Field(default_factory=list)
