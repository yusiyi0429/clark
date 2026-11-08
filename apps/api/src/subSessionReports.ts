import type { TLocalPermissionBrief, TLocalQuestionRequestView, TLocalSessionStatus, TProjectSubSessionDecisionItem, TProjectSubSessionReportItem } from "@warmap/contracts";
import { SUB_SESSION_REPORT_PREFIX } from "@warmap/contracts";
import { randomUUID } from "node:crypto";
import type { Query } from "./meetingStore.js";
import type { RunAsk } from "./localDevices.js";
import { lettersFor, subProject, type SubKind } from "./subSessionLetters.js";

/**
 * 子会话停了、要人介入，报进它所在项目的对话（18 节第 10 条，契约 projects.ts 的 sub_session_report / sub_session_decision）。
 * 本机同步来的 status 条目落下时（localSync.ts，同一个事务）按前后状态记：
 * - 停了：之前在干（开工、在做、等批准，或在问你），现在做完一轮停下（idle 不带提问、done）、被停下（exited）、出错停住（failed）。记一条报告；
 *   提交以后调用方补上 afterSequence，再替本人给项目主管线发一句（reportTurnText），让它回一小轮。
 * - 要介入：idle 带提问、waiting_permission 带那一步，记一张决定卡（同一次只记一张）；不触发模型。之后的 status 不再是这一次时，那张关掉。
 * 只报卡和专题；规划员、验收员不报。不在项目里的子会话不报。
 */

const ACTIVE_BEFORE = new Set(["starting", "running", "waiting_permission"]);
const OUTCOME_TEXT = { round_done: "做完一轮停下了", stopped: "被停下了", failed: "出错停住了" } as const;
type Outcome = keyof typeof OUTCOME_TEXT;
const SUMMARY_MAX = 600;

export type StatusRun = { id: string; kind: "card" | "topic" | "plan" | "verify"; task_id: string | null; topic_id: string | null; device_id: string;
  state: string; ask: RunAsk | null };
export type StatusChange = { status: TLocalSessionStatus; question?: TLocalQuestionRequestView; permission?: TLocalPermissionBrief; summary?: string };

