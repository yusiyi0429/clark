import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { THandoverNote, THandoverSecretFinding, TLocalHandoverCheck, TProjectTransfer, TUpdateProjectTransferRequest } from "@warmap/contracts";
import type { HandoverInput, HandoverNoteAgent } from "./handoverNoteAgent.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { CARD_PROJECT, ownProject, projectGoalRows, verdicts } from "./projects.js";
import { shanghaiDate } from "./workdays.js";
import { CardError } from "./taskCards.js";
import { settlementsOf } from "./taskContinuity.js";

/**
 * 项目转交（契约 projectTransfers.ts，设计《新首页》16.7，迁移 246）。
 * 原负责人发起（preparing）→ 发出（sent）→ 接手人接手（accepted）或不接（declined）；没接之前原负责人随时撤回（withdrawn）。
 * 接手：项目换成接手人负责，原负责人以后只读（projects.projectReader 认接手了的转交的 from）；原负责人那边还没被电脑接下的开工登记了结掉；
 * 管线先不自己开子会话（projects.quiet_since），接手人在项目对话里说了第一句就清掉。
 * 交接说明：发起时和存下本机检查结果时，云端调模型按项目对话、目标历史和判定、交付物、本机检查一次写七段（handoverNoteAgent.ts）；
 * 模型没配、出错、超时或写出来像密钥，退回按云端的东西拼的四段（到哪了、没做完的事、代码在哪、可以问谁）。
 */

type TransferRow = { id: string; project_id: string; from_id: string; to_id: string; status: TProjectTransfer["status"]; note: THandoverNote | null;
  include_history: boolean; running: "wait" | "stop" | null; check_choice: "wait" | "skip" | null; check_result: TLocalHandoverCheck | null;
  started_at: Date; decided_at: Date | null; project_name: string; after_sequence: number | null };
const SELECT = "SELECT t.*,t.project_id::text AS project_id,p.name AS project_name FROM project_transfers t JOIN projects p ON p.id=t.project_id";

/** 能拉到别的电脑上的远端：https://、ssh://、git@ 开头的（本地路径、file:// 等不算）。 */
const PULLABLE = /^(https:\/\/|ssh:\/\/|git@)/;
/**
 * 接手人「拉到这台电脑」用的仓库：origin（没有就第一个）远端；分支取 handover/ 开头的（交接分支），没有就当前分支。
 * 不是 git、远端拉不到别的电脑上为 null。远端地址照本机检查结果（本机已去掉口令）。
 */
export function cloneOf(check: TLocalHandoverCheck | null): TProjectTransfer["clone"] {
  const git = check?.git;
  const remote = git ? git.remotes.find((item) => item.name === "origin") ?? git.remotes[0] : undefined;
  if (!git || !remote || !PULLABLE.test(remote.url)) return null;
  const handover = [...git.unpushed.map((item) => item.branch), ...git.branch ? [git.branch] : []].find((branch) => branch.startsWith("handover/"));
  return { repoUrl: remote.url, branch: handover ?? git.branch };
}

export const transferView = (row: TransferRow, names: Map<string, string>): TProjectTransfer => ({
  id: row.id, projectId: row.project_id, projectName: row.project_name,
  from: { personId: row.from_id, name: names.get(row.from_id) ?? row.from_id }, to: { personId: row.to_id, name: names.get(row.to_id) ?? row.to_id },
  status: row.status, startedAt: row.started_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null, includeHistory: row.include_history,
  running: row.running, check: row.check_choice, note: row.note, checkResult: row.check_result, clone: cloneOf(row.check_result),
  afterSequence: row.after_sequence });

/** 这几个项目各自正在转交的那一份（preparing、sent）。 */
export async function openTransfers(q: Query, projectIds: string[]): Promise<Map<string, TransferRow>> {
  if (!projectIds.length) return new Map();
  const rows = (await q(`${SELECT} WHERE t.project_id=ANY($1::uuid[]) AND t.status IN ('preparing','sent')`, [projectIds])).rows as TransferRow[];
  return new Map(rows.map((row) => [row.project_id, row]));
}

