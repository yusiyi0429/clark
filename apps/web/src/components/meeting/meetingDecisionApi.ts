import type { TMeetingDecisionView, TMeetingDecisionVerdict, TMeetingWorldResponse, TWorldAnchor } from "@warmap/contracts";
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

/** 代判拆成两种：定了（已往下推）、没定（什么都没推）。 */
export const decisionStatusLabel = (decision: Pick<TMeetingDecisionView, "status" | "tier" | "recommendation">): string => ({
  pending: decision.tier === "strategic" ? "待 CEO 确认" : "待确认",
  confirmed: decision.tier === "strategic" ? "CEO 已确认" : "已确认",
  edited: "已改",
  not_decided: "其实没定",
  rejected: "CEO 不同意",
  agent_judged: decision.recommendation === "confirmed" ? "Agent 代判 · 定了" : "Agent 代判 · 没定",
}[decision.status]);

async function settleWorld(promise: Promise<{ data?: TMeetingWorldResponse; error?: unknown; response: Response }>): Promise<TMeetingWorldResponse> {
  const { data, error, response } = await promise;
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录已过期"); }
  if (!response.ok || !data) throw new Error((error as { message?: string } | undefined)?.message ?? "没有成功，请重试");
  return data;
}

/** 会议页单独取：这场会在本体里、每条生效的决定落到哪；看不到（没参会）时为 null。 */
export async function getMeetingWorld(meetingId: string): Promise<TMeetingWorldResponse | null> {
  const { data, response } = await browserApi.GET("/api/meetings/{id}/world", { params: { path: { id: meetingId } } });
  return response.ok && data ? data : null;
}

/** 会议入本体：标不写进本体（或取消）。 */
export const setMeetingWorldExcluded = (meetingId: string, excluded: boolean) =>
  settleWorld(browserApi.PUT("/api/meetings/{id}/world-excluded", { params: { path: { id: meetingId } }, body: { excluded } }));

/** 会议入本体：改挂点；null 回到自动。 */
export const setMeetingWorldAnchors = (meetingId: string, anchors: { kind: "mission" | "unit"; id: string }[] | null) =>
  settleWorld(browserApi.PUT("/api/meetings/{id}/world-anchors", { params: { path: { id: meetingId } }, body: { anchors } }));

export async function listMeetingWorldAnchorOptions(meetingId: string): Promise<TWorldAnchor[]> {
  const { data, response } = await browserApi.GET("/api/meetings/{id}/world-anchor-options", { params: { path: { id: meetingId } } });
  if (!response.ok || !data) throw new Error("没有读到可选的对象");
  return data.options;
}
