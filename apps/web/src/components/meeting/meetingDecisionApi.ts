import type { TMeetingDecisionView, TMeetingDecisionVerdict } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 会后「会上定了」：主持人确认之后，通知栏和会议页互相提醒重读。 */
export const MEETING_DECISIONS_CHANGED = "meeting-decisions-changed";

/** source：谁办的（通知栏办完自己会收起那一条，不必再重读）。 */
export async function reviewMeetingDecision(meetingId: string, decisionId: string, verdict: TMeetingDecisionVerdict, statement?: string,
  source: "rail" | "page" = "page"): Promise<TMeetingDecisionView> {
  const { data, error, response } = await browserApi.POST("/api/meetings/{id}/decisions/{decisionId}/review", {
    params: { path: { id: meetingId, decisionId } },
    body: { verdict, ...(statement ? { statement } : {}) },
  });
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录已过期"); }
  if (!response.ok || !data) throw new Error((error as { message?: string } | undefined)?.message ?? "没有成功，请重试");
  window.dispatchEvent(new CustomEvent(MEETING_DECISIONS_CHANGED, { detail: { decision: data.decision, source } }));
  return data.decision;
}

export const decisionStatusLabel = (decision: Pick<TMeetingDecisionView, "status" | "tier">): string => ({
  pending: decision.tier === "strategic" ? "待 CEO 确认" : "待确认",
  confirmed: decision.tier === "strategic" ? "CEO 已确认" : "已确认",
  edited: "已改",
  not_decided: "其实没定",
  rejected: "CEO 不同意",
  agent_judged: "Agent 代判，Host 尚未确认",
}[decision.status]);