/** 本人交出去了的项目（接手了的转交，本人是 from），每个项目取最近一次。 */
export async function handedAway(q: Query, personId: string): Promise<TransferRow[]> {
  return (await q(`SELECT DISTINCT ON (t.project_id) t.*,t.project_id::text AS project_id,p.name AS project_name FROM project_transfers t JOIN projects p ON p.id=t.project_id
    WHERE t.from_id=$1 AND t.status='accepted' AND p.owner_id<>$1 ORDER BY t.project_id,t.decided_at DESC`, [personId])).rows as TransferRow[];
}

/** 一个项目所有接手了的、没接的转交（项目动态的分隔线、交接说明、「X 没接」）。 */
export async function decidedTransfers(q: Query, projectId: string): Promise<TransferRow[]> {
  return (await q(`${SELECT} WHERE t.project_id=$1 AND t.status IN ('accepted','declined') ORDER BY t.decided_at`, [projectId])).rows as TransferRow[];
}

/** 本人能看的一份（原负责人或接手人）；不是 uuid、没有、和本人无关都 404。 */
async function visible(q: Query, personId: string, id: string): Promise<TransferRow> {
  const row = UUID_PATTERN.test(id) ? (await q(`${SELECT} WHERE t.id=$1`, [id])).rows[0] as TransferRow | undefined : undefined;
  if (!row || (row.from_id !== personId && row.to_id !== personId)) throw new CardError(404, "NOT_FOUND", "找不到这份转交");
  return row;
}
const need = (ok: boolean, message: string) => { if (!ok) throw new CardError(409, "TRANSFER_STATE", message); };
const mine = (row: TransferRow, personId: string, side: "from" | "to") => {
  if ((side === "from" ? row.from_id : row.to_id) !== personId) throw new CardError(403, "FORBIDDEN", side === "from" ? "只有原负责人能改" : "只有接手人能操作");
};

/** 模型写不出来时云端拼的那几段（重拼时别的段留着）。 */
const AUTO_SECTIONS = ["到哪了", "没做完的事", "代码在哪", "可以问谁"];
const ORDER = ["到哪了", "没做完的事", "关键决定和原因", "怎么跑起来", "代码在哪", "坑", "可以问谁"];

/** 「代码在哪」：仓库、分支、没提交的、没推完的；不是 git 时最近改过的文件。只写本机检查给的，账号口令本来就不在里面。 */
function codeLines(check: TLocalHandoverCheck | null): string[] {
  if (!check?.folder) return [];
  const git = check.git;
  if (!git) return [`文件夹：${check.folder.label}（不是 git 仓库）`, ...(check.recentFiles ?? []).slice(0, 10).map((file) => `最近改过：${file.path}`)];
  const clone = cloneOf(check);
  return [
    ...clone ? [`仓库：${clone.repoUrl}`] : [`文件夹：${check.folder.label}（没有能拉到别的电脑上的远端）`],
    ...git.branch ? [`当前分支：${git.branch}`] : [],
    ...git.uncommittedCount ? [`没提交的改动 ${git.uncommittedCount} 个文件：${git.uncommitted.slice(0, 10).join("、")}${git.uncommittedCount > 10 ? " 等" : ""}`] : [],
    ...git.unpushed.map((branch) => `没推完：${branch.branch}${branch.ahead ? `（比 ${branch.upstream} 多 ${branch.ahead} 个提交）` : "（没有上游）"}`),
  ];
}

/** 项目里原负责人没做完的卡和专题。 */
const unfinished = async (q: Query, projectId: string, fromId: string) => ((await q(`SELECT title FROM tasks t WHERE t.owner_id=$1 AND ${CARD_PROJECT("t")}=$2
  AND t.status NOT IN ('done','returned') UNION ALL SELECT title FROM research_topics r WHERE r.owner_id=$1 AND ${CARD_PROJECT("r")}=$2 AND r.status='active'`,
[fromId, projectId])).rows as { title: string }[]).map((row) => row.title);

