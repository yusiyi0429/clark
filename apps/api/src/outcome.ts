import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PostMeetingCandidate,
  type TCard,
  type TIssueLocation,
  type TMeetingOutcomeItem,
  type TMeetingOutcomeState,
  type TMeetingParticipant,
  type TOutcomeWarning,
  type TPostMeetingCandidate,
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
  childDecisionsOf,
  commit,
  decisionIssueId,
  isChildDecision,
  getMeetingRow,
  hasConfirmedEffect,
  meetingColumns,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type MeetingActionOutcome,
  type MeetingRow,
} from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { dispatchMeetingTodo } from "./tasks.js";
import type { InterpretationContext } from "./meetingContext.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * 按应用的连接池隔离订阅；监听器只排队，确认事务不等待任何 world HTTP。
 * 会后纪要整理好（ready）和每次逐项处理之后都会通知；同一个池可以有多个监听器（本体会议事件、会后分层确认）。
 */
const reviewListeners = new WeakMap<Pool, Set<(meetingId: string) => void>>();
export function onOutcomeReviewed(pool: Pool, listener: (meetingId: string) => void): () => void {
  const listeners = reviewListeners.get(pool) ?? new Set();
  listeners.add(listener);
  reviewListeners.set(pool, listeners);
  return () => { listeners.delete(listener); };
}
function notifyReviewed(pool: Pool, meetingId: string): void {
  for (const listener of reviewListeners.get(pool) ?? []) {
    try { listener(meetingId); } catch (error) { console.warn(`outcome listener failed: ${(error as Error).message}`); }
  }
}

/** 解读纪要时对照的公司地图（每个人的 Mission、本月 outcome、长期目标和 LTO）；由 app 按池注册，没注册时不带。 */
const contextProviders = new WeakMap<Pool, (meetingId: string) => Promise<InterpretationContext | null>>();
export function setOutcomeContextProvider(pool: Pool, provider: (meetingId: string) => Promise<InterpretationContext | null>): void {
  contextProviders.set(pool, provider);
}

/** 抽取输入只读取 Meeting 内嵌结构和关联 Issue，Agent 不能访问业务库。 */
export type PostMeetingAgentInput = {
  meeting: { id: string; title: string; scheduledAt: string; ceoParticipantId: string; participants: TMeetingParticipant[] };
  transcript: { turns: TTranscriptTurn[] };
  issues: { id: string; title: string; location: unknown; urgency: unknown; research: unknown }[];
  /** 公司地图：用来判断哪些改动和战略方向有关（推给 CEO），哪些会牵动别人的 Mission。 */
  context?: InterpretationContext;
};

