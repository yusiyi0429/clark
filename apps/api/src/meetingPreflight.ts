import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  PreflightCandidate,
  type TMeetingPreflight,
  type TMeetingPreflightEntry,
  type TMeetingParticipant,
  type TPreflightInputCoverage,
  type TPreflightCandidate,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import {
  LEADER_LENS_FORBIDDEN_PHRASES,
  LEADER_LENS_FORBIDDEN_TEXT,
  LEADER_LENS_MAX,
  LEADER_LENS_MIN,
  MEETING_QUESTION_MAX,
  MEETING_QUESTION_MIN,
  PREFLIGHT_AT_LEAST_ONE_KINDS,
  PREFLIGHT_EXACTLY_ONE_KINDS,
} from "./promptRules.js";
import {
  appendFingerprint,
  commit,
  getMeetingRow,
  projectMeetingCard,
  updateMeeting,
  withMeetingLock,
  type MeetingActionOutcome,
  type Query,
} from "./meetingStore.js";

const PREFLIGHT_AGENT_FAILED = "preflight_agent_failed";
const INVALID_PREFLIGHT_CANDIDATE = "invalid_preflight_candidate";
const INVALID_SOURCE_REF = "invalid_source_ref";
export const PREFLIGHT_INTERRUPTED = "preflight_interrupted";
/** 与 Chat 单 turn 相同的超时保护；预审在请求路径内同步运行。 */
const PREFLIGHT_TIMEOUT_MS = 180_000;
export type PreflightAgentInput = {
  meeting: { id: string; title: string; scheduledAt: string; participants: TMeetingParticipant[] };
  issues: { id: string; title: string; location: unknown; urgency: unknown; research: unknown }[];
  materials: { id: string; fileName: string; mimeType: string; extractedText: string; sourceRef: string }[];
  inputCoverage: TPreflightInputCoverage;
  relatedMeeting: {
    id: string;
    title: string;
    status: "held" | "reviewed";
    scheduledAt: string;
    transcript: unknown;
    outcome: unknown;
    sourceRefs: string[];
  } | null;
};

