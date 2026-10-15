/**
 * 数据来源性质（2026-10 反馈会议后改为“只约束、不标注”）：
 * - 议题 nature=ai_suggested：AI 识别的候选议题（存在 issues.origin_ref.nature），不是已经发生的业务问题，也不是正式待决策。
 * 省略即真实，旧数据一律没有这个性质。数据层字段保留；界面不再显示「AI 建议」标签（来自雷达的议题除外，由 origin 决定）；
 * 注入 Agent 的上下文仍写明性质，Agent 据此不把候选内容说成已发生的事实。
 */

export const ISSUE_AI_SUGGESTED_ORIGIN = "候选议题（AI 识别，不是已经发生的业务问题，也不是正式待决策）";

/** 议题来源性质：只认 origin_ref.nature = ai_suggested，其余一律按真实议题。 */
export function issueNatureOf(originRef: unknown): "ai_suggested" | undefined {
  return originRef && typeof originRef === "object" && (originRef as { nature?: unknown }).nature === "ai_suggested" ? "ai_suggested" : undefined;
}

/** 给 Agent 看的议题来源字段；真实议题返回空对象（不加任何字段，旧上下文不变）。 */
export function issueOriginFields(originRef: unknown): { nature?: "ai_suggested"; origin?: string } {
  return issueNatureOf(originRef) ? { nature: "ai_suggested", origin: ISSUE_AI_SUGGESTED_ORIGIN } : {};
}
