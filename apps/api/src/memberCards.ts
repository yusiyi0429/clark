import type { TCard, TMeetingCardPayload } from "@warmap/contracts";
import { projectIssueCard, type IssueRow } from "./issues.js";
import { projectMeetingCard, type MeetingRow } from "./meetingStore.js";

/** 成员卡片和成员 Agent 共用同一份可见内容。 */
/** locationName：成员看不到 CEO 的战场与能力登记表，位置名由服务端算好给他。 */
export function projectMemberIssueCard(row: IssueRow, secret: string, locationName: string | null = null): TCard {
  const card = projectIssueCard(row, secret);
  const payload = card.payload as Record<string, unknown>;
  const research = payload.research as Record<string, unknown>;
  const receipts = payload.receipts as Record<string, unknown>[];
  return { ...card, payload: { ...payload,
    originRef: { whyNow: (row.origin_ref as { whyNow?: string } | null)?.whyNow ?? null },
    research: { status: research.status, doc: research.doc ?? null },
    receipts: receipts.map(({ id, actionType, decisionText, createdAt, revokedAt, override }) =>
      ({ id, actionType, decisionText, createdAt, revokedAt, override })),
    dismissReason: null, locationName },
    actions: [], navigation: [{ href: `/me/issues/${row.id}`, label: "议题" }] };
}

export function projectMemberMeetingCard(row: MeetingRow, secret: string, viewerId?: string): TCard {
  return projectMemberMeetingCardFromCard(projectMeetingCard(row, secret), viewerId);
}

export function projectMemberMeetingCardFromCard(card: TCard, viewerId?: string): TCard {
  const payload = card.payload as TMeetingCardPayload;
  const isHost = payload.leadDriId === viewerId;
  // 原文和完整纪要只给实际参会的人（飞书参会名单，中途加入的也算；拿不到时是手填的参会人）和 CEO；其他人只看已确认的决定和待办。
  const attended = isHost || Boolean(viewerId && payload.attendees?.personIds.includes(viewerId));
  return { ...card, payload: {
    status: payload.status, scheduledAt: payload.scheduledAt, endsAt: payload.endsAt, endedAt: payload.endedAt,
    startedAt: payload.startedAt ?? null, hasEnded: payload.hasEnded,
    ...(isHost ? { transcriptCandidate: payload.transcriptCandidate } : {}),
    leadDriId: payload.leadDriId, createdBy: payload.createdBy ?? null, participants: payload.participants,
    purpose: payload.preflight.taskDefinition?.reviewPurpose ?? null,
    materials: payload.materials,
    preflight: { status: payload.preflight.status, brief: payload.preflight.brief,
      readiness: payload.preflight.readiness ?? null, summary: payload.preflight.summary ?? null },
    outcome: payload.outcome ? {
      // 生成会议卡的阶段和用时（排上、开跑的时刻）参会的人也看得到。
      ...(attended ? { summary: payload.outcome.summary, status: payload.outcome.status,
        pendingSince: payload.outcome.pendingSince ?? null, startedAt: payload.outcome.startedAt ?? null } : {}),
      items: payload.outcome.items
        .filter((item) => (item.kind === "decision" || item.kind === "todo") && item.review?.status === "confirmed")
        .map((item) => ({ id: item.id, kind: item.kind, text: item.text, ownerPersonId: item.ownerPersonId })) } : null,
    minutesStatus: payload.minutesStatus ?? "none",
    minutesFailure: payload.minutesFailure ?? null,
    minutesWaitingSince: payload.minutesWaitingSince ?? null,
    minutesManualImport: payload.minutesManualImport ?? false,
    feishuEvent: payload.feishuEvent ?? null,
    attended,
    ...(attended ? {
      // 原文只在已有逐字稿时带上（会前没有这一格）。
      ...(payload.transcript ? { transcript: payload.transcript } : {}),
      // 旧会议的逐条决定只读。
      decisions: payload.decisions ?? [],
    } : {}),
  },
    actions: isHost ? card.actions.filter((action) => ["meeting.end", "meeting.reschedule", "meeting.confirm_transcript_candidate", "meeting.discard_transcript_candidate", "meeting.retry_feishu_booking"].includes(action.actionType)) : [],
    navigation: [{ href: `/me/meetings/${card.objectRef.id}`, label: "会议" }] };
}
