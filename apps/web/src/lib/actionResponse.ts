import type { ApiError, Card } from "./api/client";
import type { TMissionRoundDraftPayload } from "@warmap/contracts";

/** 整理草稿把尚未建轮次的 slot 换成真实轮次；其他首页对象仍按稳定 id 更新。 */
export function replaceActionCard(cards: Card[], updated: Card): Card[] {
  return cards.map((card) => {
    if (card.id === updated.id) return updated;
    if (card.objectRef.type !== "mission-round-slot" || updated.objectRef.type !== "mission-round") return card;
    const before = card.payload as TMissionRoundDraftPayload;
    const after = updated.payload as TMissionRoundDraftPayload;
    return before.battlefieldId === after.battlefieldId && before.period === after.period ? updated : card;
  });
}

export type ActionOutcome =
  | { kind: "ok"; card: Card }
  | { kind: "unauthorized" }
  | { kind: "conflict"; message: string; latestCard?: Card }
  | { kind: "error"; message: string };

/**
 * Action 响应 → 展示状态。纯函数：openapi-fetch 已经把 ApiError 解析进 error，
 * 不再读第二次 response body；409 必须带上 latestCard 才能让 CEO 基于最新内容重新核对。
 */
export function interpretActionResponse(
  status: number,
  data: { cards?: Card[] } | undefined,
  error: unknown,
): ActionOutcome {
  if (status === 401) return { kind: "unauthorized" };
  const card = data?.cards?.[0];
  if (status >= 200 && status < 300 && card) return { kind: "ok", card };

  const body = (error ?? {}) as Partial<ApiError>;
  if (status === 409) {
    return {
      kind: "conflict",
      message: body.message ?? "对象已被修改，请基于最新内容重新核对",
      ...(body.latestCard ? { latestCard: body.latestCard } : {}),
    };
  }
  return { kind: "error", message: body.message ?? "Action 执行失败" };
}
