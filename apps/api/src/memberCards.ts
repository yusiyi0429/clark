import type { TCard } from "@warmap/contracts";
import { projectIssueCard, type IssueRow } from "./issues.js";
import { projectMeetingCard, type MeetingRow } from "./meetingStore.js";

/** 成员卡片和成员 Agent 共用同一份可见内容。 */
export function projectMemberIssueCard(row: IssueRow, secret: string): TCard {
  const card = projectIssueCard(row, secret);
  return { ...card, payload: { status: row.status, location: row.location, urgency: row.urgency,
    whyNow: (row.origin_ref as { whyNow?: string } | null)?.whyNow ?? null,
    research: { status: row.research.status, doc: row.research.doc ?? null },
    receipts: row.receipts.map((receipt) => ({ id: receipt.id, decisionText: receipt.decisionText, createdAt: receipt.createdAt, revokedAt: receipt.revokedAt ?? null })) },
    actions: [], navigation: [{ href: `/me/issues/${row.id}`, label: "议题" }] };
}

export function projectMemberMeetingCard(row: MeetingRow, secret: string): TCard {
  const card = projectMeetingCard(row, secret);
  return { ...card, payload: { status: row.status, scheduledAt: row.scheduled_at.toISOString(), endsAt: row.ends_at.toISOString(),
    leadDriId: row.lead_dri_id, participants: row.participants, purpose: row.preflight.taskDefinition?.reviewPurpose ?? row.title,
    materials: row.materials.map(({ storageKey: _storageKey, sha256: _sha256, ...material }) => material), preflightBrief: row.preflight.brief,
    outcome: row.outcome ? { items: row.outcome.items.filter((item) => (item.kind === "decision" || item.kind === "todo") && item.review?.status === "confirmed")
      .map((item) => ({ id: item.id, kind: item.kind, text: item.text, ownerPersonId: item.ownerPersonId })) } : null },
    actions: [], navigation: [{ href: `/me/meetings/${row.id}`, label: "会议" }] };
}
