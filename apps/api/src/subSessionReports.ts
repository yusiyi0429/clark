import type { TLocalPermissionBrief, TLocalQuestionRequestView, TLocalSessionStatus, TLocalStopReason, TLocalStopReport, TProjectSubSessionDecisionItem,
  TProjectSubSessionReportItem } from "@warmap/contracts";
import { randomUUID } from "node:crypto";
import type { Query } from "./meetingStore.js";
import type { RunAsk } from "./localDevices.js";
import { lettersFor, subProject, type SubKind } from "./subSessionLetters.js";

/**
 * 子会话停了、要人介入，报进它所在项目的对话（18 节第 10 条，契约 projects.ts 的 sub_session_report / sub_session_decision）。
 * 在本机同步来的条目落下时记（localSync.ts，同一个事务）：
 * - 停了：同步条目 stopped（LocalStopReport），每停一次一条报告。提交以后调用方补上 afterSequence。不触发模型（主循环第 63 条）。
 * - 要介入：status 条目 idle 带提问、waiting_permission 带那一步，记一张决定卡；同一次（同一个 requestId）只一张，内容变了更新那一张，不触发模型。
 *   之后的 status 不再是这一次时，那张关掉。
 * 只报卡和专题；规划员、验收员不报。不在项目里的子会话不报。
 */

export type SyncRun = { id: string; kind: "card" | "topic" | "plan" | "verify"; task_id: string | null; topic_id: string | null; device_id: string };
export type StatusChange = { status: TLocalSessionStatus; question?: TLocalQuestionRequestView; permission?: TLocalPermissionBrief };

/** 卡或专题在哪个项目、字母和标题；不是卡或专题、不在项目里为 null。 */
async function subject(q: Query, run: SyncRun): Promise<{ kind: SubKind; id: string; projectId: string; letter: string; title: string } | null> {
  if (run.kind !== "card" && run.kind !== "topic") return null;
  const kind: SubKind = run.kind;
  const id = (kind === "card" ? run.task_id : run.topic_id)!;
  const projectId = await subProject(q, kind, id);
  if (!projectId) return null;
  const letter = (await lettersFor(q, [{ projectId, kind, id }])).get(`${kind}:${id}`);
  const title = (await q(`SELECT title FROM ${kind === "card" ? "tasks" : "research_topics"} WHERE id=$1`, [id])).rows[0]?.title as string | undefined;
  return letter && title !== undefined ? { kind, id, projectId, letter, title } : null;
}

/** status 条目落下以后：在问、在等批准时记（或更新）决定卡，不再是那一次的关掉。新记的决定卡 id（没有为 undefined）。 */
export async function recordSubSessionStatus(q: Query, ownerId: string, run: SyncRun, change: StatusChange, at: Date): Promise<{ decision?: string }> {
  if (run.kind !== "card" && run.kind !== "topic") return {};
  const ask = change.status === "idle" && change.question ? { kind: "question" as const, request: change.question }
    : change.status === "waiting_permission" && change.permission ? { kind: "permission" as const, request: change.permission } : null;
  await q("UPDATE sub_session_decisions SET status='closed',closed_at=$3 WHERE run_id=$1 AND status='open' AND request_id IS DISTINCT FROM $2",
    [run.id, ask?.request.requestId ?? null, at]);
  if (!ask) return {};
  const sub = await subject(q, run);
  if (!sub) return {};
  const row = (await q(`INSERT INTO sub_session_decisions(id,owner_id,project_id,kind,subject_id,letter,title,run_id,device_id,request_id,ask,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
    ON CONFLICT (run_id,request_id) DO UPDATE SET ask=EXCLUDED.ask WHERE sub_session_decisions.status='open'
    RETURNING id::text,(xmax=0) AS inserted`,
  [randomUUID(), ownerId, sub.projectId, sub.kind, sub.id, sub.letter, sub.title, run.id, run.device_id, ask.request.requestId, JSON.stringify(ask), at])).rows[0] as
    { id: string; inserted: boolean } | undefined;
  return row?.inserted ? { decision: row.id } : {};
}

/**
 * 本机截摘要时把没标点结尾的行补「；」再接起来，冒号、逗号、顿号结尾的行也补了，拼成「三件事都做完了：；已删除…」。
 * 存和读的时候都去掉标点后面多出来的那个「；」（读的时候顺带修好已经存下的）。
 */
