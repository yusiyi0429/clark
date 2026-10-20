import type { TMeetingActionItem, TMeetingCardConfirmRequest, TMeetingCardDraft, TMeetingCardView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/**
 * 会议卡（FR-4、FR-5）的四个接口：读卡、整份存草稿、整卡确认、重试会议事件写入。
 * 结果统一成 ok / 失败两种；409 DRAFT_CHANGED 是「别人（或读卡时的差异刷新）改过草稿」，由卡片提示查看最新。
 */
export type CardResult = { ok: true; view: TMeetingCardView } | { ok: false; status: number; code: string; message: string };

type CardResponse = Promise<{ data?: TMeetingCardView; error?: unknown; response: Response }>;

async function settle(request: CardResponse): Promise<CardResult> {
  try {
    const { data, error, response } = await request;
    if (response.status === 401) window.location.assign("/access");
    if (response.ok && data) return { ok: true, view: data };
    const body = error as { code?: string; message?: string } | undefined;
    return { ok: false, status: response.status, code: body?.code ?? "", message: body?.message ?? "没有成功，请重试" };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", message: "网络不通，请重试" };
  }
}

export function getMeetingCard(meetingId: string): Promise<CardResult> {
  // 契约里 operationId「getMeetingCard」重名（GET /api/cards/meetings/{id} 也叫它），生成的响应类型成了会议 Card；按实际响应 MeetingCardView 读。
  return settle(browserApi.GET("/api/meetings/{id}/card", { params: { path: { id: meetingId } } }) as unknown as CardResponse);
}

/** 整份保存草稿。actionItems 不传时服务端沿用已存的（这一版卡上不编辑行动项）。 */
export const saveMeetingCardDraft = (meetingId: string, draftVersion: number, draft: TMeetingCardDraft, actionItems?: TMeetingActionItem[]) =>
  settle(browserApi.PUT("/api/meetings/{id}/card/draft", {
    params: { path: { id: meetingId } }, body: { draftVersion, draft, ...(actionItems ? { actionItems } : {}) },
  }));

export const confirmMeetingCard = (meetingId: string, body: TMeetingCardConfirmRequest) =>
  settle(browserApi.POST("/api/meetings/{id}/card/confirm", { params: { path: { id: meetingId } }, body }));

export const retryMeetingCardSync = (meetingId: string) =>
  settle(browserApi.POST("/api/meetings/{id}/card/retry", { params: { path: { id: meetingId } } }));
