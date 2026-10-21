import type { TMeetingAttendees, TMeetingDecisionView, TMeetingMinutesFailure, TMeetingMinutesStatus, TMeetingParticipant } from "@warmap/contracts";

/** meeting_decisions 一行（随 meetingColumns 以 to_jsonb 带出，时间是字符串）。 */
export type MeetingDecisionRow = {
  id: string; meeting_id: string; tier: "strategic" | "host"; ordinal: number; statement: string; item_ids: string[];
  turn_id: string | null; quote: string | null; speaker_id: string | null;
  recommendation: "confirmed" | "not_decided"; why: string | null;
  status: TMeetingDecisionView["status"]; final_statement: string | null; reviewer_id: string | null;
  reviewed_at: string | Date | null; judged_at: string | Date | null; revision: number;
  remind_count: number; next_remind_at: string | Date | null; due_at: string | Date | null;
  impact_status: "none" | "pending" | "done" | "failed";
  created_at: string | Date; updated_at: string | Date;
};

const iso = (value: string | Date | null): string | null => value === null ? null : new Date(value).toISOString();

/** 生效的说法：改过就是改后的。 */
export const decisionStatement = (row: Pick<MeetingDecisionRow, "statement" | "final_statement">): string => row.final_statement ?? row.statement;

/** 这条决定现在是否已经生效、要往下推：主持人对 / 改，CEO 确认，或 Agent 代判且推荐「定了」。 */
export function decisionEffective(row: Pick<MeetingDecisionRow, "status" | "recommendation">): boolean {
  return row.status === "confirmed" || row.status === "edited" || (row.status === "agent_judged" && row.recommendation === "confirmed");
}

export function projectMeetingDecision(row: MeetingDecisionRow, participants: TMeetingParticipant[], canReview: boolean): TMeetingDecisionView {
  const name = (id: string | null) => (id ? participants.find((person) => person.personId === id)?.displayName ?? null : null);
  return {
    id: row.id, meetingId: row.meeting_id, tier: row.tier, ordinal: row.ordinal,
    statement: decisionStatement(row), originalStatement: row.statement,
    quote: row.quote, speakerName: name(row.speaker_id),
    recommendation: row.recommendation, why: row.why, status: row.status, revision: row.revision,
    reviewerName: name(row.reviewer_id), reviewedAt: iso(row.reviewed_at), dueAt: iso(row.due_at),
    canReview,
  };
}

/** 妙记状态：已有逐字稿或候选就是 ready，其余按库里记的。 */
export function minutesStatusOf(row: { minutes_status?: TMeetingMinutesStatus | null; transcript: unknown; transcript_candidate: unknown }): TMeetingMinutesStatus {
  if (row.transcript || row.transcript_candidate) return "ready";
  return row.minutes_status ?? "none";
}

/** 开完多久以内的会才自动去拿妙记（更早的会照旧手动上传）。 */
export const MINUTES_RECENT_MS = 48 * 60 * 60_000;
/** 等妙记最多等多久，过了就退回手动上传。 */
export const MINUTES_GIVE_UP_MS = 2 * 60 * 60_000;

/**
 * 自动同步失败、要手动导入会议记录（会议页「导入会议记录」）：没授权或等太久（manual）；读取失败且不是原文还没好；
 * 开完超过 48 小时、不会再自动去拿。还在等妙记的（waiting、原文还没好）和已有逐字稿或候选的不给。
 */
export function minutesManualImport(
  row: { minutes_status?: TMeetingMinutesStatus | null; minutes_failure?: TMeetingMinutesFailure | null; transcript: unknown; transcript_candidate: unknown; ended_at: Date | null; ends_at: Date },
  at: Date,
): boolean {
  if (row.transcript || row.transcript_candidate) return false;
  if (row.minutes_status === "manual") return true;
  if (row.minutes_status === "failed") return row.minutes_failure !== "not_ready";
  if (row.minutes_status === "waiting") return false;
  return at.getTime() - (row.ended_at ?? row.ends_at).getTime() > MINUTES_RECENT_MS;
}

/** 实际参会的人：飞书名单优先，拿不到时退回手填的参会人。 */
export function attendeesOf(row: { attendees_actual?: string[] | null; participants: TMeetingParticipant[] }): TMeetingAttendees {
  return row.attendees_actual
    ? { source: "feishu", personIds: row.attendees_actual }
    : { source: "manual", personIds: row.participants.map((person) => person.personId) };
}
