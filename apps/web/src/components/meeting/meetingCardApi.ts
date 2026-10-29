import type { TMeetingActionItem, TMeetingCardConfirmRequest, TMeetingCardDraft, TMeetingCardOwnerRequest, TMeetingCardReviewRequest, TMeetingCardView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/**
 * 会议卡（FR-4、FR-5）的接口：读卡、整份存草稿、指定说话人、整卡确认、重试会议事件写入。
 * 结果统一成 ok / 失败两种；失败只带状态码和错误码（界面按错误码显示标签，不显示服务端原话）。
 * status 0 是网络不通。
 */
export type CardResult = { ok: true; view: TMeetingCardView } | { ok: false; status: number; code: string };

async function settle(request: Promise<{ data?: TMeetingCardView; error?: unknown; response: Response }>): Promise<CardResult> {
  try {
    const { data, error, response } = await request;
    if (response.status === 401) window.location.assign("/access");
    if (response.ok && data) return { ok: true, view: data };
    return { ok: false, status: response.status, code: (error as { code?: string } | undefined)?.code ?? "" };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}

export const getMeetingCard = (meetingId: string) =>
  settle(browserApi.GET("/api/meetings/{id}/card", { params: { path: { id: meetingId } } }));

/** 整份保存草稿。actionItems 不传时服务端沿用已存的；传 [] 是全删了。 */
export const saveMeetingCardDraft = (meetingId: string, draftVersion: number, draft: TMeetingCardDraft, actionItems?: TMeetingActionItem[]) =>
  settle(browserApi.PUT("/api/meetings/{id}/card/draft", {
    params: { path: { id: meetingId } }, body: { draftVersion, draft, ...(actionItems ? { actionItems } : {}) },
  }));

export const confirmMeetingCard = (meetingId: string, body: TMeetingCardConfirmRequest) =>
  settle(browserApi.POST("/api/meetings/{id}/card/confirm", { params: { path: { id: meetingId } }, body }));

export const retryMeetingCardSync = (meetingId: string) =>
  settle(browserApi.POST("/api/meetings/{id}/card/retry", { params: { path: { id: meetingId } } }));

/**
 * 逐条确认一条决策或行动项、给决策补归属（通知栏、会议页共用）：ok 时 view 是最新会议卡（点的人读不了会议卡时为 null）；
 * 409 带着最新会议卡的也交回 view。
 */
export type ReviewResult = { ok: true; view: TMeetingCardView | null } | { ok: false; status: number; code: string; view?: TMeetingCardView };
async function itemResult(call: Promise<{ data?: { view: TMeetingCardView | null }; error?: unknown; response: Response }>): Promise<ReviewResult> {
  try {
    const { data, error, response } = await call;
    if (response.status === 401) window.location.assign("/access");
    if (response.ok && data) return { ok: true, view: data.view };
    const failure = error as { code?: string; view?: TMeetingCardView } | undefined;
    return { ok: false, status: response.status, code: failure?.code ?? "", ...(failure?.view ? { view: failure.view } : {}) };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}
export const reviewMeetingCardItem = (meetingId: string, body: TMeetingCardReviewRequest) =>
  itemResult(browserApi.POST("/api/meetings/{id}/card/reviews", { params: { path: { id: meetingId } }, body }));
/** 主持人把一条没有责任人的决策交给一位参会人确认。 */
export const assignMeetingDecisionOwner = (meetingId: string, body: TMeetingCardOwnerRequest) =>
  itemResult(browserApi.POST("/api/meetings/{id}/card/owners", { params: { path: { id: meetingId } }, body }));

/** 冻结前改「不写进本体」。 */
export const setMeetingCardWorldChoice = (meetingId: string, writeToWorld: boolean) =>
  settle(browserApi.PUT("/api/meetings/{id}/card/world", { params: { path: { id: meetingId } }, body: { writeToWorld } }));

/** 把没对上人的说话人指定给某人；personId 为 null 是「不是天枢里的人」。 */
export const assignMeetingCardSpeaker = (meetingId: string, draftVersion: number, speakerId: string, personId: string | null) =>
  settle(browserApi.POST("/api/meetings/{id}/card/speakers", { params: { path: { id: meetingId } }, body: { draftVersion, speakerId, personId } }));