/** 按云端的东西拼那几段：挂着没了结的目标、项目里没做完的卡和专题、本机检查、原负责人；和已有的说明合起来（别的段留着）。 */
async function draftNote(q: Query, row: Pick<TransferRow, "project_id" | "from_id" | "note" | "check_result">, fromName: string): Promise<THandoverNote> {
  const goals = (await q("SELECT task_id,task_name,period FROM project_goals WHERE project_id=$1 ORDER BY period,linked_at", [row.project_id])).rows as
    { task_id: string; task_name: string; period: string }[];
  const settled = await settlementsOf(q, goals.map((goal) => goal.task_id));
  const open = await unfinished(q, row.project_id, row.from_id);
  const monthEnd = (period: string) => { const [y, m] = period.split("-").map(Number); return `${m}/${new Date(Date.UTC(y, m, 0)).getUTCDate()}`; };
  const auto: Record<string, string[]> = {
    "到哪了": goals.filter((goal) => !settled.has(goal.task_id)).map((goal) => `${Number(goal.period.slice(5))} 月目标：${goal.task_name} · ${monthEnd(goal.period)} 验收`),
    "没做完的事": open,
    "代码在哪": codeLines(row.check_result),
    "可以问谁": [fromName],
  };
  const kept = (row.note ?? []).filter((section) => !AUTO_SECTIONS.includes(section.title));
  return ordered([...kept, ...AUTO_SECTIONS.map((title) => ({ title, lines: auto[title] }))].filter((section) => section.lines.length));
}
/** 按 16.7 的段落顺序排（别的标题排在最后，原来的先后不变）。 */
const ordered = (note: THandoverNote): THandoverNote => [...note].sort((a, b) => (ORDER.indexOf(a.title) + 1 || 99) - (ORDER.indexOf(b.title) + 1 || 99));

/** 常见密钥样式（同网页 lib/home/transfer.ts）：只认长得像值的，变量名不算。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
];
export function secretFindings(note: THandoverNote): THandoverSecretFinding[] {
  return note.flatMap((section) => section.lines.flatMap((text, index) => {
    const match = SECRET_PATTERNS.map((pattern) => pattern.exec(text)?.[0]).find(Boolean);
    return match ? [{ section: section.title, line: index + 1, sample: `${match.slice(0, 6)}••••` }] : [];
  }));
}
export class SecretsInNote extends Error { constructor(readonly findings: THandoverSecretFinding[]) { super("交接说明里有像密钥的内容，改掉再发"); } }

/** 写交接说明的模型和读原负责人项目对话的办法（路由给；没给时只拼四段）。 */
export type HandoverWriter = { agent: HandoverNoteAgent; conversation: (projectId: string, fromId: string) => Promise<HandoverInput["conversation"]>; timeoutMs?: number };
export type TransferDeps = { q: Query; pool: Pool; names: Map<string, string>; now: Date; handover?: HandoverWriter;
  /** 这个项目对话现在最后一条消息的 sequence（发起时网页没传 afterSequence 才读）；没有消息、读不到为 null。 */
  lastSequence?: (projectId: string, ownerId: string) => Promise<number | null> };

const HANDOVER_TIMEOUT_MS = 90_000;
/** 对话只给最近的 80 句、每句最多 1500 字。 */
const CONVERSATION_TURNS = 80, TURN_CHARS = 1500;
const VERDICT = { open: "进行中", completed: "确认完成", stopped: "到此为止", continued: "已延续" } as const;

