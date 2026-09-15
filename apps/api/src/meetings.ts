import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PreflightCandidate,
  type TActionDescriptor,
  type TCard,
  type TIssueLocation,
  type TMeetingDraft,
  type TMeetingOutcomeItem,
  type TMeetingOutcomeState,
  type TMeetingParticipant,
  type TMeetingPreflight,
  type TMeetingPreflightEntry,
  type TOutcomeHandoff,
  type TRadarAnchor,
  type TStoredTranscript,
  type TSupplementRequest,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import { buildReopenAnchor, deriveMeetingStatus, meetingEffectRef, revokeEffect, upsertRadarAnchor } from "./effects.js";
import { getIssueRow, projectIssueCard, type IssueReceiptRow, type IssueResearch, type IssueRow } from "./issues.js";
import { hasConfirmedEffect, pendingOutcome, runOutcome, validateTranscript, type PostMeetingAgent } from "./outcome.js";

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
  "participants", "issue_ids", "preflight", "draft", "transcript", "outcome", "origin_ref", "external_id",
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
    actions.push(
      action("meeting.update_draft", "保存准备状态"),
      action("meeting.request_supplement", "请求补充材料"),
      action("meeting.cancel", "取消会议"),
    );
    if (row.preflight.status === "failed") actions.push(action("meeting.retry_preflight", "重试预审"));
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
      transcript: row.transcript,
      outcome: row.outcome,
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
    try {
      const result = await exporter.export(
        { effectRef: `supplement:${scope.objectId}:${requestId}`, targetDriId: target.personId, text: input.text },
        new AbortController().signal,
      );
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

export type TranscriptImportResult =
  | { status: 200; card: TCard }
  | { status: 400 | 404 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

/**
 * 唯一 Transcript 导入边界：Web multipart 与 service API 都走这里做整份校验。
 * 校验成功后单事务保存 JSONB 并把 scheduled Meeting 改 held，提交后才启动 Outcome 抽取。
 */
export async function importTranscript(
  pool: Pool,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  meetingId: string,
  raw: unknown,
): Promise<TranscriptImportResult> {
  const meeting = await getMeetingRow(pool.query.bind(pool), meetingId);
  if (!meeting) return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
  const validated = validateTranscript(raw, meeting);
  if (!validated.ok) return { status: 400, code: validated.code, message: validated.message, fieldErrors: validated.fieldErrors };

  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
    }
    const row = locked.rows[0];
    if (row.transcript) {
      await client.query("ROLLBACK");
      return { status: 409, code: "TRANSCRIPT_ALREADY_IMPORTED", message: "Transcript 已存在，替换必须走危险 Action" };
    }
    if (row.status !== "scheduled") {
      await client.query("ROLLBACK");
      return { status: 409, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以导入 Transcript" };
    }
    const transcript: TStoredTranscript = { ...validated.value, importedAt: now };
    await client.query(
      `UPDATE meetings
          SET transcript = $2::jsonb, outcome = $3::jsonb, status = 'held', version = version + 1, updated_at = now()
        WHERE id = $1`,
      [meetingId, JSON.stringify(transcript), JSON.stringify(pendingOutcome(new Date(now)))],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await runOutcome(pool, outcomeAgent, meetingId);
  return { status: 200, card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), meetingId))!, secret) };
}

/**
 * 危险 Action：仅在 held 且没有 confirmed effect 时整份替换 Transcript。
 * 替换清空旧 candidate、bump version 使旧 actionId 失效，提交后强制重跑抽取。
 */
