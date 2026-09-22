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
  lead_dri_id: string;
  ceo_participant_id: string;
  participants: TMeetingParticipant[];
  issue_ids: string[];
  preflight: TMeetingPreflight;
  draft: TMeetingDraft;
  materials: StoredMeetingMaterial[];
  transcript: TStoredTranscript | null;
  outcome: TMeetingOutcomeState | null;
  origin_ref: unknown;
  external_id: string | null;
  request_fingerprint: string | null;
  action_fingerprints: string[];
  created_at: Date;
  updated_at: Date;
};

const MEETING_COLUMNS = [
  "id", "version", "title", "status", "scheduled_at", "lead_dri_id", "ceo_participant_id",
  "participants", "issue_ids", "preflight", "draft", "materials", "transcript", "outcome", "origin_ref", "external_id",
  "request_fingerprint", "action_fingerprints", "created_at", "updated_at",
];
export const meetingColumns = (prefix = "") => MEETING_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type MeetingActionError = { status: number; code: string; message: string; fieldErrors?: Record<string, string> };
export type MeetingActionOutcome =
  | { card: TCard; conflict?: false; /** true 表示该 Action 已产生过效果，本次是幂等重放 */ replayed?: boolean }
  | { conflict: true; latestCard: TCard }
  | { error: MeetingActionError };
/** DRI 出站请求：Supplement Request、MeetingOutcome todo 与 MonthlyPlan todo 共用同一导出边界。 */
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

export function projectMeetingCard(row: MeetingRow, secret: string): TCard {
  const action = (actionType: string, label: string, itemId?: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "meeting", objectId: row.id, objectVersion: row.version, itemId };
    return { actionId: signActionId(secret, scope), actionType, label, ...(itemId ? { itemId } : {}) };
  };
  const actions: TActionDescriptor[] = [];
  if (row.status === "scheduled") {
    if (row.preflight.status === "ready") actions.push(action("meeting.edit_materials", "返回编辑材料"));
    if (row.preflight.status === "pending") actions.push(action("meeting.run_preflight", "运行预审"));
    actions.push(
      action("meeting.update_draft", "保存准备状态"),
      action("meeting.request_supplement", "请求补充材料"),
      action("meeting.cancel", "取消会议"),
    );
    if (row.preflight.status === "failed") actions.push(action("meeting.retry_preflight", "重试预审"));
    if (row.preflight.status === "ready") actions.push(action("meeting.regenerate_preflight", "重新预审"));
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
        actions.push(action("meeting.dismiss_item", "忽略", item.id));
      } else if (item.review.status === "confirmed") {
        const deliveredTodo = item.kind === "todo" && item.review.handoff?.exportStatus === "delivered";
        if (!deliveredTodo) actions.push(action("meeting.revoke_effect", "撤回", item.id));
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
      leadDriId: row.lead_dri_id,
      ceoParticipantId: row.ceo_participant_id,
      participants: row.participants,
      issueIds: row.issue_ids,
      originRef: row.origin_ref,
      preflight: row.preflight,
      draft: row.draft,
      materials: row.materials.map(projectMaterial),
      transcript: row.transcript,
      outcome: row.outcome,
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
