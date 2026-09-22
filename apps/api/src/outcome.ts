import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PostMeetingCandidate,
  type TCard,
  type TIssueLocation,
  type TMeetingOutcomeItem,
  type TMeetingOutcomeState,
  type TMeetingParticipant,
  type TOutcomeHandoff,
  type TOutcomeWarning,
  type TRadarAnchor,
  type TStoredTranscript,
  type TTranscriptTurn,
  type TWarmapTranscript,
  WarmapTranscript,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import { buildReopenAnchor, deriveMeetingStatus, meetingEffectRef, revokeEffect, upsertRadarAnchor } from "./effects.js";
import type { IssueReceiptRow, IssueResearch, IssueRow } from "./issues.js";
import {
  appendFingerprint,
  commit,
  decisionIssueId,
  getMeetingRow,
  hasConfirmedEffect,
  meetingColumns,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type DriExporter,
  type MeetingActionOutcome,
  type MeetingRow,
} from "./meetingStore.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** 抽取输入只读取 Meeting 内嵌结构和关联 Issue，Agent 不能访问业务库。 */
export type PostMeetingAgentInput = {
  meeting: { id: string; title: string; scheduledAt: string; ceoParticipantId: string; participants: TMeetingParticipant[] };
  transcript: { turns: TTranscriptTurn[] };
  issues: { id: string; title: string; location: unknown; urgency: unknown; research: unknown }[];
};