/** 这条 status 落下以后：记下的报告、决定卡的 id（没有为 undefined）。 */
export async function recordSubSessionStatus(q: Query, ownerId: string, run: StatusRun, change: StatusChange, at: Date): Promise<{ report?: string; decision?: string }> {
  if (run.kind !== "card" && run.kind !== "topic") return {};
  const kind: SubKind = run.kind;
  const subjectId = (kind === "card" ? run.task_id : run.topic_id)!;
  const ask = change.status === "idle" && change.question ? { kind: "question" as const, request: change.question }
    : change.status === "waiting_permission" && change.permission ? { kind: "permission" as const, request: change.permission } : null;
  // 不再是这一次的：关掉。
  await q("UPDATE sub_session_decisions SET status='closed',closed_at=$3 WHERE run_id=$1 AND status='open' AND request_id IS DISTINCT FROM $2",
    [run.id, ask?.request.requestId ?? null, at]);
  const outcome: Outcome | null = change.status === "exited" ? "stopped" : change.status === "failed" ? "failed"
    : change.status === "done" || (change.status === "idle" && !change.question) ? "round_done" : null;
  const wasWorking = ACTIVE_BEFORE.has(run.state) || (run.state === "idle" && run.ask?.kind === "question");
  if (!ask && !(outcome && wasWorking)) return {};
  const projectId = await subProject(q, kind, subjectId);
  if (!projectId) return {};
  const letter = (await lettersFor(q, [{ projectId, kind, id: subjectId }])).get(`${kind}:${subjectId}`);
  const title = (await q(`SELECT title FROM ${kind === "card" ? "tasks" : "research_topics"} WHERE id=$1`, [subjectId])).rows[0]?.title as string | undefined;
  if (!letter || title === undefined) return {};
  if (ask) {
    const id = (await q(`INSERT INTO sub_session_decisions(id,owner_id,project_id,kind,subject_id,letter,title,run_id,device_id,request_id,ask,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT (run_id,request_id) DO NOTHING RETURNING id::text`,
    [randomUUID(), ownerId, projectId, kind, subjectId, letter, title, run.id, run.device_id, ask.request.requestId, JSON.stringify(ask), at])).rows[0]?.id as string | undefined;
    return id ? { decision: id } : {};
  }
  const id = randomUUID();
  await q(`INSERT INTO sub_session_reports(id,owner_id,project_id,kind,subject_id,letter,title,run_id,outcome,summary,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, ownerId, projectId, kind, subjectId, letter, title, run.id, outcome, await summaryOf(q, kind, run.id, change.summary), at]);
  return { report: id };
}

/** 一两句摘要：本机在 status 上报了就用它；没报时卡取这次执行最近一次交回的说明，专题取这次执行最近一版的「改了什么」。都没有为 null。 */
async function summaryOf(q: Query, kind: SubKind, runId: string, reported: string | undefined): Promise<string | null> {
  const text = reported?.trim() || ((kind === "card"
    ? (await q("SELECT summary AS text FROM card_handbacks WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId])).rows[0]?.text
    : (await q("SELECT note AS text FROM topic_versions WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1", [runId])).rows[0]?.text) as string | null | undefined)?.trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/** 记下以后补上项目对话当时最后一条消息的 sequence（读不到留 null）。 */
export async function setAfterSequence(q: Query, table: "sub_session_reports" | "sub_session_decisions", id: string, sequence: number | null): Promise<void> {
  if (sequence !== null) await q(`UPDATE ${table} SET after_sequence=$2 WHERE id=$1 AND after_sequence IS NULL`, [id, sequence]);
}

type ReportRow = { id: string; owner_id: string; project_id: string; kind: SubKind; subject_id: string; letter: string; title: string; outcome: Outcome;
  summary: string | null; after_sequence: number | null; created_at: Date };
type DecisionRow = { id: string; kind: SubKind; subject_id: string; letter: string; title: string; run_id: string; device_id: string; ask: RunAsk;
  status: "open" | "closed"; after_sequence: number | null; created_at: Date; closed_at: Date | null };

export async function readReport(q: Query, id: string): Promise<ReportRow | null> {
  return ((await q("SELECT *,project_id::text,subject_id::text FROM sub_session_reports WHERE id=$1", [id])).rows[0] ?? null) as ReportRow | null;
}

/** 替本人给项目主管线发的那一句：开头 SUB_SESSION_REPORT_PREFIX，说哪个子会话、怎么停的、做成了什么，请它回一小轮。 */
export function reportTurnText(report: Pick<ReportRow, "letter" | "title" | "outcome" | "summary">): string {
  return `${SUB_SESSION_REPORT_PREFIX}${report.letter} · ${report.title}：${OUTCOME_TEXT[report.outcome]}。${report.summary ? `它说：${report.summary}` : ""}\n`
    + "请用一两句话告诉本人这意味着什么、下一步怎么办；要本人拿主意时讲清选项，只问一个问题。";
}

/** 项目动态里的报告和决定卡（这个项目的；谁能看由调用方核对）。 */
export async function projectNotices(q: Query, projectId: string): Promise<(TProjectSubSessionReportItem | TProjectSubSessionDecisionItem)[]> {
  const reports = (await q("SELECT *,subject_id::text FROM sub_session_reports WHERE project_id=$1 ORDER BY created_at,id", [projectId])).rows as ReportRow[];
  const decisions = (await q("SELECT *,subject_id::text,run_id::text,device_id::text FROM sub_session_decisions WHERE project_id=$1 ORDER BY created_at,id",
    [projectId])).rows as DecisionRow[];
  return [
    ...reports.map((row): TProjectSubSessionReportItem => ({ kind: "sub_session_report", id: row.id, at: row.created_at.toISOString(), afterSequence: row.after_sequence,
      sub: { kind: row.kind, id: row.subject_id, letter: row.letter, title: row.title }, outcome: row.outcome, summary: row.summary })),
    ...decisions.map((row): TProjectSubSessionDecisionItem => ({ kind: "sub_session_decision", id: row.id, at: row.created_at.toISOString(), afterSequence: row.after_sequence,
      sub: { kind: row.kind, id: row.subject_id, letter: row.letter, title: row.title }, sessionId: row.run_id, deviceId: row.device_id,
      question: row.ask.kind === "question" ? row.ask.request : null, permission: row.ask.kind === "permission" ? row.ask.request : null,
      status: row.status, closedAt: row.closed_at?.toISOString() ?? null })),
  ];
}