export type PostMeetingAgent = {
  promptHash?: string;
  modelSlot?: "heavy";
  generate(input: PostMeetingAgentInput, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};

/** CEO 确认的战略议题，对应 ontology_update_requests 一行。 */
export type OntologyUpdateRequest = { id: string; meetingId: string; itemId: string; title: string; brief: string };

/** 本体更新 Agent 的接口：处理后回写请求状态与结果；抛错记为 failed。 */
export type OntologyUpdater = {
  apply(request: OntologyUpdateRequest): Promise<{ status: "pending" | "applied" | "failed"; result: unknown }>;
};

/** 默认不更新本体，请求保持 pending；真实实现由 co-agent 同事接入。 */
export const pendingOntologyUpdater: OntologyUpdater = {
  async apply() {
    return { status: "pending", result: null };
  },
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

type OutcomeCandidateItem = TPostMeetingCandidate["items"][number];

/** 各可选字段只适用于哪些类型（parentIndex 用于 reopenWhen 与子决定）。 */
const FIELD_KINDS: ReadonlyArray<[keyof OutcomeCandidateItem, ReadonlyArray<OutcomeCandidateItem["kind"]>]> = [
  ["judgmentKind", ["ceoJudgment", "strategic"]],
  ["parentIndex", ["reopenWhen", "decision"]],
  ["title", ["strategic"]],
  ["brief", ["strategic"]],
  ["dueDate", ["todo"]],
];

/** 去掉这条候选里不适用于它的类型的字段，返回去掉后的副本和被去掉的字段名。 */
export function dropInapplicableFields(item: OutcomeCandidateItem): { candidate: OutcomeCandidateItem; dropped: string[] } {
  const candidate = { ...item };
  const dropped: string[] = [];
  for (const [field, kinds] of FIELD_KINDS) {
    if (candidate[field] !== undefined && !kinds.includes(candidate.kind)) {
      delete candidate[field];
      dropped.push(field);
    }
  }
  return { candidate, dropped };
}

const OPTIONAL_FIELDS = ["ownerPersonId", "issueId", "judgmentKind", "parentIndex", "title", "brief", "dueDate"] as const;
/** 推给 CEO 的战略项只认这两类：公司方向 / LTO / PO 的改动，跨战场调资源。 */
const CEO_STRATEGIC_KINDS = new Set(["company_direction", "resource_allocation"]);
const PLACEHOLDER_TEXT = new Set(["不适用", "不涉及", "无", "暂无", "没有", "未知", "未指定", "n/a", "na", "none", "null", "-", "—", "/"]);

/** null、空串、「不适用」这类占位、负数下标，都算没填。 */
function isPlaceholder(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return PLACEHOLDER_TEXT.has(value.trim().toLowerCase()) || value.trim() === "";
  return typeof value === "number" && value < 0;
}

/**
 * 在严格 schema 之前把每条候选里填了占位值的可选字段删掉，当作没填；其余原样交给 schema。
 * 返回副本和每条被删掉的字段名（下标对应 items）。
 */
export function dropPlaceholderFields(input: unknown): { candidate: unknown; dropped: string[][] } {
  if (typeof input !== "object" || input === null || !Array.isArray((input as { items?: unknown }).items)) return { candidate: input, dropped: [] };
  const dropped: string[][] = [];
  const items = (input as { items: unknown[] }).items.map((raw) => {
    const fields: string[] = [];
    dropped.push(fields);
    if (typeof raw !== "object" || raw === null) return raw;
    const item = { ...(raw as Record<string, unknown>) };
    for (const field of OPTIONAL_FIELDS) {
      if (field in item && isPlaceholder(item[field])) {
        delete item[field];
        fields.push(field);
      }
    }
    return item;
  });
  return { candidate: { ...input, items }, dropped };
}

/**
 * 确定性校验 Agent 候选：turnId 存在、quote 连续存在于被引用 turn、speaker 只从 turn 取得、
 * owner 只能来自“我来”的 speaker 或引文中明确点名的人、CEO 判断只认 CEO turn 和五类权限、
 * 战略议题可引用任何人但标题/说明/五类权限缺一不可、todo 的 dueDate 是真实日期、
 * 不适用于该类型的可选字段、填了「不适用」/null/-1 这类占位的可选字段直接丢掉（只记日志）、
 * 不属于这场会的 issueId 当没填（条目保留、不关联议题）。其余任一项不合格的候选进入 warnings，不进入可审阅 items。
 */
export function assessOutcomeCandidate(input: {
  candidate: unknown;
  turns: TTranscriptTurn[];
  participants: TMeetingParticipant[];
  ceoParticipantId: string;
  issueIds: string[];
}): OutcomeAssessment {
  // 「不适用」、null、-1 这类占位值当没填，先删掉再过 schema，免得一个占位废掉整份候选
  const { candidate: normalized, dropped: placeholders } = dropPlaceholderFields(input.candidate);
  if (!Value.Check(PostMeetingCandidate, normalized)) {
    return { ok: false, code: INVALID_OUTCOME_CANDIDATE, message: "PostMeeting candidate 不符合严格 schema" };
  }
  const personById = new Map(input.participants.map((participant) => [participant.personId, participant]));
  const turnById = new Map(input.turns.map((turn) => [turn.id, turn]));
  const issueIds = new Set(input.issueIds);
  const acceptedItems: TMeetingOutcomeItem[] = [];
  const warnings: TOutcomeWarning[] = [];
  // 仅已接受的 decision 才能作为 reopenWhen 的父项；子决定的父项只能是已接受的主决定（只分一层）
  const decisionItemIdByIndex = new Map<number, string>();
  const mainDecisionIndexes = new Set<number>();

  for (const [index, raw] of normalized.items.entries()) {
    // 模型常把只属于别的类型的可选字段也填上（decision 带 judgmentKind、brief 写「不适用」等）：
    // 这类字段直接丢掉、整条保留，只在日志里记一条警告；字段缺失、类型不对仍照旧拒收。
    const { candidate, dropped } = dropInapplicableFields(raw);
    // decision 的 parentIndex 指向自己或指向不是 decision 的条目，说明不是子决定、只是顺手填的
    if (candidate.kind === "decision" && candidate.parentIndex !== undefined) {
      const target = normalized.items[candidate.parentIndex];
      if (candidate.parentIndex === index || (target !== undefined && target.kind !== "decision")) {
        delete candidate.parentIndex;
        dropped.push("parentIndex");
      }
    }
    const droppedAll = [...(placeholders[index] ?? []).map((field) => `${field}(占位)`), ...dropped];
    if (droppedAll.length) {
      console.warn(`outcome candidate #${index + 1} (${candidate.kind}) 丢掉不适用的字段: ${droppedAll.join(", ")}`);
    }
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
    if (candidate.dueDate !== undefined && !isCalendarDate(candidate.dueDate)) {
      reject(`dueDate 不是有效日期: ${candidate.dueDate}`);
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
    // 战略议题可以引用任何人的发言，但标题、说明与五类权限缺一不可
    if (candidate.kind === "strategic") {
      if (!candidate.title || !candidate.brief || !candidate.judgmentKind) {
        reject("strategic 缺少 title、brief 或 judgmentKind");
        continue;
      }
      if ((candidate.brief.match(/[。！？!?]/g)?.length ?? 0) > 2) {
        reject("brief 最多两句话");
        continue;
      }
      // D-40：只有改公司方向、长期目标（LTO）、周期目标（PO）或跨战场调资源的才推给 CEO；
      // 其余（包括和战略方向有关、但只影响本战场打法、计划、执行的）降成会上的决定，归主持人确认。
      if (!CEO_STRATEGIC_KINDS.has(candidate.judgmentKind)) {
        console.warn(`outcome candidate #${index + 1} strategic(${candidate.judgmentKind}) 不在 CEO 战略范围，改为 decision`);
        candidate.kind = "decision";
        delete candidate.title;
        delete candidate.brief;
        delete candidate.judgmentKind;
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
    if (candidate.kind === "decision" && candidate.parentIndex !== undefined) {
      parentItemId = mainDecisionIndexes.has(candidate.parentIndex) ? decisionItemIdByIndex.get(candidate.parentIndex) ?? null : null;
      if (!parentItemId) {
        reject("子决定的主决定不存在、已被拒绝或本身是子决定");
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
    // 结构化提交要求每个字段都填，没挂议题的会里模型常把会议 id 填进 issueId：不属于这场会的 issueId 当没填，条目保留、不关联议题。
    if (candidate.issueId !== undefined && !issueIds.has(candidate.issueId)) {
      console.warn(`outcome candidate #${index + 1} (${candidate.kind}) issueId 不属于该 Meeting，当没填: ${candidate.issueId}`);
      delete candidate.issueId;
    }
    const id = `item-${index + 1}`;
    if (candidate.kind === "decision") decisionItemIdByIndex.set(index, id);
    if (candidate.kind === "decision" && !parentItemId) mainDecisionIndexes.add(index);
    const item: TMeetingOutcomeItem = {
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
    };
    if (candidate.kind === "strategic") {
      item.title = candidate.title;
      item.brief = candidate.brief;
    }
    if (candidate.dueDate !== undefined) item.dueDate = candidate.dueDate;
    acceptedItems.push(item);
  }
  return { ok: true, summary: normalized.summary, items: acceptedItems, warnings };
}

/** YYYY-MM-DD 且是真实存在的日期（排除 2 月 30 日这类）。 */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type OutcomeMeetingRow = {
  id: string;
  version: number;
  title: string;
  scheduled_at: Date;
  status: "scheduled" | "held" | "reviewed" | "cancelled";
  participants: TMeetingParticipant[];
  lead_dri_id: string;
  ceo_participant_id: string;
  issue_ids: string[];
  transcript: { turns: TTranscriptTurn[] } | null;
  outcome: TMeetingOutcomeState | null;
};

type IssueSnapshotRow = { id: string; title: string; location: unknown; urgency: unknown; research: unknown };

/**
 * 运行一次会后抽取：pending/failed → running → ready 或 failed。
 * 进入 ready 的同一事务内把每条 todo 推送成执行事项（见 dispatchMeetingTodo）。
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
    `SELECT id, version, title, scheduled_at, status, participants, lead_dri_id, ceo_participant_id, issue_ids, transcript, outcome
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
    // 公司地图读不到不拦着整理纪要：没有就按原来的输入跑。
    const context = await contextProviders.get(pool)?.(meetingId).catch(() => null) ?? null;
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
      ...(context ? { context } : {}),
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ run_id: string | null }>("SELECT outcome->>'runId' AS run_id FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
      if (current.rows[0]?.run_id !== runId) {
        await client.query("ROLLBACK");
        return;
      }
      // 推送后的 todo 记为已确认（effect task:<id>），已有确认效果即阻止替换 Transcript
      for (const item of assessed.items) {
        if (item.kind !== "todo") continue;
        const ownerId = item.ownerPersonId ?? meeting.lead_dri_id;
        const taskId = await dispatchMeetingTodo(client, { id: meetingId, leadDriId: meeting.lead_dri_id, ceoId: meeting.ceo_participant_id,
          ownerName: meeting.participants.find((person) => person.personId === ownerId)?.displayName, title: meeting.title }, item);
        if (taskId) item.review = { status: "confirmed", effectRef: `task:${taskId}` };
      }
      const nextStatus = deriveMeetingStatus(meeting.status, assessed.items);
      await client.query(
        `UPDATE meetings
            SET outcome = outcome || jsonb_build_object(
                  'status', 'ready',
                  'summary', $2::text,
                  'items', $3::jsonb,
                  'warnings', $4::jsonb,
                  'extractedAt', $5::text,
                  'error', NULL,
                  'startedAt', NULL
                ),
                status = $6,
                version = version + 1,
                updated_at = now()
          WHERE id = $1`,
        [meetingId, assessed.summary, JSON.stringify(assessed.items), JSON.stringify(assessed.warnings), new Date().toISOString(), nextStatus],
      );
      await client.query("COMMIT");
      notifyReviewed(pool, meetingId);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
    [new Date(now().getTime() - staleAfterMs), OUTCOME_INTERRUPTED, "会后整理还没完成，可以重新整理。", now()],
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
  hostId?: string,
): Promise<TranscriptImportResult> {
  const meeting = await getMeetingRow(pool.query.bind(pool), meetingId);
  if (!meeting || (hostId !== undefined && meeting.lead_dri_id !== hostId)) return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
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
    if (hostId !== undefined && row.lead_dri_id !== hostId) {
      await client.query("ROLLBACK");
      return { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
    }
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
          SET transcript = $2::jsonb, transcript_candidate = NULL, outcome = $3::jsonb, status = 'held', version = version + 1, updated_at = now()
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
/** 逐项处理的提交：写回 Outcome items、派生 Meeting 状态并记 fingerprint。 */
async function commitReview(
  client: PoolClient,
  row: MeetingRow,
  state: TMeetingOutcomeState,
  items: TMeetingOutcomeItem[],
  fingerprint: string,
  secret: string,
): Promise<{ card: TCard }> {
  const nextState: TMeetingOutcomeState = { ...state, items };
  const updated = await updateMeeting(
    client,
    row.id,
    "outcome = $2::jsonb, status = $3, version = version + 1, action_fingerprints = $4::jsonb",
    [JSON.stringify(nextState), deriveMeetingStatus(row.status, items), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
  );
  return commit(client, updated, secret);
}
type ReviewError = { error: { status: number; code: string; message: string } };
/** 确认一条 decision：有关联议题时写决定回执并把议题记为 decided；没有关联议题时只记为会上已确认的决定。 */
async function confirmDecision(client: PoolClient, row: MeetingRow, item: TMeetingOutcomeItem, fingerprint: string, now: string): Promise<ReviewError | null> {
  const effectRef = meetingEffectRef(row.id, "decision", item.id)!;
  const issueId = decisionIssueId(row, item);
  if (!issueId) {
    // 没有关联议题的会上决定：只记为已确认的会议决定（会议页会后区与「已处理」可见），不写任何议题
    item.review = { status: "confirmed", effectRef };
    return null;
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
  return null;
}
/**
 * 逐项确认：写对应数据库 effect、effectRef 与 review，派生 Meeting reviewed。
 * 不同条目仍由 Meeting 行 version 串行，fingerprint 重放不产生第二个 effect。
 * todo 确认即推送执行事项；strategic 确认写一条待更新本体，提交后交给 OntologyUpdater。
 */
export async function executeConfirmItem(
  pool: Pool,
  ontologyUpdater: OntologyUpdater,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  let ontologyRequest: OntologyUpdateRequest | null = null;
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
    if (isChildDecision(items, item)) {
      return { error: { status: 409, code: "CHILD_FOLLOWS_PARENT", message: "这一条随主决定一起确认，请处理主决定" } };
    }
    if (item.kind === "strategic") {
      ontologyRequest = { id: randomUUID(), meetingId: row.id, itemId: item.id, title: item.title ?? item.text, brief: item.brief ?? item.text };
      await client.query(
        "INSERT INTO ontology_update_requests (id, meeting_id, item_id, title, brief) VALUES ($1, $2, $3, $4, $5)",
        [ontologyRequest.id, ontologyRequest.meetingId, ontologyRequest.itemId, ontologyRequest.title, ontologyRequest.brief],
      );
      item.review = { status: "confirmed", effectRef: `ontology:${ontologyRequest.id}` };
      return commitReview(client, row, state, items, fingerprint, secret);
    }
    const effectRef = meetingEffectRef(row.id, item.kind, item.id);
    if (!effectRef) return { error: { status: 409, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能创建效果" } };
    const now = new Date().toISOString();

    if (item.kind === "decision") {
      // 主决定与它还待处理的子决定在同一事务内一起确认；子决定各自写自己的回执（有关联议题时）
      for (const target of [item, ...childDecisionsOf(items, item.id).filter((child) => child.review?.status === "pending")]) {
        const failed = await confirmDecision(client, row, target, fingerprint, now);
        if (failed) return failed;
      }
    } else if (item.kind === "todo") {
      // 撤回后再确认即重新推送；负责人是 CEO 时只记已确认，不建执行事项
      const ownerId = item.ownerPersonId ?? row.lead_dri_id;
      const taskId = await dispatchMeetingTodo(client, { id: row.id, leadDriId: row.lead_dri_id, ceoId: row.ceo_participant_id,
        ownerName: row.participants.find((person) => person.personId === ownerId)?.displayName, title: row.title }, item);
      item.review = { status: "confirmed", effectRef: taskId ? `task:${taskId}` : effectRef };
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

    return commitReview(client, row, state, items, fingerprint, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  if (ontologyRequest) await applyOntologyUpdate(pool, ontologyUpdater, ontologyRequest);
  notifyReviewed(pool, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}
/** 提交确认后才交给本体更新；失败不改回 pending，只把请求记为 failed。 */
async function applyOntologyUpdate(pool: Pool, updater: OntologyUpdater, request: OntologyUpdateRequest): Promise<void> {
  let applied: { status: "pending" | "applied" | "failed"; result: unknown };
  try {
    applied = await updater.apply(request);
  } catch (err) {
    applied = { status: "failed", result: { error: (err as Error).message || "ontology update failed" } };
  }
  await pool.query(
    "UPDATE ontology_update_requests SET status = $2, result = $3::jsonb, updated_at = now() WHERE id = $1",
    [request.id, applied.status, applied.result == null ? null : JSON.stringify(applied.result)],
  );
}
/**
 * 忽略一项只记录状态与原因，不产生 effect；父 decision 被忽略时同一事务内处理其子条件。
 * CEO 不同意战略项时通知主持人（主持人就是 CEO 时不发）。
 */
export async function executeDismissItem(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  reason?: string,
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
    if (!item.review) return { error: { status: 409, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能忽略" } };
    if (item.review.status !== "pending") return { error: { status: 409, code: "ITEM_ALREADY_REVIEWED", message: "该条目已处理" } };
    if (isChildDecision(items, item)) {
      return { error: { status: 409, code: "CHILD_FOLLOWS_PARENT", message: "这一条随主决定一起处理，请处理主决定" } };
    }

    item.review = { status: "dismissed", effectRef: null, reason: reason ?? null };
    // 父 decision 被忽略时，其未处理的子条件在同一事务内自动 dismissed（不会存在已确认锚点：
    // 撤回父时已同步清理）。
    if (item.kind === "decision") {
      // 子决定同样一并忽略
      for (const child of items) {
        if ((child.kind !== "reopenWhen" && child.kind !== "decision") || child.parentItemId !== item.id) continue;
        if (child.review?.status === "pending") {
          child.review = { status: "dismissed", effectRef: null, reason: "parent_dismissed" };
        }
      }
    }
    if (item.kind === "strategic" && row.lead_dri_id !== row.ceo_participant_id) {
      await insertNotification(client, { personId: row.lead_dri_id, kind: "strategic_rejected", objectType: "meeting", objectId: row.id, itemId: item.id });
    }

    return commitReview(client, row, state, items, fingerprint, secret);
  });
  if ("card" in outcome && !outcome.replayed) notifyReviewed(pool, scope.objectId);
  return outcome;
}
/**
 * 撤回已确认效果：统一走 revokeEffect，同步 Outcome item、Receipt、Radar anchor、执行事项与 Meeting 状态。
 * 已推送的执行事项只在负责人未开始时可撤回，否则返回明确 warning。
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