export type PostMeetingAgent = {
  promptHash?: string;
  modelSlot?: "heavy";
  generate(input: PostMeetingAgentInput, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};

export const OUTCOME_AGENT_FAILED = "outcome_agent_failed";
export const INVALID_OUTCOME_CANDIDATE = "invalid_outcome_candidate";
export const OUTCOME_INTERRUPTED = "outcome_interrupted";
/** 与 Chat/Preflight 相同的单 turn 超时保护。 */
export const OUTCOME_TIMEOUT_MS = 180_000;

export function pendingOutcome(now = new Date()): TMeetingOutcomeState {
  return {
    status: "pending",
    pendingSince: now.toISOString(),
    startedAt: null,
    runId: null,
    previousRunIds: [],
    error: null,
    summary: "",
    items: [],
    warnings: [],
    extractedAt: null,
  };
}

export type TranscriptInvalid = { ok: false; code: string; message: string; fieldErrors?: Record<string, string> };
export type TranscriptValid = { ok: true; value: TWarmapTranscript };

const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 整份校验 warmap-transcript.v1：schema、目标 Meeting、turn 唯一、speaker 属 participant、
 * 非空文本、带时区且不破坏顺序的 startedAt。任一项失败整份拒绝，不保存部分 turns。
 */
export function validateTranscript(
  input: unknown,
  meeting: { id: string; participants: TMeetingParticipant[] },
): TranscriptValid | TranscriptInvalid {
  if (!Value.Check(WarmapTranscript, input)) {
    const fieldErrors: Record<string, string> = {};
    for (const error of Value.Errors(WarmapTranscript, input)) {
      fieldErrors[(error.path || "/").replace(/^\//, "") || "transcript"] = error.message;
    }
    return { ok: false, code: "INVALID_TRANSCRIPT", message: "Transcript 不符合 warmap-transcript.v1", fieldErrors };
  }
  if (input.meetingId !== meeting.id) {
    return { ok: false, code: "TRANSCRIPT_MEETING_MISMATCH", message: "Transcript meetingId 与目标 Meeting 不一致", fieldErrors: { meetingId: "meeting mismatch" } };
  }
  const participantIds = new Set(meeting.participants.map((participant) => participant.personId));
  const seen = new Set<string>();
  let lastStartedAt: number | null = null;
  for (const [index, turn] of input.turns.entries()) {
    if (seen.has(turn.id)) {
      return { ok: false, code: "DUPLICATE_TURN_ID", message: `turn.id 在文件内重复: ${turn.id}`, fieldErrors: { [`turns.${index}.id`]: "duplicate" } };
    }
    seen.add(turn.id);
    if (!participantIds.has(turn.speakerId)) {
      return { ok: false, code: "UNKNOWN_SPEAKER", message: `speakerId 不是该 Meeting 的 participant: ${turn.speakerId}`, fieldErrors: { [`turns.${index}.speakerId`]: "unknown speaker" } };
    }
    if (turn.text.trim().length === 0) {
      return { ok: false, code: "EMPTY_TURN_TEXT", message: `turn.text 不能为空: ${turn.id}`, fieldErrors: { [`turns.${index}.text`]: "empty" } };
    }
    if (turn.startedAt !== undefined) {
      if (!ISO_WITH_TIMEZONE.test(turn.startedAt)) {
        return { ok: false, code: "INVALID_TURN_TIME", message: `turn.startedAt 必须是带时区的 ISO 8601: ${turn.startedAt}`, fieldErrors: { [`turns.${index}.startedAt`]: "timezone required" } };
      }
      const parsed = Date.parse(turn.startedAt);
      if (!Number.isFinite(parsed) || (lastStartedAt !== null && parsed < lastStartedAt)) {
        return { ok: false, code: "INVALID_TURN_TIME", message: "turn.startedAt 破坏发言顺序", fieldErrors: { [`turns.${index}.startedAt`]: "out of order" } };
      }
      lastStartedAt = parsed;
    }
  }
  return { ok: true, value: input };
}

export type OutcomeAssessment =
  | { ok: true; summary: string; items: TMeetingOutcomeItem[]; warnings: TOutcomeWarning[] }
  | { ok: false; code: string; message: string };

/**
 * 确定性校验 Agent 候选：turnId 存在、quote 连续存在于被引用 turn、speaker 只从 turn 取得、
 * owner 只能来自“我来”的 speaker 或引文中明确点名的人、CEO 判断只认 CEO turn 和五类权限、
 * issueId 属 Meeting。任一项不合格的候选进入 warnings，不进入可审阅 items。
 */
export function assessOutcomeCandidate(input: {
  candidate: unknown;
  turns: TTranscriptTurn[];
  participants: TMeetingParticipant[];
  ceoParticipantId: string;
  issueIds: string[];
}): OutcomeAssessment {
  if (!Value.Check(PostMeetingCandidate, input.candidate)) {
    return { ok: false, code: INVALID_OUTCOME_CANDIDATE, message: "PostMeeting candidate 不符合严格 schema" };
  }
  const personById = new Map(input.participants.map((participant) => [participant.personId, participant]));
  const turnById = new Map(input.turns.map((turn) => [turn.id, turn]));
  const issueIds = new Set(input.issueIds);
  const acceptedItems: TMeetingOutcomeItem[] = [];
  const warnings: TOutcomeWarning[] = [];
  // 仅已接受的 decision 才能作为 reopenWhen 的父项
  const decisionItemIdByIndex = new Map<number, string>();

  for (const [index, candidate] of input.candidate.items.entries()) {
    const reject = (reason: string) => warnings.push({ candidate, reason });
    const turn = turnById.get(candidate.turnId);
    if (!turn) {
      reject(`turnId 不存在: ${candidate.turnId}`);
      continue;
    }
    if (!turn.text.includes(candidate.quote)) {
      reject("quote 不是被引用 turn 中的连续引文");
      continue;
    }
    const speakerId = turn.speakerId;
    if (candidate.judgmentKind !== undefined && candidate.kind !== "ceoJudgment") {
      reject("judgmentKind 只允许用于 ceoJudgment");
      continue;
    }
    if (candidate.parentIndex !== undefined && candidate.kind !== "reopenWhen") {
      reject("parentIndex 只允许用于 reopenWhen");
      continue;
    }
    if (candidate.kind === "ceoJudgment") {
      if (speakerId !== input.ceoParticipantId) {
        reject("CEO 判断必须来自 CEO turn");
        continue;
      }
      if (!candidate.judgmentKind) {
        reject("ceoJudgment 缺少五类权限 kind");
        continue;
      }
    }
    let parentItemId: string | null = null;
    if (candidate.kind === "reopenWhen") {
      parentItemId = candidate.parentIndex === undefined ? null : decisionItemIdByIndex.get(candidate.parentIndex) ?? null;
      if (!parentItemId) {
        reject("reopenWhen 的父 decision 不存在或已被拒绝");
        continue;
      }
    }
    if (candidate.ownerPersonId !== undefined) {
      const person = personById.get(candidate.ownerPersonId);
      if (!person) {
        reject(`owner 不是该 Meeting 的 participant: ${candidate.ownerPersonId}`);
        continue;
      }
      // “我来”= owner 就是该 turn speaker；明确点名 = 引文里出现该 participant 显示名
      if (person.personId !== speakerId && !candidate.quote.includes(person.displayName)) {
        reject(`owner 无法由该 turn 确定: ${candidate.ownerPersonId}`);
        continue;
      }
    }
    if (candidate.issueId !== undefined && !issueIds.has(candidate.issueId)) {
      reject(`issueId 不属于该 Meeting: ${candidate.issueId}`);
      continue;
    }
    const id = `item-${index + 1}`;
    if (candidate.kind === "decision") decisionItemIdByIndex.set(index, id);
    acceptedItems.push({
      id,
      kind: candidate.kind,
      text: candidate.text,
      turnId: candidate.turnId,
      quote: candidate.quote,
      speakerId,
      ownerPersonId: candidate.ownerPersonId ?? null,
      issueId: candidate.issueId ?? null,
      judgmentKind: candidate.judgmentKind ?? null,
      parentItemId,
      // open 只展示，不带 Review（Ticket 11 处理其余四类的确认/忽略）
      review: candidate.kind === "open" ? null : { status: "pending", effectRef: null },
    });
  }
  return { ok: true, summary: input.candidate.summary, items: acceptedItems, warnings };
}

type OutcomeMeetingRow = {
  id: string;
  version: number;
  title: string;
  scheduled_at: Date;
  status: "scheduled" | "held" | "reviewed" | "cancelled";
  participants: TMeetingParticipant[];
  ceo_participant_id: string;
  issue_ids: string[];
  transcript: { turns: TTranscriptTurn[] } | null;
  outcome: TMeetingOutcomeState | null;
};

type IssueSnapshotRow = { id: string; title: string; location: unknown; urgency: unknown; research: unknown };

/**
 * 运行一次会后抽取：pending/failed → running → ready 或 failed。
 * 失败保留原始 Transcript 并写可见 error，等待 CEO 显式重试；不自动 retry。
 */
export async function runOutcome(
  pool: Pool,
  agent: PostMeetingAgent,
  meetingId: string,
  { timeoutMs = OUTCOME_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<void> {
  const q = pool.query.bind(pool);
  const found = await q(
    `SELECT id, version, title, scheduled_at, status, participants, ceo_participant_id, issue_ids, transcript, outcome
       FROM meetings WHERE id = $1`,
    [meetingId],
  );
  if (found.rowCount !== 1) return;
  const meeting = found.rows[0] as OutcomeMeetingRow;
  if (meeting.status !== "held" || !meeting.transcript || !meeting.outcome) return;
  if (meeting.outcome.status !== "pending" && meeting.outcome.status !== "failed") return;

  const runId = randomUUID();
  const previousRunIds = [...meeting.outcome.previousRunIds];
  if (meeting.outcome.runId && !previousRunIds.includes(meeting.outcome.runId)) previousRunIds.push(meeting.outcome.runId);
  const running: TMeetingOutcomeState = {
    ...meeting.outcome,
    status: "running",
    startedAt: new Date().toISOString(),
    runId,
    previousRunIds,
    error: null,
  };
  // version 条件保证并发下只有一个 run 从 pending/failed 进入 running
  const transition = await q(
    "UPDATE meetings SET outcome = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1 AND status = 'held' AND version = $3",
    [meetingId, JSON.stringify(running), meeting.version],
  );
  if (transition.rowCount !== 1) return;

  const fail = (code: string, message: string) =>
    q(
      `UPDATE meetings
          SET outcome = outcome || jsonb_build_object('status', 'failed', 'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text), 'startedAt', NULL),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND outcome->>'runId' = $2`,
      [meetingId, runId, code, message, new Date().toISOString()],
    );

  try {
    const issueResult = await q("SELECT id, title, location, urgency, research FROM issues WHERE id = ANY($1::uuid[])", [meeting.issue_ids]);
    const input: PostMeetingAgentInput = {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        scheduledAt: meeting.scheduled_at.toISOString(),
        ceoParticipantId: meeting.ceo_participant_id,
        participants: meeting.participants,
      },
      transcript: { turns: meeting.transcript.turns },
      issues: issueResult.rows as IssueSnapshotRow[],
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`Outcome extraction exceeded ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
    let generated: { candidate: unknown; runId?: string };
    try {
      generated = await agent.generate(input, abort.signal);
    } finally {
      clearTimeout(timer);
    }
    const assessed = assessOutcomeCandidate({
      candidate: generated.candidate,
      turns: meeting.transcript.turns,
      participants: meeting.participants,
      ceoParticipantId: meeting.ceo_participant_id,
      issueIds: meeting.issue_ids,
    });
    if (!assessed.ok) {
      await fail(assessed.code, assessed.message);
      return;
    }
    const nextStatus = deriveMeetingStatus(meeting.status, assessed.items);
    await q(
      `UPDATE meetings
          SET outcome = outcome || jsonb_build_object(
                'status', 'ready',
                'summary', $3::text,
                'items', $4::jsonb,
                'warnings', $5::jsonb,
                'extractedAt', $6::text,
                'error', NULL,
                'startedAt', NULL
              ),
              status = $7,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND outcome->>'runId' = $2`,
      [meetingId, runId, assessed.summary, JSON.stringify(assessed.items), JSON.stringify(assessed.warnings), new Date().toISOString(), nextStatus],
    );
  } catch (err) {
    await fail(OUTCOME_AGENT_FAILED, (err as Error).message || "PostMeeting Agent 失败");
  }
}

/** 启动恢复：进程崩溃留下的 pending/running 抽取标为可见失败，等待 CEO 显式重试。 */
export async function recoverInterruptedOutcome(
  q: Query,
  { now = () => new Date(), staleAfterMs = 15 * 60 * 1000 }: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<number> {
  const result = await q(
    `UPDATE meetings
        SET outcome = jsonb_set(
              jsonb_set(
                jsonb_set(outcome, '{status}', '"failed"'),
                '{error}',
                jsonb_build_object('code', $2::text, 'message', $3::text, 'at', $4::text)
              ),
              '{startedAt}',
              'null'::jsonb
            ),
            version = version + 1,
            updated_at = now()
      WHERE status = 'held'
        AND outcome->>'status' IN ('pending', 'running')
        AND (outcome->>'pendingSince')::timestamptz < $1::timestamptz`,
    [new Date(now().getTime() - staleAfterMs), OUTCOME_INTERRUPTED, "Outcome 抽取在进程重启前未完成，请显式重试", now()],
  );
  return result.rowCount ?? 0;
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