export async function executeReplaceTranscript(
  pool: Pool,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  scope: ActionScope,
  input: { transcript: unknown },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "held" && row.status !== "reviewed") {
      return { error: { status: 409, code: "MEETING_NOT_HELD", message: "只有 held/reviewed Meeting 可以替换 Transcript" } };
    }
    if (hasConfirmedEffect(row.outcome)) {
      return { error: { status: 409, code: "OUTCOME_HAS_CONFIRMED_EFFECT", message: "已有 confirmed effect，禁止替换 Transcript" } };
    }
    const validated = validateTranscript(input.transcript, row);
    if (!validated.ok) {
      return { error: { status: 400, code: validated.code, message: validated.message, fieldErrors: validated.fieldErrors } };
    }
    const now = new Date().toISOString();
    const transcript: TStoredTranscript = { ...validated.value, importedAt: now };
    const updated = await updateMeeting(
      client,
      row.id,
      // 新 Transcript 使旧 Outcome 失效，Meeting 回到 held 等待重新处理
      "transcript = $2::jsonb, outcome = $3::jsonb, status = 'held', version = version + 1, action_fingerprints = $4::jsonb",
      [JSON.stringify(transcript), JSON.stringify(pendingOutcome(new Date(now))), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await runOutcome(pool, outcomeAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/** 显式重试：只有 held 且抽取失败时可用；失败保留 Transcript，不自动 retry。 */
export async function executeRetryOutcome(
  pool: Pool,
  outcomeAgent: PostMeetingAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "held" || !row.transcript) return { error: { status: 409, code: "MEETING_NOT_HELD", message: "只有已导入 Transcript 的 held Meeting 可以重试抽取" } };
    if (row.outcome?.status !== "failed") return { error: { status: 409, code: "MEETING_OUTCOME_NOT_FAILED", message: "只有失败的会后抽取可以显式重试" } };
    const updated = await updateMeeting(
      client,
      row.id,
      "version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await runOutcome(pool, outcomeAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

function radarLocation(location: TIssueLocation | null | undefined): TRadarAnchor["location"] {
  if (location?.level === "battlefield") return { type: "battlefield", id: location.battlefieldId };
  if (location?.level === "capability") return { type: "capability", id: location.capabilityId };
  return { type: "company" };
}

/** decision 的关联 Issue：显式 issueId 优先，否则只有单一关联 Issue 时才无歧义。 */
function decisionIssueId(row: MeetingRow, item: TMeetingOutcomeItem): string | null {
  return item.issueId ?? (row.issue_ids.length === 1 ? row.issue_ids[0] : null);
}

function clonedItems(state: TMeetingOutcomeState): TMeetingOutcomeItem[] {
  return state.items.map((item) => structuredClone(item));
}

/**
 * 逐项确认：写对应数据库 effect、effectRef 与 review，派生 Meeting reviewed。
 * 不同条目仍由 Meeting 行 version 串行，fingerprint 重放不产生第二个 effect。
 */
export async function executeConfirmItem(
  pool: Pool,
  exporter: DriExporter | undefined,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "held" && row.status !== "reviewed") {
      return { error: { status: 409, code: "MEETING_NOT_REVIEWABLE", message: "只有 held/reviewed Meeting 可以处理会后条目" } };
    }
    const state = row.outcome;
    if (!state || state.status !== "ready") {
      return { error: { status: 409, code: "OUTCOME_NOT_READY", message: "会后抽取尚未完成" } };
    }
    const items = clonedItems(state);
    const item = scope.itemId ? items.find((candidate) => candidate.id === scope.itemId) : undefined;
    if (!item) return { error: { status: 404, code: "OUTCOME_ITEM_NOT_FOUND", message: "Outcome item 不存在" } };
    if (!item.review) return { error: { status: 409, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能创建效果" } };
    if (item.review.status !== "pending") return { error: { status: 409, code: "ITEM_ALREADY_REVIEWED", message: "该条目已处理" } };
    const effectRef = meetingEffectRef(row.id, item.kind, item.id);
    if (!effectRef) return { error: { status: 409, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能创建效果" } };
    const now = new Date().toISOString();

    if (item.kind === "decision") {
      const issueId = decisionIssueId(row, item);
      if (!issueId) {
        return { error: { status: 409, code: "DECISION_ITEM_WITHOUT_ISSUE", message: "该 decision 没有关联 Issue，无法创建 Receipt" } };
      }
      const locked = await client.query<IssueRow>("SELECT * FROM issues WHERE id = $1 FOR UPDATE", [issueId]);
      if (locked.rowCount !== 1) return { error: { status: 404, code: "ISSUE_NOT_FOUND", message: "关联 Issue 不存在" } };
      const issue = locked.rows[0];
      if (issue.status === "dismissed") return { error: { status: 409, code: "ISSUE_DISMISSED", message: "dismissed Issue 不能写入 Receipt" } };
      const receipt: IssueReceiptRow = {
        id: randomUUID(),
        actionType: "meeting.confirm_item",
        actionFingerprint: fingerprint,
        effectRef,
        decisionText: item.text,
        researchStatusAtDecision: (issue.research as IssueResearch).status,
        override: false,
        source: { kind: "meeting-item", meetingId: row.id, outcomeItemId: item.id },
        createdAt: now,
      };
      await client.query(
        "UPDATE issues SET status = 'decided', receipts = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
        [issue.id, JSON.stringify([...issue.receipts, receipt])],
      );
      item.review = { status: "confirmed", effectRef };
    } else if (item.kind === "todo") {
      item.review = { status: "confirmed", effectRef, handoff: { exportStatus: "pending_export", exportRef: null, error: null } };
    } else if (item.kind === "ceoJudgment") {
      // CEO 判断只保留在 MeetingOutcome，不直接写 CompanyMemory
      item.review = { status: "confirmed", effectRef };
    } else {
      const parent = item.parentItemId ? items.find((candidate) => candidate.id === item.parentItemId) : undefined;
      if (!parent || parent.review?.status !== "confirmed") {
        return { error: { status: 409, code: "PARENT_DECISION_NOT_CONFIRMED", message: "父 decision 尚未确认" } };
      }
      const parentIssueId = decisionIssueId(row, parent);
      let location: TRadarAnchor["location"] = { type: "company" };
      if (parentIssueId) {
        const parentIssue = await client.query<{ location: TIssueLocation }>("SELECT location FROM issues WHERE id = $1", [parentIssueId]);
        if (parentIssue.rowCount === 1) location = radarLocation(parentIssue.rows[0].location);
      }
      const anchor = buildReopenAnchor({ meetingId: row.id, itemId: item.id, text: item.text, location, effectRef });
      await upsertRadarAnchor(client, anchor);
      item.review = { status: "confirmed", effectRef, anchorId: anchor.id };
    }

    const nextState: TMeetingOutcomeState = { ...state, items };
    const status = deriveMeetingStatus(row.status, items);
    const updated = await updateMeeting(
      client,
      row.id,
      "outcome = $2::jsonb, status = $3, version = version + 1, action_fingerprints = $4::jsonb",
      [JSON.stringify(nextState), status, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await exportPendingTodoHandoff(pool, scope.objectId, scope.itemId, exporter);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/** 忽略一项只记录状态与原因，不产生 effect；父 decision 被忽略时同一事务内处理其子条件。 */
export async function executeDismissItem(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  reason?: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "held" && row.status !== "reviewed") {
      return { error: { status: 409, code: "MEETING_NOT_REVIEWABLE", message: "只有 held/reviewed Meeting 可以处理会后条目" } };
    }
    const state = row.outcome;
    if (!state || state.status !== "ready") {
      return { error: { status: 409, code: "OUTCOME_NOT_READY", message: "会后抽取尚未完成" } };
    }
    const items = clonedItems(state);
    const item = scope.itemId ? items.find((candidate) => candidate.id === scope.itemId) : undefined;
    if (!item) return { error: { status: 404, code: "OUTCOME_ITEM_NOT_FOUND", message: "Outcome item 不存在" } };
    if (!item.review) return { error: { status: 409, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能忽略" } };
    if (item.review.status !== "pending") return { error: { status: 409, code: "ITEM_ALREADY_REVIEWED", message: "该条目已处理" } };

    item.review = { status: "dismissed", effectRef: null, reason: reason ?? null };
    // 父 decision 被忽略时，其未处理的子条件在同一事务内自动 dismissed（不会存在已确认锚点：
    // 撤回父时已同步清理）。
    if (item.kind === "decision") {
      for (const child of items) {
        if (child.kind !== "reopenWhen" || child.parentItemId !== item.id) continue;
        if (child.review?.status === "pending") {
          child.review = { status: "dismissed", effectRef: null, reason: "parent_dismissed" };
        }
      }
    }

    const nextState: TMeetingOutcomeState = { ...state, items };
    const status = deriveMeetingStatus(row.status, items);
    const updated = await updateMeeting(
      client,
      row.id,
      "outcome = $2::jsonb, status = $3, version = version + 1, action_fingerprints = $4::jsonb",
      [JSON.stringify(nextState), status, JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}

/**
 * 撤回已确认效果：统一走 revokeEffect，同步 Outcome item、Receipt、Radar anchor 与 Meeting 状态。
 * delivered 的外部效果禁用撤回：Card 不提供该 Action，服务端也返回明确 warning。
 */
export async function executeRevokeEffect(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  reason?: string,
): Promise<MeetingActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<MeetingRow>(
      `SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`,
      [scope.objectId],
    );
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
    }
    const row = locked.rows[0];
    // fingerprint 已产生撤回：幂等返回当前 Card，不要求 item 仍处于 confirmed
    if (row.action_fingerprints.includes(fingerprint)) {
      await client.query("COMMIT");
      return { card: projectMeetingCard(row, secret), replayed: true };
    }
    const item = scope.itemId ? row.outcome?.items.find((candidate) => candidate.id === scope.itemId) : undefined;
    const effectRef = item?.review?.effectRef;
    if (!effectRef) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "ITEM_NOT_CONFIRMED", message: "只有已确认的条目可以撤回" } };
    }
    const result = await revokeEffect(client, effectRef, fingerprint, { expectedVersion: scope.objectVersion, reason });
    if (!result.ok) {
      await client.query("ROLLBACK");
      if ("conflict" in result && result.conflict) {
        return { conflict: true, latestCard: projectMeetingCard(result.latestMeeting!, secret) };
      }
      return { error: { status: 409, code: result.code, message: result.message } };
    }
    // 本 Action 只处理会议条目效果，effectRef 必为 meeting 前缀
    if (result.target !== "meeting") {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "UNKNOWN_EFFECT", message: "该 Action 只能撤回 meeting effect" } };
    }
    await client.query("COMMIT");
    return { card: projectMeetingCard(result.meeting, secret) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 提交确认后才尝试真实外发；失败不改回 confirmed，只写可见 failed。 */
async function exportPendingTodoHandoff(
  pool: Pool,
  meetingId: string,
  itemId: string | undefined,
  exporter: DriExporter | undefined,
): Promise<void> {
  if (!exporter || !itemId) return;
  const meeting = await getMeetingRow(pool.query.bind(pool), meetingId);
  const item = meeting?.outcome?.items.find((candidate) => candidate.id === itemId);
  if (!item || item.kind !== "todo" || item.review?.status !== "confirmed") return;
  if (item.review.handoff?.exportStatus !== "pending_export" || !item.ownerPersonId) return;
  try {
    const result = await exporter.export(
      { effectRef: item.review.effectRef!, targetDriId: item.ownerPersonId, text: item.text },
      new AbortController().signal,
    );
    await updateOutcomeHandoff(pool, meetingId, itemId, { exportStatus: "delivered", exportRef: result.exportRef, error: null });
  } catch (err) {
    await updateOutcomeHandoff(pool, meetingId, itemId, { exportStatus: "failed", exportRef: null, error: (err as Error).message || "export failed" });
  }
}

/** Handoff 状态与其它 Outcome 写入一样持行锁，避免整份 outcome 被并发覆盖。 */
async function updateOutcomeHandoff(
  pool: Pool,
  meetingId: string,
  itemId: string,
  handoff: TOutcomeHandoff,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    await client.query(
      `UPDATE meetings
          SET outcome = jsonb_set(outcome, '{items}', (
                SELECT jsonb_agg(
                  CASE WHEN item->>'id' = $2 THEN jsonb_set(item, '{review,handoff}', $3::jsonb) ELSE item END
                )
                FROM jsonb_array_elements(outcome->'items') AS item
              )),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND outcome->'items' @> jsonb_build_array(jsonb_build_object('id', $2::text))`,
      [meetingId, itemId, JSON.stringify(handoff)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
