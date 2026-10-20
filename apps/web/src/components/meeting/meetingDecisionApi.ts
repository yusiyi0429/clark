import type { TMeetingWorldResponse, TWorldAnchor } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 会议入本体：挂点与会议记录状态（GET /api/meetings/:id/world，不进会议卡）。 */
async function settleWorld(promise: Promise<{ data?: TMeetingWorldResponse; error?: unknown; response: Response }>): Promise<TMeetingWorldResponse> {
  const { data, error, response } = await promise;
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录已过期"); }
  if (!response.ok || !data) throw new Error((error as { message?: string } | undefined)?.message ?? "没有成功，请重试");
  return data;
}

/** 会议页单独取：这场会在本体里；看不到（没参会）时为 null。 */
export async function getMeetingWorld(meetingId: string): Promise<TMeetingWorldResponse | null> {
  const { data, response } = await browserApi.GET("/api/meetings/{id}/world", { params: { path: { id: meetingId } } });
  return response.ok && data ? data : null;
}

/** 会议入本体：改挂点；null 回到自动。 */
export const setMeetingWorldAnchors = (meetingId: string, anchors: { kind: "mission" | "unit"; id: string }[] | null) =>
  settleWorld(browserApi.PUT("/api/meetings/{id}/world-anchors", { params: { path: { id: meetingId } }, body: { anchors } }));

export async function listMeetingWorldAnchorOptions(meetingId: string): Promise<TWorldAnchor[]> {
  const { data, response } = await browserApi.GET("/api/meetings/{id}/world-anchor-options", { params: { path: { id: meetingId } } });
  if (!response.ok || !data) throw new Error("没有读到可选的对象");
  return data.options;
}
