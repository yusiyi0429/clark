import type { Pool, PoolClient, QueryResult } from "pg";
import type {
  TActionDescriptor,
  TCard,
  TMeetingDraft,
  TMeetingMaterial,
  TMeetingOutcomeItem,
  TMeetingOutcomeState,
  TMeetingParticipant,
  TMeetingPreflight,
  TStoredTranscript,
  TStoredTranscriptCandidate,
  TTranscriptCandidateProjection,
  TMeetingRecordingSummary,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";

export type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type MeetingStatus = "scheduled" | "held" | "reviewed" | "cancelled";

export type StoredMeetingMaterial = TMeetingMaterial & { storageKey: string; sha256: string; extractedText: string };
export type MeetingRow = {
  id: string;
  version: number;
  title: string;
  status: MeetingStatus;
  scheduled_at: Date;
  ends_at: Date;
  /** 「这场会开完了」的时刻；与 status 独立。 */
  ended_at: Date | null;
  lead_dri_id: string;
  ceo_participant_id: string;
  participants: TMeetingParticipant[];
  issue_ids: string[];
  preflight: TMeetingPreflight;
  draft: TMeetingDraft;
  materials: StoredMeetingMaterial[];
  transcript: TStoredTranscript | null;
  transcript_candidate: TStoredTranscriptCandidate | null;
  outcome: TMeetingOutcomeState | null;
  origin_ref: unknown;
  external_id: string | null;
  request_fingerprint: string | null;
  action_fingerprints: string[];
  created_at: Date;
  updated_at: Date;
  /** 最近一次会议录音（meeting_recordings 另表，随 meetingColumns 带出）；`SELECT *` 读出的行没有这一格。 */
  latest_recording?: TMeetingRecordingSummary | null;
};

const MEETING_COLUMNS = [
  "id", "version", "title", "status", "scheduled_at", "ends_at", "ended_at", "lead_dri_id", "ceo_participant_id",
  "participants", "issue_ids", "preflight", "draft", "materials", "transcript", "transcript_candidate", "outcome", "origin_ref", "external_id",
  "request_fingerprint", "action_fingerprints", "created_at", "updated_at",
];
/** 录音状态变化不 bump Meeting version（否则会让进行中的会议 Action 全部失效），所以每次读取现查最近一条。 */
const latestRecordingColumn = (prefix: string) =>
  `(SELECT jsonb_build_object('id', r.id, 'status', r.status, 'error', r.error) FROM meeting_recordings r WHERE r.meeting_id = ${prefix || "meetings."}id ORDER BY r.created_at DESC LIMIT 1) AS latest_recording`;
export const meetingColumns = (prefix = "") => [...MEETING_COLUMNS.map((column) => `${prefix}${column}`), latestRecordingColumn(prefix)].join(", ");

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type MeetingActionError = { status: number; code: string; message: string; fieldErrors?: Record<string, string> };
export type MeetingActionOutcome =
  | { card: TCard; conflict?: false; /** true 表示该 Action 已产生过效果，本次是幂等重放 */ replayed?: boolean }
  | { conflict: true; latestCard: TCard }
  | { error: MeetingActionError };
/** DRI 出站请求：Supplement Request 与 MonthlyPlan todo 共用同一导出边界（会后 todo 改为推送执行事项）。 */
export type DriExportRequest = {
  effectRef: string;
  targetDriId: string;
  text: string;
};

/** DRI 的真实外发渠道；未配置时 Handoff 只能停在 pending_export。 */
export type DriExporter = {
  export(request: DriExportRequest, signal: AbortSignal): Promise<{ exportRef: string }>;
};
export function emptyPreflight(now = new Date()): TMeetingPreflight {
  return { status: "pending", pendingSince: now.toISOString(), runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null };
}

export function emptyDraft(): TMeetingDraft {
  return { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" };
}

function projectMaterial(material: StoredMeetingMaterial): TMeetingMaterial {
  const { storageKey: _storageKey, sha256: _sha256, extractedText: _extractedText, ...projected } = material;
  return projected;
}

export function resetPreflightDraft(draft: TMeetingDraft): TMeetingDraft {
  return { ...draft, checkedEntryIds: [], editsByEntryId: {} };
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}
export async function getMeetingRow(q: Query, id: string): Promise<MeetingRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const result = await q(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1`, [id]);
  return result.rowCount === 1 ? result.rows[0] as MeetingRow : null;
}

export async function listMeetingRows(q: Query): Promise<MeetingRow[]> {
  const result = await q(`SELECT ${meetingColumns()} FROM meetings ORDER BY scheduled_at DESC, created_at DESC`);
  return result.rows as MeetingRow[];
}
function parentConfirmed(outcome: TMeetingOutcomeState, item: TMeetingOutcomeItem): boolean {
  const parent = item.parentItemId ? outcome.items.find((candidate) => candidate.id === item.parentItemId) : undefined;
  return parent?.review?.status === "confirmed";
}

/** 候选只向 Card 投影摘要与抽样；完整 turns 留在服务端 JSONB。 */
export function projectTranscriptCandidate(candidate: TStoredTranscriptCandidate | null): TTranscriptCandidateProjection | null {
  if (!candidate || candidate.turns.length === 0) return null;
  const first = candidate.turns[0].offsetSeconds;
  const last = candidate.turns[candidate.turns.length - 1].offsetSeconds;
  return {
    source: candidate.source,
    createdAt: candidate.createdAt,
    turnCount: candidate.turns.length,
    speakerCount: candidate.speakers.length,
    durationSeconds: last - first,
    firstOffsetSeconds: first,
    lastOffsetSeconds: last,
    speakers: candidate.speakers,
    sampleTurns: candidate.turns.slice(0, 8),
    warnings: candidate.warnings,
  };
}

export function meetingHasEnded(row: Pick<MeetingRow, "ended_at" | "ends_at">, at = new Date()): boolean {
  return row.ended_at !== null || row.ends_at.getTime() <= at.getTime();
}

export function hasMeetingNotice(row: MeetingRow, viewerId: string, at: Date): boolean {
  return row.status === "scheduled" && (!meetingHasEnded(row, at) || row.lead_dri_id === viewerId);
}

export function projectMeetingCard(row: MeetingRow, secret: string, at = new Date()): TCard {
  const action = (actionType: string, label: string, itemId?: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "meeting", objectId: row.id, objectVersion: row.version, itemId };
    return { actionId: signActionId(secret, scope), actionType, label, ...(itemId ? { itemId } : {}) };
  };
  const actions: TActionDescriptor[] = [];
  if (row.status === "scheduled") {
    if (row.preflight.status === "ready") actions.push(action("meeting.edit_materials", "返回编辑材料"));
    if (row.preflight.status === "pending") actions.push(action("meeting.run_preflight", "运行预审"));
    actions.push(
      action("meeting.edit_details", "编辑会议"),
      action("meeting.update_draft", "保存准备状态"),
      action("meeting.request_supplement", "请求补充材料"),
      action("meeting.cancel", "取消会议"),
    );
    if (!row.transcript_candidate) actions.push(action("meeting.reschedule", "重新安排会议"));
    // 「这场会开完了」只记一次结束时刻，不改 status
    if (!row.ended_at) actions.push(action("meeting.end", "这场会开完了"));
    if (row.preflight.status === "failed") actions.push(action("meeting.retry_preflight", "重试预审"));
    if (row.preflight.status === "ready") actions.push(action("meeting.regenerate_preflight", "重新预审"));
  }
  if (row.status === "scheduled" && row.transcript_candidate) {
    actions.push(
      action("meeting.confirm_transcript_candidate", "确认会议记录映射"),
      action("meeting.discard_transcript_candidate", "清除会议记录候选"),
    );
  }
  // Ticket 10：held 后只能显式重试失败的抽取；无 confirmed effect 时才允许危险替换 Transcript（reviewed 同样适用）
  if (row.status === "held" && row.outcome?.status === "failed") actions.push(action("meeting.retry_outcome", "重试会后抽取"));
  if ((row.status === "held" || row.status === "reviewed") && !hasConfirmedEffect(row.outcome)) {
    actions.push(action("meeting.replace_transcript", "替换 Transcript"));
  }
  // Ticket 11：逐项确认/忽略/撤回；open item 与已 delivered 的外部效果不提供撤回
  if ((row.status === "held" || row.status === "reviewed") && row.outcome?.status === "ready") {
    for (const item of row.outcome.items) {
      if (!item.review) continue;
      if (item.review.status === "pending") {
        // 无法产生精确效果时不暴露确认：父 decision 未确认的 reopenWhen、无可解析 Issue 的 decision
        const confirmable =
          (item.kind !== "reopenWhen" || parentConfirmed(row.outcome, item)) &&
          (item.kind !== "decision" || decisionIssueId(row, item) !== null);
        if (confirmable) actions.push(action("meeting.confirm_item", "确认", item.id));
        actions.push(action("meeting.dismiss_item", item.kind === "strategic" ? "不同意" : "忽略", item.id));
      } else if (item.review.status === "confirmed" && item.kind !== "strategic") {
        // 战略项确认后已交给本体更新，不提供撤回；已推送 todo 的撤回由服务端按执行事项状态判定
        actions.push(action("meeting.revoke_effect", "撤回", item.id));
      }
    }
  }
  return {
    schemaVersion: 1,
    id: `meeting:${row.id}`,
    version: row.version,
    kind: "meeting",
    objectRef: { type: "meeting", id: row.id, version: row.version },
    title: row.title,
    badge: "Meeting",
    urgency: "normal",
    payload: {
      status: row.status,
      scheduledAt: row.scheduled_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      hasEnded: meetingHasEnded(row, at),
      leadDriId: row.lead_dri_id,
      ceoParticipantId: row.ceo_participant_id,
      participants: row.participants,
      issueIds: row.issue_ids,
      originRef: row.origin_ref,
      preflight: row.preflight,
      draft: row.draft,
      materials: row.materials.map(projectMaterial),
      transcript: row.transcript,
      transcriptCandidate: projectTranscriptCandidate(row.transcript_candidate),
      outcome: row.outcome,
      recording: row.latest_recording ?? null,
    },
    navigation: [{ href: `/meetings/${row.id}`, label: "Meeting" }],
    conversation: { scope: `meeting:${row.id}` },
    actions,
  };
}
export function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}

/**
 * Action 执行通用事务：行锁 → 已产生效果直接返回当前 Card → 命中 expectedVersion 才继续。
 * `expectedVersion` 为 undefined 时是增量操作（加入 Issue），不校验 Meeting version。
 */
export async function withMeetingLock(
  pool: Pool,
  meetingId: string,
  secret: string,
  fingerprint: string,
  expectedVersion: number | undefined,
  run: (client: PoolClient, row: MeetingRow) => Promise<MeetingActionOutcome>,
  hostId?: string,
): Promise<MeetingActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
    }
    const row = result.rows[0];
    if (hostId !== undefined && row.lead_dri_id !== hostId) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
    }
    if (row.action_fingerprints.includes(fingerprint)) {
      await client.query("COMMIT");
      return { card: projectMeetingCard(row, secret), replayed: true };
    }
    if (expectedVersion !== undefined && row.version !== expectedVersion) {
      await client.query("ROLLBACK");
      return { conflict: true, latestCard: projectMeetingCard(row, secret) };
    }
    const outcome = await run(client, row);
    // 拒绝与冲突路径同样必须结束事务，否则行锁随连接泄漏回池
    if (!("card" in outcome)) {
      await client.query("ROLLBACK").catch(() => undefined);
      return outcome;
    }
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function commit(client: PoolClient, row: MeetingRow, secret: string): Promise<{ card: TCard }> {
  await client.query("COMMIT");
  return { card: projectMeetingCard(row, secret) };
}

export async function updateMeeting(client: PoolClient, id: string, assignments: string, params: unknown[]): Promise<MeetingRow> {
  const result = await client.query<MeetingRow>(
    `UPDATE meetings SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING ${meetingColumns()}`,
    [id, ...params],
  );
  return result.rows[0];
}

/** 只有 confirmed 的 item 才能真正阻止替换；pending/dismissed 不算已生效效果。 */
export function hasConfirmedEffect(outcome: TMeetingOutcomeState | null): boolean {
  return outcome?.items.some((item) => item.review?.status === "confirmed" || item.review?.effectRef != null) ?? false;
}

/** CEO 通知栏「需要你确认」：抽取已完成且还有未处理的战略议题。 */
export function hasPendingStrategicItem(outcome: TMeetingOutcomeState | null): boolean {
  return outcome?.status === "ready" && outcome.items.some((item) => item.kind === "strategic" && item.review?.status === "pending");
}

/** decision 的关联 Issue：显式 issueId 优先，否则只有单一关联 Issue 时才无歧义。 */
export function decisionIssueId(row: MeetingRow, item: TMeetingOutcomeItem): string | null {
  return item.issueId ?? (row.issue_ids.length === 1 ? row.issue_ids[0] : null);
}
