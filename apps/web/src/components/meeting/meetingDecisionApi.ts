import { useEffect, useState } from "react";
import type { TMeetingBookingRequest, TMeetingDraftStatusResponse, TMeetingMinutesFetchResponse, TOrganizeFeishuMinuteRequest, TMeetingWorldResponse, TPickedWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";

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

/** 会议页页头用的「这场会在本体里」：打开时取一次，会议卡确认、改过（meeting-changed）再取。 */
export function useMeetingWorld(meetingId: string) {
  const [detail, setDetail] = useState<TMeetingWorldResponse | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void getMeetingWorld(meetingId).then((next) => { if (live) setDetail(next); }, () => undefined);
    load();
    window.addEventListener("meeting-changed", load);
    return () => { live = false; window.removeEventListener("meeting-changed", load); };
  }, [meetingId]);
  return [detail, setDetail] as const;
}

/** 会议入本体：改挂点；null 回到自动。 */
export const setMeetingWorldAnchors = (meetingId: string, anchors: TPickedWorldAnchor[] | null) =>
  settleWorld(browserApi.PUT("/api/meetings/{id}/world-anchors", { params: { path: { id: meetingId } }, body: { anchors } }));

export async function listMeetingWorldAnchorOptions(meetingId: string): Promise<TWorldAnchorOption[]> {
  const { data, response } = await browserApi.GET("/api/meetings/{id}/world-anchor-options", { params: { path: { id: meetingId } } });
  if (!response.ok || !data) throw new Error("没有读到可选的对象");
  return data.options;
}

/** 约会议时某月能挑的挂点。 */
export async function listWorldAnchorOptions(period: string): Promise<TWorldAnchorOption[]> {
  const { data, response } = await browserApi.GET("/api/world-anchor-options", { params: { query: { period } } });
  if (!response.ok || !data) throw new Error("没有读到可选的对象");
  return data.options;
}

export type DirectoryPerson = { personId: string; displayName: string; roles: string[] };
/** 完整人员目录（带角色，只给 CEO）：CEO 约会议时选主持人。 */
export async function listPeople(): Promise<DirectoryPerson[]> {
  const { data, response } = await browserApi.GET("/api/people");
  return response.ok && data ? data.people : [];
}
/** 人员名册（CEO 和成员）：约会议选参会人。 */
export async function listPersonDirectory(): Promise<{ personId: string; displayName: string }[]> {
  const { data, response } = await browserApi.GET("/api/people/directory");
  return response.ok && data ? data.people : [];
}

/** 约会议：成功给新会议卡，失败给错误码（界面换成短标签）。 */
export async function bookMeeting(body: TMeetingBookingRequest): Promise<{ card: Card } | { code: string }> {
  const { data, error, response } = await browserApi.POST("/api/meetings", { body });
  if (response.status === 401) { window.location.assign("/access"); return { code: "UNAUTHENTICATED" }; }
  return response.ok && data ? { card: data.card } : { code: (error as { code?: string } | undefined)?.code ?? "FAILED" };
}

/** 对话里的一张会议卡约好没有：约好了给那场会，没约为 null。 */
export async function meetingDraftStatus(draftId: string): Promise<TMeetingDraftStatusResponse["meeting"]> {
  const { data, response } = await browserApi.GET("/api/meeting-drafts/{draftId}", { params: { path: { draftId } } });
  if (!response.ok || !data) throw new Error("没有读到");
  return data.meeting;
}

/** 整理飞书里直接开的会：成功给新会议 id，失败给错误码。 */
export async function organizeFeishuMinute(minuteToken: string, body: TOrganizeFeishuMinuteRequest): Promise<{ meetingId: string } | { code: string }> {
  const { data, error, response } = await browserApi.POST("/api/me/feishu-minutes/{token}/organize", { params: { path: { token: minuteToken } }, body });
  if (response.status === 401) { window.location.assign("/access"); return { code: "UNAUTHENTICATED" }; }
  return response.ok && data ? { meetingId: data.meetingId } : { code: (error as { code?: string } | undefined)?.code ?? "FAILED" };
}

/** 把妙记记到天枢里约好的那场会：成功给会议 id，失败给错误码。 */
export async function attachFeishuMinute(minuteToken: string, meetingId: string): Promise<{ meetingId: string } | { code: string }> {
  const { data, error, response } = await browserApi.POST("/api/me/feishu-minutes/{token}/attach", { params: { path: { token: minuteToken } }, body: { meetingId } });
  if (response.status === 401) { window.location.assign("/access"); return { code: "UNAUTHENTICATED" }; }
  return response.ok && data ? { meetingId: data.meetingId } : { code: (error as { code?: string } | undefined)?.code ?? "FAILED" };
}

/** 忽略这份妙记，不再提示。 */
export async function ignoreFeishuMinute(minuteToken: string): Promise<{ ok: true } | { code: string }> {
  const { error, response } = await browserApi.POST("/api/me/feishu-minutes/{token}/ignore", { params: { path: { token: minuteToken } } });
  if (response.status === 401) { window.location.assign("/access"); return { code: "UNAUTHENTICATED" }; }
  return response.ok ? { ok: true } : { code: (error as { code?: string } | undefined)?.code ?? "FAILED" };
}

type MinutesResult = TMeetingMinutesFetchResponse | { code: string; message?: string };
async function settleMinutes(promise: Promise<{ data?: TMeetingMinutesFetchResponse; error?: unknown; response: Response }>): Promise<MinutesResult> {
  const { data, error, response } = await promise;
  if (response.status === 401) { window.location.assign("/access"); return { code: "UNAUTHENTICATED" }; }
  const failure = error as { code?: string; message?: string } | undefined;
  return response.ok && data ? data : { code: failure?.code ?? "FAILED", message: failure?.message };
}
/** 妙记「再读一次」（主持人、创建人）。 */
export const refetchMeetingMinutes = (meetingId: string) =>
  settleMinutes(browserApi.POST("/api/meetings/{id}/minutes/refetch", { params: { path: { id: meetingId } } }));
/** 贴妙记链接读（主持人、创建人）。 */
export const readMeetingMinutesLink = (meetingId: string, url: string) =>
  settleMinutes(browserApi.POST("/api/meetings/{id}/minutes", { params: { path: { id: meetingId } }, body: { url } }));