export type PreflightAgent = {
  promptHash?: string;
  modelSlot?: "light" | "heavy";
  generate(input: PreflightAgentInput, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};
export async function executeRunPreflight(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled" || row.preflight.status !== "pending") {
      return { error: { status: 409, code: "MEETING_PREFLIGHT_NOT_PENDING", message: "只有 pending 的 scheduled Meeting 可以运行预审" } };
    }
    const updated = await updateMeeting(client, row.id, "version = version + 1, action_fingerprints = $2::jsonb", [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))]);
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;
  await runPreflight(pool, companyMemory, preflightAgent, scope.objectId);
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}
async function executeExplicitPreflight(
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  expectedStatus: "failed" | "ready",
): Promise<MeetingActionOutcome> {
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以运行预审" } };
    if (row.preflight.status !== expectedStatus) {
      return { error: {
        status: 409,
        code: expectedStatus === "failed" ? "MEETING_PREFLIGHT_NOT_FAILED" : "MEETING_PREFLIGHT_NOT_READY",
        message: expectedStatus === "failed" ? "只有失败的预审可以显式重试" : "只有已完成的预审可以重新生成",
      } };
    }
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

export const executeRetryPreflight = (
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
) => executeExplicitPreflight(pool, companyMemory, preflightAgent, secret, scope, fingerprint, "failed");

export const executeRegeneratePreflight = (
  pool: Pool,
  companyMemory: CompanyMemoryRepository,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
) => executeExplicitPreflight(pool, companyMemory, preflightAgent, secret, scope, fingerprint, "ready");
type IssueSnapshotRow = { id: string; title: string; location: unknown; urgency: unknown; research: unknown };
type RelatedMeetingSnapshotRow = {
  id: string;
  title: string;
  status: "held" | "reviewed";
  scheduled_at: Date;
  transcript: unknown;
  outcome: unknown;
};

function preflightStructureError(candidate: TPreflightCandidate): string | null {
  const count = (kind: TPreflightCandidate["entries"][number]["kind"]) =>
    candidate.entries.filter((entry) => entry.kind === kind).length;
  for (const kind of PREFLIGHT_EXACTLY_ONE_KINDS) {
    if (count(kind) !== 1) return `${kind} 必须恰好 1 条`;
  }
  for (const kind of PREFLIGHT_AT_LEAST_ONE_KINDS) {
    if (count(kind) < 1) return `${kind} 至少需要 1 条`;
  }
  const questions = count("meeting_question");
  if (questions < MEETING_QUESTION_MIN || questions > MEETING_QUESTION_MAX) {
    return `meeting_question 必须为 ${MEETING_QUESTION_MIN}–${MEETING_QUESTION_MAX} 条`;
  }
  const lenses = candidate.entries.filter((entry) => entry.kind === "leader_lens");
  if (lenses.length < LEADER_LENS_MIN || lenses.length > LEADER_LENS_MAX) {
    return `leader_lens 必须为 ${LEADER_LENS_MIN}–${LEADER_LENS_MAX} 条`;
  }
  for (const lens of lenses) {
    if (LEADER_LENS_FORBIDDEN_PHRASES.some((phrase) => lens.body.includes(phrase))) {
      return `leader_lens 不得出现${LEADER_LENS_FORBIDDEN_TEXT}`;
    }
  }
  if (candidate.taskDefinition.secondaryRole === candidate.taskDefinition.primaryRole) {
    return "secondaryRole 不能与 primaryRole 相同";
  }
  return null;
}

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
    const relatedResult = await q(
      `SELECT id, title, status, scheduled_at, transcript, outcome
         FROM meetings
        WHERE id <> $1
          AND status IN ('held', 'reviewed')
          AND issue_ids ?| $2::text[]
        ORDER BY scheduled_at DESC
        LIMIT 1`,
      [meeting.id, meeting.issue_ids],
    );
    const relatedRow = relatedResult.rows[0] as RelatedMeetingSnapshotRow | undefined;
    const relatedMeeting: PreflightAgentInput["relatedMeeting"] = relatedRow
      ? {
          id: relatedRow.id,
          title: relatedRow.title,
          status: relatedRow.status,
          scheduledAt: relatedRow.scheduled_at.toISOString(),
          transcript: relatedRow.transcript,
          outcome: relatedRow.outcome,
          sourceRefs: [
            `meeting:${relatedRow.id}`,
            ...(relatedRow.transcript ? [`transcript:${relatedRow.id}`] : []),
            ...(relatedRow.outcome ? [`outcome:${relatedRow.id}`] : []),
          ],
        }
      : null;
    const hasResearch = issues.some((issue) => Boolean(issue.research && (issue.research as { doc?: unknown }).doc));
    const inputCoverage: TPreflightInputCoverage = {
      background: issues.length > 0 ? "available" : "missing",
      purpose: "derived",
      sourceMaterial: hasResearch || meeting.materials.length > 0 ? "available" : "missing",
      relatedMeeting: relatedMeeting ? "available" : "missing",
    };

    // CEO 已上传会前材料时，预审源材料以新材料为准：Issue 只保留标题等基本事实，
    // 不再注入旧 ResearchDoc，避免预审锚定过期研究结论。
    const useUploadedMaterials = meeting.materials.length > 0;
    const allowedSourceRefs = new Set<string>([
      `meeting:${meeting.id}`,
      ...issues.map((issue) => `issue:${issue.id}`),
    ]);
    for (const material of meeting.materials) allowedSourceRefs.add(`material:${material.id}`);
    for (const section of companyMemory.listSections()) allowedSourceRefs.add(`memory:${section.id}`);
    for (const ref of relatedMeeting?.sourceRefs ?? []) allowedSourceRefs.add(ref);
    for (const issue of issues) {
      if (!useUploadedMaterials && issue.research && (issue.research as { doc?: unknown }).doc) allowedSourceRefs.add(`research:${issue.id}`);
    }

    const input: PreflightAgentInput = {
      meeting: { id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduled_at.toISOString(), participants: meeting.participants },
      issues: issues.map((issue) => ({ id: issue.id, title: issue.title, location: issue.location, urgency: issue.urgency, research: useUploadedMaterials ? null : issue.research })),
      materials: meeting.materials.map((material) => ({ id: material.id, fileName: material.fileName, mimeType: material.mimeType, extractedText: material.extractedText, sourceRef: `material:${material.id}` })),
      inputCoverage,
      relatedMeeting,
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
    const structureError = preflightStructureError(generated.candidate);
    if (structureError) {
      await fail(INVALID_PREFLIGHT_CANDIDATE, structureError);
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
        inputCoverage,
        taskDefinition: generated.candidate.taskDefinition,
        readiness: generated.candidate.readiness,
        summary: generated.candidate.summary,
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
