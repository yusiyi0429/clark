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

export function projectMemberMeetingCard(row: MeetingRow, secret: string): TCard {
  const card = projectMeetingCard(row, secret);
  const payload = card.payload as TMeetingCardPayload;
  return { ...card, payload: {
    status: payload.status, scheduledAt: payload.scheduledAt, endsAt: payload.endsAt, endedAt: payload.endedAt,
    leadDriId: payload.leadDriId, participants: payload.participants,
    purpose: payload.preflight.taskDefinition?.reviewPurpose ?? null,
    materials: payload.materials,
    preflight: { status: payload.preflight.status, brief: payload.preflight.brief,
      readiness: payload.preflight.readiness ?? null, summary: payload.preflight.summary ?? null },
    outcome: payload.outcome ? { items: payload.outcome.items
      .filter((item) => (item.kind === "decision" || item.kind === "todo") && item.review?.status === "confirmed")
      .map((item) => ({ id: item.id, kind: item.kind, text: item.text, ownerPersonId: item.ownerPersonId })) } : null,
  },
    actions: [], navigation: [{ href: `/me/meetings/${row.id}`, label: "会议" }] };
}
