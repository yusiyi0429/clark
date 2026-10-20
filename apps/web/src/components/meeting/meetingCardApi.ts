import type { TMeetingActionItem, TMeetingCardConfirmRequest, TMeetingCardDraft, TMeetingCardView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/**
 * 会议卡（FR-4、FR-5）的四个接口：读卡、整份存草稿、整卡确认、重试会议事件写入。
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

/** 整份保存草稿。actionItems 不传时服务端沿用已存的（这一版卡上不编辑行动项）。 */
export const saveMeetingCardDraft = (meetingId: string, draftVersion: number, draft: TMeetingCardDraft, actionItems?: TMeetingActionItem[]) =>
  settle(browserApi.PUT("/api/meetings/{id}/card/draft", {
    params: { path: { id: meetingId } }, body: { draftVersion, draft, ...(actionItems ? { actionItems } : {}) },
  }));

export const confirmMeetingCard = (meetingId: string, body: TMeetingCardConfirmRequest) =>
  settle(browserApi.POST("/api/meetings/{id}/card/confirm", { params: { path: { id: meetingId } }, body }));

export const retryMeetingCardSync = (meetingId: string) =>
  settle(browserApi.POST("/api/meetings/{id}/card/retry", { params: { path: { id: meetingId } } }));
