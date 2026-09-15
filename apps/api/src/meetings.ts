import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PreflightCandidate,
  type TActionDescriptor,
  type TCard,
  type TMeetingDraft,
  type TMeetingParticipant,
  type TMeetingPreflight,
  type TMeetingPreflightEntry,
  type TSupplementRequest,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import { getIssueRow, projectIssueCard } from "./issues.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

type MeetingStatus = "scheduled" | "held" | "reviewed" | "cancelled";

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
  origin_ref: unknown;
  external_id: string | null;
  request_fingerprint: string | null;
  action_fingerprints: string[];
  created_at: Date;
  updated_at: Date;
};

const MEETING_COLUMNS = [
  "id", "version", "title", "status", "scheduled_at", "lead_dri_id", "ceo_participant_id",
  "participants", "issue_ids", "preflight", "draft", "origin_ref", "external_id",
  "request_fingerprint", "action_fingerprints", "created_at", "updated_at",
];
const meetingColumns = (prefix = "") => MEETING_COLUMNS.map((column) => `${prefix}${column}`).join(", ");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREFLIGHT_AGENT_FAILED = "preflight_agent_failed";
const INVALID_PREFLIGHT_CANDIDATE = "invalid_preflight_candidate";
const INVALID_SOURCE_REF = "invalid_source_ref";
export const PREFLIGHT_INTERRUPTED = "preflight_interrupted";
/** 与 Chat 单 turn 相同的超时保护；预审在请求路径内同步运行。 */
const PREFLIGHT_TIMEOUT_MS = 180_000;

export type MeetingActionError = { status: number; code: string; message: string; fieldErrors?: Record<string, string> };
export type MeetingActionOutcome =
  | { card: TCard; conflict?: false; /** true 表示该 Action 已产生过效果，本次是幂等重放 */ replayed?: boolean }
  | { conflict: true; latestCard: TCard }
  | { error: MeetingActionError };

/** 会前预审 Agent 的只读输入：关联 Issue、ResearchDoc 与 CompanyMemory 相关段落。 */
export type PreflightAgentInput = {
  meeting: { id: string; title: string; scheduledAt: string; participants: TMeetingParticipant[] };
  issues: { id: string; title: string; location: unknown; urgency: unknown; research: unknown }[];
  memory: { sectionId: string; title: string; sourceRef: string; passages: { id: string; text: string; sourceRef: string }[] }[];
};

export type PreflightAgent = {
  promptHash?: string;
  modelSlot?: "light" | "heavy";
  generate(input: PreflightAgentInput, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};

/** DRI 补充请求的真实外发渠道；未配置时 Supplement Request 只能停在 pending_export。 */
export type DriExporter = {
  export(request: TSupplementRequest, signal: AbortSignal): Promise<{ exportRef: string }>;
};

function emptyPreflight(now = new Date()): TMeetingPreflight {
  return { status: "pending", pendingSince: now.toISOString(), runId: null, entries: [], basis: "", brief: "", error: null, generatedAt: null };
}

function emptyDraft(): TMeetingDraft {
  return { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" };
}

function unique(values: string[]): string[] {
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

export function projectMeetingCard(row: MeetingRow, secret: string): TCard {
  const action = (actionType: string, label: string): TActionDescriptor => {
    const scope: ActionScope = { actionType, objectType: "meeting", objectId: row.id, objectVersion: row.version };
    return { actionId: signActionId(secret, scope), actionType, label };
  };
  const actions: TActionDescriptor[] = [];
  if (row.status === "scheduled") {
    actions.push(
      action("meeting.update_draft", "保存准备状态"),
      action("meeting.request_supplement", "请求补充材料"),
      action("meeting.cancel", "取消会议"),
    );
    if (row.preflight.status === "failed") actions.push(action("meeting.retry_preflight", "重试预审"));
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
    },
    navigation: [{ href: `/meetings/${row.id}`, label: "Meeting" }],
    conversation: { scope: `meeting:${row.id}` },
    actions,
  };
}

function resolveParticipants(
  companyMemory: CompanyMemoryRepository,
  input: { leadDriId: string; ceoParticipantId: string; participants: string[] },
): { participants: TMeetingParticipant[]; ceo: TMeetingParticipant; lead: TMeetingParticipant } | { error: MeetingActionError } {
  const byId = new Map(companyMemory.searchPeople(undefined).map((person) => [person.personId, person]));
  const ids = unique([input.ceoParticipantId, input.leadDriId, ...input.participants]);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { error: { status: 400, code: "INVALID_PARTICIPANT", message: `participant 不在 company-people.v1 人员目录中: ${missing.join(", ")}`, fieldErrors: { participants: "unknown personId" } } };
  }
  const ceo = byId.get(input.ceoParticipantId)!;
  if (!ceo.roles.includes("ceo")) {
    return { error: { status: 400, code: "INVALID_CEO", message: "ceoParticipantId 必须具有 ceo 角色", fieldErrors: { ceoParticipantId: "role ceo required" } } };
  }
  const lead = byId.get(input.leadDriId)!;
  if (!lead.roles.includes("dri")) {
    return { error: { status: 400, code: "INVALID_LEAD_DRI", message: "leadDriId 必须具有 dri 角色", fieldErrors: { leadDriId: "role dri required" } } };
  }
  const participants = ids.map((id) => {
    const person = byId.get(id)!;
    return { personId: person.personId, displayName: person.displayName, roles: [...person.roles], sourceRef: person.sourceRef, updatedAt: person.updatedAt };
  });
  return {
    participants,
    ceo: participants.find((participant) => participant.personId === ceo.personId)!,
    lead: participants.find((participant) => participant.personId === lead.personId)!,
  };
}

async function issuesExist(q: Query, issueIds: string[]): Promise<boolean> {
  if (issueIds.some((id) => !UUID_PATTERN.test(id))) return false;
  const result = await q("SELECT count(*)::int AS count FROM issues WHERE id = ANY($1::uuid[])", [issueIds]);
  return Number((result.rows[0] as { count: number }).count) === unique(issueIds).length;
}

function parseScheduledAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// ponytail: 幂等指纹列表随操作增长，超过上限丢弃最旧项；MVP 单会议操作量有限
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}

