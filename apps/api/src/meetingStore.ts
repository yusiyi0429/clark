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
import type { TMeetingMinutesFailure, TMeetingMinutesStatus } from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import { attendeesOf, minutesManualImport, minutesStatusOf, projectMeetingDecision, type MeetingDecisionRow } from "./meetingDecisionView.js";
import { computeStaleInputs, type GroupInputVersions } from "./preflightStaleness.js";

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
  /** 预审 ready 时现查的群材料版本与讨论游标（随 meetingColumns 带出，用于过期提示）；其他时候为 null。 */
  group_inputs?: GroupInputVersions | null;
  /** 妙记与实际参会名单（086）。 */
  feishu_meeting_id?: string | null;
  minute_token?: string | null;
  minutes_status?: TMeetingMinutesStatus;
  /** 妙记读取失败的原因（200）；不是 failed 时为 null。 */
  minutes_failure?: TMeetingMinutesFailure | null;
  /** 开始等妙记的时刻（086）。 */
  minutes_waiting_since?: Date | null;
  attendees_actual?: string[] | null;
  /** 会后分层确认（meeting_decisions 另表，随 meetingColumns 带出）；`SELECT *` 读出的行没有这一格。 */
  decisions?: MeetingDecisionRow[];
  /** 会议卡已有确认效果（有确认版，或行动项推出过执行事项；随 meetingColumns 带出）：不再给替换逐字稿。`SELECT *` 读出的行没有这一格。 */
  card_confirmed?: boolean;
  /** 会议入本体（200）：建会的人、挂点（确认版本和写入回执在 meeting_card_confirmations / meeting_card_syncs）。 */
  created_by: string | null;
  world_anchors: StoredWorldAnchor[] | null;
};

/** 选过的挂点：Mission、单元存天枢 id；LTO、PO 天枢里没有表，连同选时的标题一起存（本体读不到时照样能显示）。 */
export type StoredWorldAnchor = { kind: "mission" | "unit"; id: string } | { kind: "lto" | "po"; id: string; title: string };

const MEETING_COLUMNS = [
  "id", "version", "title", "status", "scheduled_at", "ends_at", "ended_at", "lead_dri_id", "ceo_participant_id",
  "participants", "issue_ids", "preflight", "draft", "materials", "transcript", "transcript_candidate", "outcome", "origin_ref", "external_id",
  "request_fingerprint", "action_fingerprints", "created_at", "updated_at",
  "feishu_meeting_id", "minute_token", "minutes_status", "minutes_failure", "minutes_waiting_since", "attendees_actual",
  "created_by", "world_anchors",
];
/** 会后分层确认不 bump Meeting version（主持人确认走自己的接口），每次读取现查。 */
const decisionsColumn = (prefix: string) =>
  `(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.tier DESC, d.ordinal), '[]'::jsonb) FROM meeting_decisions d WHERE d.meeting_id = ${prefix || "meetings."}id) AS decisions`;
/** 录音状态变化不 bump Meeting version（否则会让进行中的会议 Action 全部失效），所以每次读取现查最近一条。 */
const latestRecordingColumn = (prefix: string) =>
  `(SELECT jsonb_build_object('id', r.id, 'status', r.status, 'error', r.error) FROM meeting_recordings r WHERE r.meeting_id = ${prefix || "meetings."}id ORDER BY r.created_at DESC LIMIT 1) AS latest_recording`;
/**
 * 预审过期提示（H04）：只在预审 ready 时现查本会议与关联议题当前可见的群材料版本和群讨论游标，不 bump version。
 * 权限与 meetingEvidence.collectMeetingEvidence 一致（viewer = 会议 CEO 参会人）：会议材料可见；议题材料要求 CEO
 * 在群里或议题没有群；讨论只算 CEO 在群的成员消息。
 */