const tidySummary = (text: string | null) => text?.replace(/([：:，,、])\s*[；;]/g, "$1") ?? null;

/** stopped 条目落下以后：卡或专题在项目里的，记一条报告。报告 id（没记为 undefined）。 */
export async function recordStopReport(q: Query, ownerId: string, run: SyncRun, report: TLocalStopReport, at: Date): Promise<{ report?: string }> {
  const sub = await subject(q, run);
  if (!sub) return {};
  const id = randomUUID();
  await q(`INSERT INTO sub_session_reports(id,owner_id,project_id,kind,subject_id,letter,title,run_id,why,summary,blocker,outputs,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
  [id, ownerId, sub.projectId, sub.kind, sub.id, sub.letter, sub.title, run.id, report.why, tidySummary(report.summary), report.blocker, JSON.stringify(report.outputs), at]);
  return { report: id };
}

/** 记下以后补上项目对话当时最后一条消息的 sequence（读不到留 null）。 */
export async function setAfterSequence(q: Query, table: "sub_session_reports" | "sub_session_decisions", id: string, sequence: number | null): Promise<void> {
  if (sequence !== null) await q(`UPDATE ${table} SET after_sequence=$2 WHERE id=$1 AND after_sequence IS NULL`, [id, sequence]);
}

type StoredOutput = TLocalStopReport["outputs"][number];
type ReportRow = { id: string; owner_id: string; project_id: string; kind: SubKind; subject_id: string; letter: string; title: string; why: TLocalStopReason;
  summary: string | null; blocker: string | null; outputs: StoredOutput[]; after_sequence: number | null; created_at: Date };
type DecisionRow = { id: string; kind: SubKind; subject_id: string; letter: string; title: string; run_id: string; device_id: string; ask: RunAsk;
  status: "open" | "closed"; after_sequence: number | null; created_at: Date; closed_at: Date | null };

export async function readReport(q: Query, id: string): Promise<ReportRow | null> {
  return ((await q("SELECT *,project_id::text,subject_id::text FROM sub_session_reports WHERE id=$1", [id])).rows[0] ?? null) as ReportRow | null;
}

/** 项目动态里的报告和决定卡（这个项目的；谁能看由调用方核对）。报告里的产出物按 artifact 条目的 key 对上云端收下的那件。 */
export async function projectNotices(q: Query, projectId: string): Promise<(TProjectSubSessionReportItem | TProjectSubSessionDecisionItem)[]> {
  const reports = (await q("SELECT *,subject_id::text FROM sub_session_reports WHERE project_id=$1 ORDER BY created_at,id", [projectId])).rows as ReportRow[];
  const keys = reports.flatMap((row) => row.outputs.map((output) => output.key));
  const outputIds = new Map(keys.length ? ((await q("SELECT client_id,id::text FROM local_outputs WHERE client_id=ANY($1::text[])", [keys])).rows as
    { client_id: string; id: string }[]).map((row) => [row.client_id, row.id]) : []);
  const decisions = (await q("SELECT *,subject_id::text,run_id::text,device_id::text FROM sub_session_decisions WHERE project_id=$1 ORDER BY created_at,id",
    [projectId])).rows as DecisionRow[];
  return [
    ...reports.map((row): TProjectSubSessionReportItem => ({ kind: "sub_session_report", id: row.id, at: row.created_at.toISOString(), afterSequence: row.after_sequence,
      sub: { kind: row.kind, id: row.subject_id, letter: row.letter, title: row.title }, why: row.why, summary: tidySummary(row.summary), blocker: row.blocker,
      outputs: row.outputs.map((output) => ({ outputId: outputIds.get(output.key) ?? null, title: output.title, fileName: output.fileName })) })),
    ...decisions.map((row): TProjectSubSessionDecisionItem => ({ kind: "sub_session_decision", id: row.id, at: row.created_at.toISOString(), afterSequence: row.after_sequence,
      sub: { kind: row.kind, id: row.subject_id, letter: row.letter, title: row.title }, sessionId: row.run_id, deviceId: row.device_id,
      question: row.ask.kind === "question" ? row.ask.request : null, permission: row.ask.kind === "permission" ? row.ask.request : null,
      status: row.status, closedAt: row.closed_at?.toISOString() ?? null })),
  ];
}