/**
 * Action 执行通用事务：行锁 → 已产生效果直接返回当前 Card → 命中 expectedVersion 才继续。
 * `expectedVersion` 为 undefined 时是增量操作（加入 Issue），不校验 Meeting version。
 */
async function withMeetingLock(
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

async function commit(client: PoolClient, row: MeetingRow, secret: string): Promise<{ card: TCard }> {
  await client.query("COMMIT");
  return { card: projectMeetingCard(row, secret) };
}

async function updateMeeting(client: PoolClient, id: string, assignments: string, params: unknown[]): Promise<MeetingRow> {
  const result = await client.query<MeetingRow>(
    `UPDATE meetings SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING ${meetingColumns()}`,
    [id, ...params],
  );
  return result.rows[0];
}

function validateDraft(draft: TMeetingDraft, row: MeetingRow): MeetingActionError | null {
  const issues = new Set(row.issue_ids);
  if ([...draft.readIssueIds, ...draft.carriedIssueIds].some((id) => !issues.has(id))) {
    return { status: 400, code: "INVALID_DRAFT", message: "准备状态引用了不属于该 Meeting 的 Issue", fieldErrors: { readIssueIds: "unknown issue" } };
  }
  const entries = new Set(row.preflight.entries.map((entry) => entry.id));
  if ([...draft.checkedEntryIds, ...Object.keys(draft.editsByEntryId)].some((id) => !entries.has(id))) {
    return { status: 400, code: "INVALID_DRAFT", message: "准备状态引用了不存在的 Preflight entry", fieldErrors: { checkedEntryIds: "unknown entry" } };
  }
  return null;
}

export async function executeCreateMeeting(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  input: { title: string; scheduledAt: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[] },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  if (scope.objectType !== "issue") return { error: { status: 404, code: "UNKNOWN_ACTION", message: "无效 actionId" } };
  const issue = await getIssueRow(pool.query.bind(pool), scope.objectId);
  if (!issue) return { error: { status: 404, code: "ISSUE_NOT_FOUND", message: "Issue 不存在" } };
  if (issue.status === "dismissed") return { error: { status: 409, code: "ISSUE_NOT_MEETING_READY", message: "dismissed Issue 不能创建 Meeting" } };
  const scheduledAt = parseScheduledAt(input.scheduledAt);
  if (!scheduledAt) return { error: { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } } };
  const resolved = resolveParticipants(companyMemory, input);
  if ("error" in resolved) return { error: resolved.error };
  const issueIds = unique([scope.objectId, ...input.issueIds]);
  if (!(await issuesExist(pool.query.bind(pool), issueIds))) {
    return { error: { status: 400, code: "INVALID_ISSUE", message: "issueIds 包含不存在的 Issue", fieldErrors: { issueIds: "unknown issue" } } };
  }

  const client = await pool.connect();
  const meetingId = randomUUID();
  let created: MeetingRow;
  let isNew = false;
  try {
    await client.query("BEGIN");
    // 同一 Issue 的重复 Action 串行化，避免双击/重试创建第二个 Meeting
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`meeting:create:${scope.objectId}`]);
    const existing = await client.query<MeetingRow>(
      `SELECT ${meetingColumns()} FROM meetings WHERE origin_ref->>'issueId' = $1 AND action_fingerprints ? $2 LIMIT 1`,
      [scope.objectId, fingerprint],
    );
    if (existing.rowCount === 1) {
      // 幂等优先：同一 Action 已产生 Meeting 时直接返回，未命中才校验 Issue version
      created = existing.rows[0];
    } else {
      if (issue.version !== scope.objectVersion) {
        await client.query("ROLLBACK");
        return { conflict: true, latestCard: projectIssueCard(issue, secret) };
      }
      const inserted = await client.query<MeetingRow>(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, origin_ref, action_fingerprints)
         VALUES ($1, 1, $2, 'scheduled', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
         RETURNING ${meetingColumns()}`,
        [
          meetingId,
          input.title,
          scheduledAt,
          resolved.lead.personId,
          resolved.ceo.personId,
          JSON.stringify(resolved.participants),
          JSON.stringify(issueIds),
          JSON.stringify(emptyPreflight()),
          JSON.stringify(emptyDraft()),
          JSON.stringify({ type: "issue", issueId: scope.objectId }),
          JSON.stringify([fingerprint]),
        ],
      );
      created = inserted.rows[0];
      isNew = true;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (isNew) await runPreflight(pool, companyMemory, preflightAgent, created.id);
  const row = await getMeetingRow(pool.query.bind(pool), created.id);
  return { card: projectMeetingCard(row ?? created, secret) };
}

export async function executeJoinMeeting(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  input: { meetingId: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  if (scope.objectType !== "issue") return { error: { status: 404, code: "UNKNOWN_ACTION", message: "无效 actionId" } };
  const issue = await getIssueRow(pool.query.bind(pool), scope.objectId);
  if (!issue) return { error: { status: 404, code: "ISSUE_NOT_FOUND", message: "Issue 不存在" } };
  if (issue.status === "dismissed") return { error: { status: 409, code: "ISSUE_NOT_MEETING_READY", message: "dismissed Issue 不能加入 Meeting" } };
  if (!(await getMeetingRow(pool.query.bind(pool), input.meetingId))) return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
  const outcome = await withMeetingLock(pool, input.meetingId, secret, fingerprint, undefined, async (client, row) => {
    // 幂等已在行锁内先行；未命中才校验 Issue version 与状态
    if (issue.version !== scope.objectVersion) return { conflict: true, latestCard: projectIssueCard(issue, secret) };
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_JOINABLE", message: "只有 scheduled Meeting 可以加入" } };
    if (row.issue_ids.includes(scope.objectId)) return { ...(await commit(client, row, secret)), replayed: true };
    const updated = await updateMeeting(
      client,
      row.id,
      "issue_ids = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify([...row.issue_ids, scope.objectId]), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  // 关联 Issue 变化后会前材料随之重建；重放/无变化不重跑
  if (!("error" in outcome) && !outcome.conflict && !outcome.replayed) {
    await runPreflight(pool, companyMemory, preflightAgent, input.meetingId);
    return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), input.meetingId))!, secret) };
  }
  return outcome;
}

export async function executeUpdateDraft(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  input: { readIssueIds?: string[]; carriedIssueIds?: string[]; checkedEntryIds?: string[]; editsByEntryId?: Record<string, string>; note?: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以准备" } };
    const draft: TMeetingDraft = { ...row.draft, editsByEntryId: { ...row.draft.editsByEntryId } };
    if (input.readIssueIds) draft.readIssueIds = unique(input.readIssueIds);
    if (input.carriedIssueIds) draft.carriedIssueIds = unique(input.carriedIssueIds);
    if (input.checkedEntryIds) draft.checkedEntryIds = unique(input.checkedEntryIds);
    if (input.editsByEntryId) draft.editsByEntryId = { ...draft.editsByEntryId, ...input.editsByEntryId };
    if (input.note !== undefined) draft.note = input.note;
    // 已核对条目内容被编辑时自动取消核对，避免旧确认覆盖新表述。
    if (input.editsByEntryId) {
      const edited = new Set(Object.keys(input.editsByEntryId));
      draft.checkedEntryIds = draft.checkedEntryIds.filter((id) => !edited.has(id));
    }
    const invalid = validateDraft(draft, row);
    if (invalid) return { error: invalid };
    const updated = await updateMeeting(
      client,
      row.id,
      "draft = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify(draft), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}

export async function executeRequestSupplement(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  exporter: DriExporter | undefined,
  secret: string,
  scope: ActionScope,
  input: { entryId?: string; targetDriId: string; text: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const target = companyMemory.searchPeople(undefined).find((person) => person.personId === input.targetDriId);
  if (!target) return { error: { status: 400, code: "INVALID_PARTICIPANT", message: "targetDriId 不在 company-people.v1 人员目录中", fieldErrors: { targetDriId: "unknown personId" } } };
  if (!target.roles.includes("dri")) return { error: { status: 400, code: "INVALID_TARGET_DRI", message: "targetDriId 必须具有 dri 角色", fieldErrors: { targetDriId: "role dri required" } } };

  const requestId = randomUUID();
  const createdAt = new Date().toISOString();
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以请求补充材料" } };
    if (input.entryId && !row.preflight.entries.some((entry) => entry.id === input.entryId)) {
      return { error: { status: 400, code: "INVALID_DRAFT", message: "entryId 不存在", fieldErrors: { entryId: "unknown entry" } } };
    }
    const request: TSupplementRequest = {
      id: requestId,
      entryId: input.entryId ?? null,
      targetDriId: target.personId,
      text: input.text,
      // 先记录；真实外发结果稍后回写，没有渠道时只能停在 pending_export。
      exportStatus: "recorded",
      exportRef: null,
      error: null,
      createdAt,
    };
    const draft: TMeetingDraft = { ...row.draft, supplementRequests: [...row.draft.supplementRequests, request] };
    const updated = await updateMeeting(
      client,
      row.id,
      "draft = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify(draft), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;

  // 只有首次请求会走到这里：记录后立即尝试真实外发，失败不回滚已保存的请求。
  await updateSupplementStatus(pool, scope.objectId, requestId, "pending_export", null, null);
  if (exporter) {
    const request: TSupplementRequest = {
      id: requestId, entryId: input.entryId ?? null, targetDriId: target.personId, text: input.text,
      exportStatus: "pending_export", exportRef: null, error: null, createdAt,
    };
    try {
      const result = await exporter.export(request, new AbortController().signal);
      await updateSupplementStatus(pool, scope.objectId, requestId, "delivered", result.exportRef, null);
    } catch (err) {
      await updateSupplementStatus(pool, scope.objectId, requestId, "failed", null, (err as Error).message || "export failed");
    }
  }
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/** 外发状态回写与其它 draft 写入一样持行锁，避免整份 draft 被并发覆盖。 */
async function updateSupplementStatus(
  pool: Pool,
  meetingId: string,
  requestId: string,
  status: TSupplementRequest["exportStatus"],
  exportRef: string | null,
  error: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    await client.query(
      `UPDATE meetings
          SET draft = jsonb_set(
                draft,
                '{supplementRequests}',
                (
                  SELECT jsonb_agg(
                    CASE WHEN item->>'id' = $2
                      THEN item || jsonb_build_object('exportStatus', $3::text, 'exportRef', $4::jsonb, 'error', $5::jsonb)
                      ELSE item
                    END
                  )
                  FROM jsonb_array_elements(draft->'supplementRequests') AS item
                )
              ),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND draft->'supplementRequests' @> jsonb_build_array(jsonb_build_object('id', $2::text))`,
      [meetingId, requestId, status, JSON.stringify(exportRef), JSON.stringify(error)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function executeCancelMeeting(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_CANCELLABLE", message: "只有 scheduled Meeting 可以取消" } };
    const updated = await updateMeeting(
      client,
      row.id,
      "status = 'cancelled', version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}

export async function executeRetryPreflight(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以重试预审" } };
    if (row.preflight.status !== "failed") return { error: { status: 409, code: "MEETING_PREFLIGHT_NOT_FAILED", message: "只有失败的预审可以显式重试" } };
    const updated = await updateMeeting(
      client,
      row.id,
      "version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await runPreflight(pool, companyMemory, preflightAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

type IssueSnapshotRow = { id: string; title: string; location: unknown; urgency: unknown; research: unknown };

/** 运行一次会前预审：严格候选校验失败可见，Agent 失败不自动重试。 */
export async function runPreflight(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  meetingId: string,
  { timeoutMs = PREFLIGHT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const q = pool.query.bind(pool);
  const meeting = await getMeetingRow(q, meetingId);
  if (!meeting || meeting.status !== "scheduled") return;
  const running: TMeetingPreflight = { ...meeting.preflight, status: "running", pendingSince: new Date().toISOString(), error: null };
  await q("UPDATE meetings SET preflight = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1", [meetingId, JSON.stringify(running)]);

  // 失败保留 last-good entries 供页面展示，但旧条目即将被重建，核对与编辑一并失效
  const fail = (code: string, message: string) =>
    q(
      `UPDATE meetings
          SET preflight = $2::jsonb,
              draft = jsonb_set(jsonb_set(draft, '{checkedEntryIds}', '[]'::jsonb), '{editsByEntryId}', '{}'::jsonb),
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [meetingId, JSON.stringify({ ...running, status: "failed", error: { code, message, at: new Date().toISOString() } })],
    );

  try {
    const issueResult = await q("SELECT id, title, location, urgency, research FROM issues WHERE id = ANY($1::uuid[])", [meeting.issue_ids]);
    const issues = issueResult.rows as IssueSnapshotRow[];
    const memory: PreflightAgentInput["memory"] = [];
    const allowedSourceRefs = new Set<string>(issues.map((issue) => `issue:${issue.id}`));
    for (const issue of issues) {
      if (issue.research && (issue.research as { doc?: unknown }).doc) allowedSourceRefs.add(`research:${issue.id}`);
      for (const match of companyMemory.searchSections(issue.title, 3)) {
        if (memory.some((section) => section.sectionId === match.id)) continue;
        const passages = companyMemory.getPassages(match.id, undefined, 3);
        memory.push({
          sectionId: match.id,
          title: match.title,
          sourceRef: match.sourceRef,
          passages: passages.passages.map((passage) => ({ id: passage.id, text: passage.text, sourceRef: passage.sourceRef })),
        });
        allowedSourceRefs.add(`memory:${match.id}`);
      }
    }

    const input: PreflightAgentInput = {
      meeting: { id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduled_at.toISOString(), participants: meeting.participants },
      issues: issues.map((issue) => ({ id: issue.id, title: issue.title, location: issue.location, urgency: issue.urgency, research: issue.research })),
      memory,
    };
    // 与 Chat 单 turn 相同的超时保护；悬挂的模型不阻塞请求
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`Preflight exceeded ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    let generated: { candidate: unknown; runId?: string };
    try {
      generated = await preflightAgent.generate(input, abort.signal);
    } finally {
      clearTimeout(timer);
    }
    if (!Value.Check(PreflightCandidate, generated.candidate)) {
      await fail(INVALID_PREFLIGHT_CANDIDATE, "Preflight candidate 不符合严格 schema");
      return;
    }
    for (const entry of generated.candidate.entries) {
      const bad = entry.sourceRefs.find((ref) => !allowedSourceRefs.has(ref));
      if (bad) {
        await fail(INVALID_SOURCE_REF, `Preflight sourceRef 不在允许来源内: ${bad}`);
        return;
      }
    }
    const entries: TMeetingPreflightEntry[] = generated.candidate.entries.map((entry, index) => ({
      id: `entry-${index + 1}`,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      sourceRefs: [...entry.sourceRefs],
    }));
    // entries 整体重建：指向旧表述的核对与编辑一并失效，read/carried/note 保留
    await q(
      `UPDATE meetings
          SET preflight = $2::jsonb,
              draft = jsonb_set(jsonb_set(draft, '{checkedEntryIds}', '[]'::jsonb), '{editsByEntryId}', '{}'::jsonb),
              version = version + 1,
              updated_at = now()
        WHERE id = $1`,
      [meetingId, JSON.stringify({
        status: "ready",
        pendingSince: running.pendingSince,
        runId: generated.runId ?? randomUUID(),
        entries,
        basis: generated.candidate.basis,
        brief: generated.candidate.brief,
        error: null,
        generatedAt: new Date().toISOString(),
      })],
    );
  } catch (err) {
    await fail(PREFLIGHT_AGENT_FAILED, (err as Error).message || "Preflight Agent 失败");
  }
}

/** 启动恢复：进程崩溃留下的 pending/running 预审标为可见失败，等待显式重试。 */
export async function recoverInterruptedPreflight(
  q: Query,
  { now = () => new Date(), staleAfterMs = 15 * 60 * 1000 }: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<number> {
  const result = await q(
    `UPDATE meetings
        SET preflight = jsonb_set(
              jsonb_set(preflight, '{status}', '"failed"'),
              '{error}',
              jsonb_build_object('code', $2::text, 'message', '预审在进程重启前未完成，请显式重试', 'at', now())
            ),
            version = version + 1,
            updated_at = now()
      WHERE status = 'scheduled'
        AND preflight->>'status' IN ('pending', 'running')
        AND (preflight->>'pendingSince')::timestamptz < $1::timestamptz`,
    [new Date(now().getTime() - staleAfterMs), PREFLIGHT_INTERRUPTED],
  );
  return result.rowCount ?? 0;
}

export type DriMeetingImportResult =
  | { status: 201 | 200; card: TCard }
  | { status: 400 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

function meetingRequestFingerprint(body: {
  externalId: string; title: string; scheduledAt: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    externalId: body.externalId,
    title: body.title,
    scheduledAt: body.scheduledAt,
    leadDriId: body.leadDriId,
    ceoParticipantId: body.ceoParticipantId,
    // 人员与 Issue 顺序不影响内容：排序去重后参与 fingerprint
    participants: unique(body.participants).sort(),
    issueIds: unique(body.issueIds).sort(),
  })).digest("hex");
}

/** DRI 服务导入 Meeting 元数据：稳定 Person 目录 + 已存在 Issue，重复导入返回原对象。 */
export async function importDriMeeting(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  body: {
    externalId: string; title: string; scheduledAt: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[];
  },
): Promise<DriMeetingImportResult> {
  const scheduledAt = parseScheduledAt(body.scheduledAt);
  if (!scheduledAt) return { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } };
  const resolved = resolveParticipants(companyMemory, body);
  if ("error" in resolved) return { status: 400, code: resolved.error.code, message: resolved.error.message, fieldErrors: resolved.error.fieldErrors };
  const issueIds = unique(body.issueIds);
  if (!(await issuesExist(pool.query.bind(pool), issueIds))) {
    return { status: 400, code: "INVALID_ISSUE", message: "issueIds 包含不存在的 Issue", fieldErrors: { issueIds: "unknown issue" } };
  }
  const requestFingerprint = meetingRequestFingerprint(body);
  const client = await pool.connect();
  let meetingId: string;
  let existing: MeetingRow | null = null;
  try {
    await client.query("BEGIN");
    const found = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE external_id = $1`, [body.externalId]);
    if (found.rowCount === 1) {
      existing = found.rows[0];
      await client.query("COMMIT");
      meetingId = existing.id;
    } else {
      const inserted = await client.query<MeetingRow>(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, origin_ref, external_id, request_fingerprint)
         VALUES ($1, 1, $2, 'scheduled', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING ${meetingColumns()}`,
        [
          randomUUID(),
          body.title,
          scheduledAt,
          resolved.lead.personId,
          resolved.ceo.personId,
          JSON.stringify(resolved.participants),
          JSON.stringify(issueIds),
          JSON.stringify(emptyPreflight()),
          JSON.stringify(emptyDraft()),
          JSON.stringify({ type: "dri", externalId: body.externalId, leadDriId: resolved.lead.personId }),
          body.externalId,
          requestFingerprint,
        ],
      );
      if (inserted.rowCount === 1) {
        meetingId = inserted.rows[0].id;
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
        const raced = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE external_id = $1`, [body.externalId]);
        if (raced.rowCount !== 1) return { status: 409, code: "DRI_MEETING_EXTERNAL_ID_CONFLICT", message: "externalId 已被占用" };
        existing = raced.rows[0];
        meetingId = existing.id;
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (existing) {
    return existing.request_fingerprint === requestFingerprint
      ? { status: 200, card: projectMeetingCard(existing, secret) }
      : { status: 409, code: "DRI_MEETING_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
  }
  await runPreflight(pool, companyMemory, preflightAgent, meetingId);
  return { status: 201, card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), meetingId))!, secret) };
}
