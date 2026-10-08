import type { ApiError, Card } from "./api/client";

/** 首页对象按稳定 id 更新；不在首页的对象不加入首页。 */
export function replaceActionCard(cards: Card[], updated: Card): Card[] {
  return cards.map((card) => (card.id === updated.id ? updated : card));
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
