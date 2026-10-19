import type { TMeetingAttendees, TMeetingDecisionView, TMeetingDecisionWorld, TMeetingMinutesStatus, TMeetingParticipant, TMeetingWorldView, TWorldAnchor } from "@warmap/contracts";
import type { MeetingRow } from "./meetingStore.js";

/** meeting_decisions 一行（随 meetingColumns 以 to_jsonb 带出，时间是字符串）。 */
export type MeetingDecisionRow = {
  id: string; meeting_id: string; tier: "strategic" | "host"; ordinal: number; statement: string; item_ids: string[];
  turn_id: string | null; quote: string | null; speaker_id: string | null;
  recommendation: "confirmed" | "not_decided"; why: string | null;
  status: TMeetingDecisionView["status"]; final_statement: string | null; reviewer_id: string | null;
  reviewed_at: string | Date | null; judged_at: string | Date | null; revision: number;
  remind_count: number; next_remind_at: string | Date | null; due_at: string | Date | null;
  impact_status: "none" | "pending" | "done" | "failed";
  world_status: "none" | "pending" | "committed" | "skipped" | "failed"; world_event_id: string | null;
  world_fallback?: boolean; world_event_revision?: number | null;
  created_at: string | Date; updated_at: string | Date;
  /** 这一版影响卡落到的对象（随 meetingColumns 带出；`SELECT *` 读出的行没有）。 */
  targets?: TWorldAnchor[];
};

/** 投影决定时用到的会议级信息：标了不写进本体、会议事件的挂点（决定挂到会议上时显示它）、看的人能不能看写入状态。 */
export type DecisionWorldContext = { excluded: boolean; meetingAnchors: TWorldAnchor[]; showStatus: boolean };

const iso = (value: string | Date | null): string | null => value === null ? null : new Date(value).toISOString();

/** 生效的说法：改过就是改后的。 */
export const decisionStatement = (row: Pick<MeetingDecisionRow, "statement" | "final_statement">): string => row.final_statement ?? row.statement;

/** 这条决定现在是否已经生效、要往下推：主持人对 / 改，CEO 确认，或 Agent 代判且推荐「定了」。 */
export function decisionEffective(row: Pick<MeetingDecisionRow, "status" | "recommendation">): boolean {
  return row.status === "confirmed" || row.status === "edited" || (row.status === "agent_judged" && row.recommendation === "confirmed");
}

const ANCHOR_ORDER = { mission: 0, task: 1, unit: 2, company: 3 } as const;
const sortAnchors = (anchors: TWorldAnchor[]) => [...anchors].sort((a, b) => ANCHOR_ORDER[a.kind] - ANCHOR_ORDER[b.kind] || a.title.localeCompare(b.title, "zh-CN"));

/** 一条决定写进本体的状态（只对生效的决定）。 */
function decisionWorld(row: MeetingDecisionRow, excluded: boolean): TMeetingDecisionWorld {
  if (excluded) return "off";
  if (row.world_status === "committed") return row.world_fallback ? "fallback" : "committed";
  if (row.world_status === "skipped" || row.world_status === "failed") return row.world_status;
  return "waiting";
}

export function projectMeetingDecision(row: MeetingDecisionRow, participants: TMeetingParticipant[], canReview: boolean,
  world: DecisionWorldContext = { excluded: false, meetingAnchors: [], showStatus: false }): TMeetingDecisionView {
  const name = (id: string | null) => (id ? participants.find((person) => person.personId === id)?.displayName ?? null : null);
  const effective = decisionEffective(row);
  const anchors = !effective ? [] : row.world_fallback && row.world_status === "committed" ? world.meetingAnchors : sortAnchors(row.targets ?? []);
  return {
    id: row.id, meetingId: row.meeting_id, tier: row.tier, ordinal: row.ordinal,
    statement: decisionStatement(row), originalStatement: row.statement,
    quote: row.quote, speakerName: name(row.speaker_id),
    recommendation: row.recommendation, why: row.why, status: row.status, revision: row.revision,
    reviewerName: name(row.reviewer_id), reviewedAt: iso(row.reviewed_at), dueAt: iso(row.due_at),
    canReview,
    anchors,
    world: effective && world.showStatus ? decisionWorld(row, world.excluded) : null,
  };
}

/** 会议挂点：已写进本体（或已撤回）时是写进去的那些，否则是第一组非空的候选。 */
export function meetingAnchorsOf(row: Pick<MeetingRow, "world_event_status" | "world_event_anchors" | "world_anchor_groups">): TWorldAnchor[] {
  if ((row.world_event_status === "committed" || row.world_event_status === "withdrawn") && row.world_event_anchors?.length) return row.world_event_anchors;
  return (row.world_anchor_groups ?? []).find((group) => group.length) ?? [];
}

export function decisionWorldContext(row: MeetingRow, showStatus: boolean): DecisionWorldContext {
  return { excluded: row.world_excluded, meetingAnchors: meetingAnchorsOf(row), showStatus };
}

/** 这场会在本体里的视图（回流设计稿 3.1）：写入状态只给主持人和 CEO（showStatus）。 */
export function meetingWorldView(row: MeetingRow, viewer: { canEdit: boolean; showStatus: boolean }): TMeetingWorldView {
  return {
    excluded: row.world_excluded,
    excludedBy: row.world_excluded ? row.world_excluded_by : null,
    status: viewer.showStatus ? row.world_event_status : null,
    at: viewer.showStatus && row.world_event_at ? new Date(row.world_event_at).toISOString() : null,
    anchors: meetingAnchorsOf(row),
    edited: row.world_anchors !== null,
    canEdit: viewer.canEdit,
  };
}

/** 妙记状态：已有逐字稿或候选就是 ready，其余按库里记的。 */
export function minutesStatusOf(row: { minutes_status?: TMeetingMinutesStatus | null; transcript: unknown; transcript_candidate: unknown }): TMeetingMinutesStatus {
  if (row.transcript || row.transcript_candidate) return "ready";
  return row.minutes_status ?? "none";
}

/** 实际参会的人：飞书名单优先，拿不到时退回手填的参会人。 */
export function attendeesOf(row: { attendees_actual?: string[] | null; participants: TMeetingParticipant[] }): TMeetingAttendees {
  return row.attendees_actual
    ? { source: "feishu", personIds: row.attendees_actual }
    : { source: "manual", personIds: row.participants.map((person) => person.personId) };
}