const groupInputsColumn = (prefix: string) => {
  const m = prefix || "meetings.";
  const objectMatch = (alias: string) =>
    `((${alias}.object_type = 'meeting' AND ${alias}.object_id = ${m}id::text) OR (${alias}.object_type = 'issue' AND ${m}issue_ids ? ${alias}.object_id))`;
  const ceoMember = (alias: string) =>
    `EXISTS (SELECT 1 FROM thread_members tm WHERE tm.object_type = ${alias}.object_type AND tm.object_id = ${alias}.object_id AND tm.person_id = ${m}ceo_participant_id AND tm.left_at IS NULL)`;
  const discussions = `FROM thread_messages gm WHERE gm.kind = 'member' AND ${objectMatch("gm")} AND ${ceoMember("gm")}`;
  return `(CASE WHEN ${m}preflight->>'status' = 'ready' THEN jsonb_build_object(
    'materials', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', om.id::text, 'objectType', om.object_type, 'objectId', om.object_id,
        'fileName', om.file_name, 'version', om.current_version) ORDER BY om.created_at, om.id)
      FROM object_materials om WHERE om.deleted_at IS NULL AND ${objectMatch("om")}
        AND (om.object_type = 'meeting' OR ${ceoMember("om")}
          OR NOT EXISTS (SELECT 1 FROM thread_members tx WHERE tx.object_type = 'issue' AND tx.object_id = om.object_id))), '[]'::jsonb),
    'discussionMaxId', (SELECT COALESCE(max(gm.id), 0) ${discussions}),
    'newDiscussionCount', (SELECT count(*) ${discussions} AND gm.id > COALESCE((${m}preflight #>> '{inputCoverage,evidence,discussionMaxId}')::bigint, 0))
  ) END) AS group_inputs`;
};
/** 会议卡确认不 bump Meeting version，每次读取现查。 */
const cardConfirmedColumn = (prefix: string) =>
  `EXISTS (SELECT 1 FROM meeting_cards k WHERE k.meeting_id = ${prefix || "meetings."}id
     AND (k.current_revision IS NOT NULL OR jsonb_path_exists(k.action_items, '$[*] ? (@.taskId != null)'))) AS card_confirmed`;
export const meetingColumns = (prefix = "") => [...MEETING_COLUMNS.map((column) => `${prefix}${column}`), latestRecordingColumn(prefix), groupInputsColumn(prefix), decisionsColumn(prefix),
  cardConfirmedColumn(prefix)].join(", ");

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

/** 预审投影：去掉误存的 staleInputs，ready 时按当前群输入重新计算过期提示。 */
function projectPreflight(row: MeetingRow): TMeetingPreflight {
  const { staleInputs: _stored, ...preflight } = row.preflight;
  if (preflight.status !== "ready" || !row.group_inputs) return preflight;
  const stale = computeStaleInputs(preflight.inputCoverage?.evidence, row.group_inputs);
  return stale ? { ...preflight, staleInputs: stale } : preflight;
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
  const action = (actionType: string, label: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "meeting", objectId: row.id, objectVersion: row.version };
    return { actionId: signActionId(secret, scope), actionType, label };
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
    if (!row.ended_at) actions.push(action("meeting.end", "结束会议"));
    if (row.preflight.status === "failed") actions.push(action("meeting.retry_preflight", "重试预审"));
    if (row.preflight.status === "ready") actions.push(action("meeting.regenerate_preflight", "重新预审"));
  }
  if (row.status === "scheduled" && row.transcript_candidate) {
    actions.push(
      action("meeting.confirm_transcript_candidate", "确认会议记录映射"),
      action("meeting.discard_transcript_candidate", "清除会议记录候选"),
    );
  }
  // Ticket 10：held 后只能显式重试失败的抽取；无 confirmed effect（含会议卡确认过）时才允许危险替换 Transcript（reviewed 同样适用）
  if (row.status === "held" && row.outcome?.status === "failed") actions.push(action("meeting.retry_outcome", "重试会后抽取"));
  if ((row.status === "held" || row.status === "reviewed") && !hasConfirmedEffect(row.outcome) && !row.card_confirmed) {
    actions.push(action("meeting.replace_transcript", "替换 Transcript"));
  }
  // 会后只有会议卡一个入口（FR-5.1、拍板 4）：不再逐条确认、忽略、撤回；旧会议的逐条条目只读。
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
      createdBy: row.created_by,
      ceoParticipantId: row.ceo_participant_id,
      participants: row.participants,
      issueIds: row.issue_ids,
      originRef: row.origin_ref,
      preflight: projectPreflight(row),
      draft: row.draft,
      materials: row.materials.map(projectMaterial),
      transcript: row.transcript,
      transcriptCandidate: projectTranscriptCandidate(row.transcript_candidate),
      outcome: row.outcome,
      recording: row.latest_recording ?? null,
      minutesStatus: minutesStatusOf(row),
      minutesFailure: minutesStatusOf(row) === "failed" ? row.minutes_failure ?? null : null,
      minutesWaitingSince: row.minutes_waiting_since?.toISOString() ?? null,
      minutesManualImport: minutesManualImport(row, at),
      attendees: attendeesOf(row),
      // 旧会议的逐条决定只读。
      decisions: (row.decisions ?? []).map((decision) => projectMeetingDecision(decision, row.participants, false)),
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

/** decision 的关联 Issue：显式 issueId 优先，否则只有单一关联 Issue 时才无歧义。 */
export function decisionIssueId(row: MeetingRow, item: TMeetingOutcomeItem): string | null {
  return item.issueId ?? (row.issue_ids.length === 1 ? row.issue_ids[0] : null);
}