/** 交给模型的材料：目标历史和判定、交付物、没做完的、本机检查、项目对话。 */
async function handoverInput(deps: TransferDeps, row: Pick<TransferRow, "project_id" | "from_id" | "to_id" | "check_result">, project: string): Promise<HandoverInput> {
  const { q, names, now, handover } = deps;
  const goals = await projectGoalRows(q, row.project_id);
  const verdict = await verdicts(q, goals.map((goal) => goal.task_id));
  const deliverables = (await q(`SELECT task_name,number,delivered_at,statement FROM deliverable_versions WHERE project_id=$1 OR task_id=ANY($2::text[])
    ORDER BY created_at`, [row.project_id, goals.map((goal) => goal.task_id)])).rows as { task_name: string; number: number; delivered_at: Date | null; statement: string | null }[];
  const conversation = (await handover!.conversation(row.project_id, row.from_id)).slice(-CONVERSATION_TURNS)
    .map((turn) => ({ ...turn, text: turn.text.slice(0, TURN_CHARS) }));
  return { project, today: shanghaiDate(now), from: names.get(row.from_id) ?? row.from_id, to: names.get(row.to_id) ?? row.to_id,
    goals: goals.map((goal) => ({ period: goal.period, task: goal.task_name, mission: goal.mission_title, verdict: VERDICT[verdict.get(goal.task_id) ?? "open"] })),
    deliverables: deliverables.map((item) => ({ task: item.task_name, number: item.number, deliveredAt: item.delivered_at?.toISOString() ?? null, statement: item.statement })),
    unfinished: await unfinished(q, row.project_id, row.from_id), check: row.check_result, conversation };
}

/** 交模型的说明里有像密钥的：哪一段第几行，让它改成只写名字再交。 */
const secretProblem = (note: THandoverNote) => {
  const findings = secretFindings(note);
  return findings.length ? `这几行像是写了密钥的值，改成只写变量名或去哪要：${findings.map((item) => `「${item.section}」第 ${item.line} 行（${item.sample}）`).join("、")}` : null;
};

/**
 * 写交接说明：有模型就让模型按材料一次写七段（整份换掉）；没配模型、出错、超时，退回按云端的东西拼四段（别的段留着）。
 * 模型交上来的再查一遍密钥样式，还有就当没写出来。
 */
async function composeNote(deps: TransferDeps, row: Pick<TransferRow, "project_id" | "from_id" | "to_id" | "note" | "check_result">, project: string): Promise<THandoverNote> {
  const fromName = deps.names.get(row.from_id) ?? row.from_id;
  if (deps.handover) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.handover.timeoutMs ?? HANDOVER_TIMEOUT_MS);
    try {
      const note = ordered((await deps.handover.agent.write(await handoverInput(deps, row, project), row.project_id, secretProblem, abort.signal))
        .map((section) => ({ title: section.title, lines: section.lines.map((line) => line.trim()).filter(Boolean) })).filter((section) => section.lines.length));
      if (note.length && !secretFindings(note).length) return note;
    } catch { /* 退回拼的四段 */ } finally { clearTimeout(timer); }
  }
  return draftNote(deps.q, row, fromName);
}

/**
 * POST /api/me/projects/:projectId/transfers：项目负责人发起，云端先拼一份交接说明。
 * afterSequence：转交卡排在项目对话哪条消息后面（网页传上来的；没传读这个对话现在最后一条，读不到为 null）。
 */
export async function startTransfer(deps: TransferDeps, fromId: string, projectId: string, toId: string, afterSequence?: number): Promise<TProjectTransfer> {
  const { q, names, now } = deps;
  const project = await ownProject(q, fromId, projectId);
  if (project.scratch) throw new CardError(409, "SCRATCH_PROJECT", "「随手」项目不转交");
  if (project.archived_at) throw new CardError(409, "PROJECT_ARCHIVED", "这个项目已经归档了");
  if (toId === fromId) throw new CardError(400, "INVALID_INPUT", "不能转给自己");
  if (!names.has(toId)) throw new CardError(404, "PERSON_NOT_FOUND", "人员目录里没有这个人");
  const id = randomUUID();
  const after = afterSequence ?? await deps.lastSequence?.(project.id, fromId).catch(() => null) ?? null;
  try {
    await q(`INSERT INTO project_transfers(id,project_id,from_id,to_id,status,started_at,after_sequence) VALUES($1,$2,$3,$4,'preparing',$5,$6)`,
      [id, project.id, fromId, toId, now, after]);
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505") throw new CardError(409, "TRANSFER_OPEN", "这个项目已经在转交了");
    throw cause;
  }
  writeLater(deps, id);
  return transferView(await visible(q, fromId, id), names);
}

