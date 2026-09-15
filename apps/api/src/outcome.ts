import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PostMeetingCandidate,
  type TMeetingOutcomeItem,
  type TMeetingOutcomeState,
  type TMeetingParticipant,
  type TOutcomeWarning,
  type TTranscriptTurn,
  type TWarmapTranscript,
  WarmapTranscript,
} from "@warmap/contracts";

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

/** 只有 confirmed 的 item 才能真正阻止替换；pending/dismissed 不算已生效效果。 */
export function hasConfirmedEffect(outcome: TMeetingOutcomeState | null): boolean {
  return outcome?.items.some((item) => item.review?.status === "confirmed" || item.review?.effectRef != null) ?? false;
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
  status: string;
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
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND outcome->>'runId' = $2`,
      [meetingId, runId, assessed.summary, JSON.stringify(assessed.items), JSON.stringify(assessed.warnings), new Date().toISOString()],
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
