import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PostMeetingCandidate,
  type TCard,
  type TMeetingCardTargetOption,
  type TMeetingOutcomeItem,
  type TMeetingOutcomeState,
  type TMeetingParticipant,
  type TOutcomeWarning,
  type TPostMeetingCandidate,
  type TStoredTranscript,
  type TTranscriptTurn,
  type TWarmapTranscript,
  WarmapTranscript,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import {
  appendFingerprint,
  commit,
  getMeetingRow,
  hasConfirmedEffect,
  meetingColumns,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type MeetingActionOutcome,
  type MeetingRow,
} from "./meetingStore.js";
import type { InterpretationContext } from "./meetingContext.js";
import { buildCardDraft, prepareCardGeneration, saveGeneratedCard } from "./meetingCard.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

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
  /** 公司地图：用来理解会上说的对象。 */
  context?: InterpretationContext;
  /** 会议卡修改的候选目标：挂点对象里有文字的组件。 */
  targetOptions: TMeetingCardTargetOption[];
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

type OutcomeCandidateItem = TPostMeetingCandidate["items"][number];

/** 各可选字段只适用于哪些类型（parentIndex 用于 reopenWhen 与子决定；负责人只对决定和待办生效，D-42）。 */
const FIELD_KINDS: ReadonlyArray<[keyof OutcomeCandidateItem, ReadonlyArray<OutcomeCandidateItem["kind"]>]> = [
  ["ownerPersonId", ["decision", "todo"]],
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
/** 推给 CEO 的战略项只认这三类：公司方向 / LTO / PO 的改动，Mission 本月结果目标或成功标准的改动（算改 PO），跨战场调资源。 */
const CEO_STRATEGIC_KINDS = new Set(["company_direction", "mission_boundary", "resource_allocation"]);
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
      // D-40/D-41：只有改公司方向、长期目标（LTO）、周期目标（PO，含 Mission 的本月结果目标或成功标准）或跨战场调资源的才推给 CEO；
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
 * 运行一次会后整理：pending/failed → running → ready 或 failed。
 * 生成会议卡草稿（meetingCard.ts），进入 ready 的同一事务内存进 meeting_cards；outcome 只记进度，items 为空、summary 为空（拍板 4、5）。
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
    // 会议卡：挂点对象里有文字的组件作候选目标给模型选（本体读不到时为空）。
    const prepared = await prepareCardGeneration(pool, meetingId);
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
      targetOptions: prepared.targetOptions,
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
    const card = buildCardDraft(pool, prepared, generated.candidate);
    if (!card) {
      await fail(INVALID_OUTCOME_CANDIDATE, "会议卡候选不符合严格 schema");
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
      // 会议卡只在 meeting_cards 里；会后整理只记进度，不出逐条条目、不推执行事项（行动项整卡确认后才推）、不排分层。
      // 会议停在 held（卡片还待整卡确认），不按逐条条目算成 reviewed。
      await saveGeneratedCard(pool, client, meetingId, card);
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
                version = version + 1,
                updated_at = now()
          WHERE id = $1`,
        [meetingId, "", "[]", "[]", new Date().toISOString()],
      );
      await client.query("COMMIT");
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
 * 危险 Action：仅在 held 且没有 confirmed effect（会议卡确认过、推过行动项也算）时整份替换 Transcript。
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
    if (hasConfirmedEffect(row.outcome) || row.card_confirmed) {
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