/** 正在写的说明：转交 id → 第几次（只认最新那次写的结果）。 */
const writing = new Map<string, number>();
let writes = 0;
/**
 * 在后台写交接说明（发起、存下本机检查结果以后，note 先为 null，写好填上；previous 是变成 null 之前的说明）。
 * 写的过程中本人改了说明（note 不再是 null）、发出或撤回了、又重写了一次，这次写的就不要了。
 */
function writeLater(deps: TransferDeps, id: string, previous: THandoverNote | null = null): void {
  const turn = ++writes;
  writing.set(id, turn);
  void (async () => {
    const row = (await deps.q(`${SELECT} WHERE t.id=$1`, [id])).rows[0] as TransferRow;
    // 模型写不出来时，原来说明里拼的四段以外的段留着。
    const note = await composeNote(deps, { ...row, note: previous }, row.project_name);
    if (writing.get(id) === turn)
      await deps.q(`UPDATE project_transfers SET note=$2::jsonb,status=CASE WHEN send_when_ready AND $3 THEN 'sent' ELSE status END,
        decided_at=CASE WHEN send_when_ready AND $3 THEN $4::timestamptz ELSE decided_at END WHERE id=$1 AND status='preparing' AND note IS NULL`,
      [id, JSON.stringify(note), !secretFindings(note).length, deps.now]);
  })().catch(() => undefined).finally(() => { if (writing.get(id) === turn) writing.delete(id); });
}

/** 读一份：准备中、说明还是空的、又没有在写的（例如写到一半服务重启了），接着写。 */
export async function readTransfer(deps: TransferDeps, personId: string, id: string): Promise<TProjectTransfer> {
  const row = await visible(deps.q, personId, id);
  if (row.status === "preparing" && row.note === null && !writing.has(id)) writeLater(deps, id);
  return transferView(row, deps.names);
}

/** PATCH：原负责人在准备中改（本人按段改完，整份交上来）。存本机检查结果时按材料重写一遍：note 先为 null，后台写好填上。 */
export async function updateTransfer(deps: TransferDeps, personId: string, id: string, patch: TUpdateProjectTransferRequest): Promise<TProjectTransfer> {
  const { q, names } = deps;
  const row = await visible(q, personId, id);
  mine(row, personId, "from");
  need(row.status === "preparing", "发出以后不能再改，先撤回");
  const next = { ...row, note: patch.note ? ordered(patch.note) : row.note, include_history: patch.includeHistory ?? row.include_history,
    running: patch.running === undefined ? row.running : patch.running, check_choice: patch.check === undefined ? row.check_choice : patch.check,
    check_result: patch.checkResult ?? row.check_result };
  if (patch.checkResult) next.note = null;
  await q("UPDATE project_transfers SET note=$2::jsonb,include_history=$3,running=$4,check_choice=$5,check_result=$6::jsonb WHERE id=$1",
    [id, next.note ? JSON.stringify(next.note) : null, next.include_history, next.running, next.check_choice, next.check_result ? JSON.stringify(next.check_result) : null]);
  if (patch.checkResult) writeLater(deps, id, patch.note ? ordered(patch.note) : row.note);
  return transferView(await visible(q, personId, id), names);
}

/** 伙伴（/internal）改交接说明：只在准备中，以原负责人的身份，同本人改。 */
export async function writeNote(deps: TransferDeps, personId: string, id: string, note: THandoverNote): Promise<TProjectTransfer> {
  return updateTransfer(deps, personId, id, { note });
}

/** 发出：说明不能空，像密钥的挡住。 */
export async function sendTransfer(deps: TransferDeps, personId: string, id: string): Promise<TProjectTransfer> {
  const { q, names, now } = deps;
  const row = await visible(q, personId, id);
  mine(row, personId, "from");
  need(row.status === "preparing", "这份已经发出或了结了");
  if (!row.note?.some((section) => section.lines.some((line) => line.trim()))) throw new CardError(400, "EMPTY_NOTE", "交接说明还是空的");
  const findings = secretFindings(row.note);
  if (findings.length) throw new SecretsInNote(findings);
  await q("UPDATE project_transfers SET status='sent',decided_at=$2 WHERE id=$1", [id, now]);
  return transferView(await visible(q, personId, id), names);
}

/** 撤回：原负责人，准备中或已发出。 */
export async function withdrawTransfer(deps: TransferDeps, personId: string, id: string): Promise<TProjectTransfer> {
  const { q, names, now } = deps;
  const row = await visible(q, personId, id);
  mine(row, personId, "from");
  need(row.status === "preparing" || row.status === "sent", "这份已经了结了");
  await q("UPDATE project_transfers SET status='withdrawn',decided_at=$2 WHERE id=$1", [id, now]);
  return transferView(await visible(q, personId, id), names);
}

/** 不接：接手人，已发出。 */
export async function declineTransfer(deps: TransferDeps, personId: string, id: string): Promise<TProjectTransfer> {
  const { q, names, now } = deps;
  const row = await visible(q, personId, id);
  mine(row, personId, "to");
  need(row.status === "sent", "这份不在等你接手");
  await q("UPDATE project_transfers SET status='declined',decided_at=$2 WHERE id=$1", [id, now]);
  return transferView(await visible(q, personId, id), names);
}

/**
 * 接手：一个事务里换负责人（原负责人那边以后只读）、记下等接手人先说一句、了结原负责人那边还没被电脑接下的开工登记（它们会在他的电脑上跑）。
 * 归档着的项目接手后恢复。
 */
export async function acceptTransfer(deps: TransferDeps, personId: string, id: string): Promise<TProjectTransfer> {
  const { pool, names, now } = deps;
  const row = await visible(deps.q, personId, id);
  mine(row, personId, "to");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = (await client.query("SELECT status FROM project_transfers WHERE id=$1 FOR UPDATE", [id])).rows[0] as { status: string };
    need(locked.status === "sent", "这份不在等你接手（可能刚被撤回）");
    await client.query("UPDATE project_transfers SET status='accepted',decided_at=$2 WHERE id=$1", [id, now]);
    await client.query("UPDATE projects SET owner_id=$2,archived_at=NULL,quiet_since=$3,updated_at=$3 WHERE id=$1", [row.project_id, row.to_id, now]);
    await client.query(`UPDATE session_starts s SET closed_at=$3 WHERE s.owner_id=$1 AND s.closed_at IS NULL AND s.claimed_at IS NULL
      AND (EXISTS (SELECT 1 FROM tasks t WHERE t.id=s.card_id AND ${CARD_PROJECT("t")}=$2) OR EXISTS (SELECT 1 FROM research_topics r WHERE r.id=s.topic_id AND ${CARD_PROJECT("r")}=$2))`,
    [row.from_id, row.project_id, now]);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally { client.release(); }
  return transferView(await visible(deps.q, personId, id), names);
}

/** 管线这会儿能不能自己开子会话：发出了还没接手，或接手人还没开口，都不行。 */
export async function projectPaused(q: Query, projectId: string): Promise<boolean> {
  return Boolean((await q(`SELECT 1 FROM projects p WHERE p.id=$1 AND (p.quiet_since IS NOT NULL
    OR EXISTS (SELECT 1 FROM project_transfers t WHERE t.project_id=p.id AND t.status='sent'))`, [projectId])).rowCount);
}

/** 接手人在项目对话里说了一句：管线可以自己开子会话了。 */
export async function ownerSpoke(q: Query, ownerId: string, projectId: string): Promise<void> {
  await q("UPDATE projects SET quiet_since=NULL WHERE id=$1 AND owner_id=$2 AND quiet_since IS NOT NULL", [projectId, ownerId]);
}

export type { TransferRow };
