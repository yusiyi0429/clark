import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { TAgreementPerson, TCheckNotice, TCheckNotifyResponse, TPutTaskAgreementRequest, TReviewBasis, TTaskAgreementResponse, TTaskCheckCriterion,
  TTaskCheckResponse } from "@warmap/contracts";
import type { AgreementSnapshot, StoredReview } from "./deliverableReview.js";
import { FEISHU_NOTIFY_KIND, type FeishuNotice } from "./feishu/notify.js";
import { enqueueJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { locatePlanTask, taskBasis, type PlanTaskAccess, type PlanTaskViewer } from "./planTaskAccess.js";
import type { PlanTask, PlanTaskSource } from "./planTasks.js";
import { DeliverableError } from "./taskDeliverables.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 约定与对表（V1 设计 v0.2 第 2–7 节）。
 * 约定：先读本体（Task definition 块里的 proof / acceptor / exclusions，planTasks.worldAgreementOf），没有再读天枢 11 月的补充（task_agreement_notes），
 * 两样都没有就只有标准原文。补充没有认可状态，负责人和 Mission 负责人能改、留修改记录；basis_hash 对不上就是「标准改过」。
 * 对表：不调模型，把约定和最新一版的参考评审摆在一起看，结论只有两种；「请 X 看」走飞书通知队列，同一条一天一次。
 */

type NoteCriterion = { index: number; text: string; proof: string | null; acceptorId: string | null };
type NoteRow = { task_id: string; basis: string; criteria: NoteCriterion[]; exclusions: string[]; basis_hash: string; updated_by: string; updated_at: Date };
type Resolved = { source: TTaskAgreementResponse["source"]; criteria: NoteCriterion[]; exclusions: string[]; complete: boolean; basisChanged: boolean };

/** 标准文字的摘要：按哪套标准、每条原文，任何一处变了摘要就变。 */
export const basisHash = (basis: TReviewBasis, criteria: string[]) => createHash("sha256").update(JSON.stringify([basis, criteria])).digest("hex");

/**
 * 标准改过以后把补充对回现在的标准，按三遍认：原文一样的；一条包含另一条的（补了几个字）；同一个序号上被改了字的（原文已不在现在的标准里）。
 * 对不上的条算没写。
 */
function align(current: string[], notes: NoteCriterion[]): (NoteCriterion | null)[] {
  const texts = new Set(current);
  const matched: (NoteCriterion | null)[] = current.map(() => null);
  const passes: ((note: NoteCriterion, text: string, index: number) => boolean)[] = [
    (note, text) => note.text === text,
    (note, text) => !texts.has(note.text) && (text.includes(note.text) || note.text.includes(text)),
    (note, _text, index) => note.index === index + 1 && !texts.has(note.text),
  ];
  for (const pass of passes) current.forEach((text, index) => {
    matched[index] ??= notes.find((note) => !matched.includes(note) && pass(note, text, index)) ?? null;
  });
  return matched;
}

/** 按读的顺序定下这个 Task 的约定（纯函数，单个读取和 list_my_items 的汇总共用）。complete：有标准、每条都写了用什么证明。 */
function resolveAgreement(task: PlanTask, basis: TReviewBasis, criteria: string[], note: NoteRow | null): Resolved {
  if (basis === "none") return { source: "none", criteria: [], exclusions: [], complete: false, basisChanged: false };
  const world = task.agreement;
  const aligned = note ? align(criteria, note.criteria) : [];
  const rows = criteria.map((text, index): NoteCriterion => world
    ? { index: index + 1, text, proof: world.proofs[index] ?? null, acceptorId: world.acceptorIds[index] ?? null }
    : { index: index + 1, text, proof: aligned[index]?.proof ?? null, acceptorId: aligned[index]?.acceptorId ?? null });
  return { source: world ? "world" : note ? "tianshu" : "none", criteria: rows, exclusions: world?.exclusions ?? note?.exclusions ?? [],
    complete: rows.every((row) => !!row.proof), basisChanged: !world && !!note && note.basis_hash !== basisHash(basis, criteria) };
}

const NOTE_COLUMNS = "task_id,basis,criteria,exclusions,basis_hash,updated_by,updated_at";

/** 一个 Task 的约定；canEdit 是负责人或 Mission 负责人，约定来自本体或没有标准时不能改。 */
export async function readAgreement(q: Query, access: PlanTaskAccess, names: Map<string, string>): Promise<TTaskAgreementResponse> {
  const { task, basis, criteria } = access;
  const note = basis === "none" || task.agreement ? null
    : (await q(`SELECT ${NOTE_COLUMNS} FROM task_agreement_notes WHERE task_id=$1`, [task.taskId])).rows[0] as NoteRow | undefined ?? null;
  const resolved = resolveAgreement(task, basis, criteria, note);
  const person = (personId: string | null): TAgreementPerson | null => personId ? { personId, name: names.get(personId) ?? personId } : null;
  return { taskId: task.taskId, taskName: task.name, missionId: task.missionId, basis, source: resolved.source,
    criteria: resolved.criteria.map((row) => ({ index: row.index, text: row.text, proof: row.proof, acceptor: person(row.acceptorId) })),
    exclusions: resolved.exclusions, complete: resolved.complete, basisChanged: resolved.basisChanged,
    canEdit: (access.canEdit || access.missionOwner) && resolved.source !== "world" && basis !== "none",
    updatedBy: note ? person(note.updated_by) : null, updatedAt: note?.updated_at.toISOString() ?? null };
}

/** list_my_items 上每个 Task 的两项：几条标准、约定补全了没有。 */
export async function agreementSummaries(q: Query, tasks: PlanTask[]): Promise<Map<string, { criteriaCount: number; agreementComplete: boolean }>> {
  const ids = tasks.filter((task) => !task.agreement && taskBasis(task).basis !== "none").map((task) => task.taskId);
  const notes = new Map(ids.length ? ((await q(`SELECT ${NOTE_COLUMNS} FROM task_agreement_notes WHERE task_id=ANY($1::text[])`, [ids])).rows as NoteRow[])
    .map((row) => [row.task_id, row] as const) : []);
  return new Map(tasks.map((task) => {
    const { basis, criteria } = taskBasis(task);
    return [task.taskId, { criteriaCount: criteria.length, agreementComplete: resolveAgreement(task, basis, criteria, notes.get(task.taskId) ?? null).complete }];
  }));
}

/**
 * 打开一个 Task（约定、对表、交付物的读都走这里）：负责人、Mission 负责人、战场负责人、CEO 和约定里的认可人能看，其余一律当找不到。
 */
export async function openPlanTask(q: Query, planTasks: PlanTaskSource, viewer: PlanTaskViewer, now: Date, taskId: string, names: Map<string, string>):
  Promise<{ access: PlanTaskAccess; agreement: TTaskAgreementResponse }> {
  const access = await locatePlanTask(q, planTasks, viewer, now, taskId);
  const agreement = await readAgreement(q, access, names);
  if (!access.related && !agreement.criteria.some((item) => item.acceptor?.personId === viewer.personId)) throw new DeliverableError(404, "NOT_FOUND", "找不到这个 Task");
  return { access, agreement };
}

/** 传版本时约定的快照（评审照它判）：一条都没写用什么证明、也没写这次不包括什么时为 null。 */
export function agreementSnapshot(agreement: TTaskAgreementResponse): AgreementSnapshot | null {
  if (!agreement.criteria.some((item) => item.proof) && !agreement.exclusions.length) return null;
  return { proofs: agreement.criteria.map((item) => item.proof), exclusions: agreement.exclusions };
}

/**
 * 存 11 月的补充：整份覆盖，按现在的标准逐条记下原文（摘要一起记，之后标准改了就能发现），每存一次留一份修改记录。
 * 没写到的序号算没写；认可人要在人员目录里。
 */
export async function saveAgreement(pool: Pool, access: PlanTaskAccess, agreement: TTaskAgreementResponse, body: TPutTaskAgreementRequest,
  isPerson: (personId: string) => boolean, now: Date): Promise<void> {
  if (access.basis === "none") throw new DeliverableError(409, "NO_CRITERIA", "这个 Task 没有可对照的标准");
  if (agreement.source === "world") throw new DeliverableError(409, "AGREEMENT_FROM_WORLD", "约定已经写进本体，在天枢里不能改");
  if (!agreement.canEdit) throw new DeliverableError(403, "FORBIDDEN", "只有负责人和 Mission 负责人能改约定");
  const byIndex = new Map<number, TPutTaskAgreementRequest["criteria"][number]>();
  for (const item of body.criteria) {
    if (item.index > access.criteria.length || byIndex.has(item.index)) throw new DeliverableError(400, "INVALID_INPUT", `标准有 ${access.criteria.length} 条，每条写一次`);
    if (item.acceptorId && !isPerson(item.acceptorId)) throw new DeliverableError(400, "UNKNOWN_PERSON", "认可人不在人员目录里");
    byIndex.set(item.index, item);
  }
  const criteria: NoteCriterion[] = access.criteria.map((text, index) => ({ index: index + 1, text,
    proof: byIndex.get(index + 1)?.proof?.trim() || null, acceptorId: byIndex.get(index + 1)?.acceptorId ?? null }));
  const exclusions = [...new Set(body.exclusions.map((item) => item.trim()).filter(Boolean))];
  const values = [access.task.taskId, access.basis, JSON.stringify(criteria), exclusions, basisHash(access.basis, access.criteria), access.viewerId, now];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { revision } = (await client.query(`INSERT INTO task_agreement_notes(task_id,basis,criteria,exclusions,basis_hash,revision,updated_by,updated_at)
      VALUES($1,$2,$3::jsonb,$4::text[],$5,1,$6,$7)
      ON CONFLICT (task_id) DO UPDATE SET basis=EXCLUDED.basis,criteria=EXCLUDED.criteria,exclusions=EXCLUDED.exclusions,basis_hash=EXCLUDED.basis_hash,
        revision=task_agreement_notes.revision+1,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at
      RETURNING revision`, values)).rows[0] as { revision: number };
    await client.query(`INSERT INTO task_agreement_note_revisions(task_id,revision,basis,criteria,exclusions,basis_hash,updated_by,updated_at)
      VALUES($1,$8,$2,$3::jsonb,$4::text[],$5,$6,$7)`, [...values, revision]);
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally { client.release(); }
}

type LatestRow = { id: string; number: number; criteria: string[]; review_status: "queued" | "running" | "done" | "failed"; review: StoredReview | null; delivered_at: Date | null };
type ItemRow = { id: string; kind: "file" | "image" | "link"; name: string; url: string | null };

/** 「请 X 看」的去重键：同一个 Task、同一条、同一个人、同一天（公司时区）只推一次。 */
const notifyKey = (taskId: string, index: number, personId: string, day: string) => `${FEISHU_NOTIFY_KIND}:task-check:${taskId}:${index}:${personId}:${day}`;
/** 拆开「请 X 看」的去重键（首页「请你认可」用）：Task id 里可能有冒号，从右往左拆。不是这种键为 null。 */
export function parseNotifyKey(key: string): { taskId: string; index: number; personId: string; day: string } | null {
  const prefix = `${FEISHU_NOTIFY_KIND}:task-check:`;
  if (!key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split(":");
  if (parts.length < 4) return null;
  const [day, personId, index] = [parts.pop()!, parts.pop()!, Number(parts.pop())];
  return Number.isInteger(index) ? { taskId: parts.join(":"), index, personId, day } : null;
}
const STALE_GAP = "这条标准改过，最新一版没按它评，传一版新的再对表";

function basisNotice(agreementStale: boolean, reviewStale: boolean): TCheckNotice | null {
  if (!agreementStale && !reviewStale) return null;
  return { code: "basis_changed", text: agreementStale && reviewStale ? "标准改过：约定和最新一版的评审都是按改之前的标准来的。"
    : agreementStale ? "标准改过：约定是按改之前的标准写的，先对一下约定。" : "标准改过：最新一版是按改之前的标准评的。" };
}

/**
 * 对表：每条按最新一版的参考评审标出结果（标准原文对不上的条算差），顶上一句结论；评审没跑完（排队、在评、失败）的条都标评审中。
 * 有证据、约定写了由别人（不是负责人）认的，标要 X 确认。canNotify 是负责人。
 */
export async function checkTask(q: Query, access: PlanTaskAccess, agreement: TTaskAgreementResponse, now: Date): Promise<TTaskCheckResponse> {
  const base = { taskId: access.task.taskId, source: agreement.source, canNotify: access.canEdit };
  if (access.basis === "none") return { ...base, verdict: "not_ready", conclusion: "还不能交：这个 Task 没有可对照的标准。", notices: [], criteria: [], version: null, beyondScope: [] };
  const latest = (await q(`SELECT id,number,criteria,review_status,review,delivered_at FROM deliverable_versions WHERE task_id=$1 ORDER BY number DESC LIMIT 1`,
    [access.task.taskId])).rows[0] as LatestRow | undefined;
  const items = latest ? (await q("SELECT id,kind,name,url FROM deliverable_items WHERE version_id=$1 ORDER BY position", [latest.id])).rows as ItemRow[] : [];
  // 异议重评时整版是 running，但只有那一条在重评，其余照报告。
  const rechecking = latest?.review_status === "running" && !!latest.review?.criteria.some((item) => item.dissent?.upheld === null);
  const settled = latest?.review_status === "done" || rechecking;
  const used = new Set<number>();
  const reasons = new Map<number, string>();
  const criteria = agreement.criteria.map((item): TTaskCheckCriterion => {
    const row = { index: item.index, text: item.text, proof: item.proof, acceptor: item.acceptor, evidence: null, gap: null, notifiedToday: false };
    if (!latest) return { ...row, status: "no_deliverable" };
    const at = latest.criteria.findIndex((text, index) => !used.has(index) && text === item.text);
    if (at >= 0) used.add(at);
    const reviewed = at >= 0 ? latest.review?.criteria.find((entry) => entry.index === at + 1) : undefined;
    if (!settled || reviewed?.dissent?.upheld === null) return { ...row, status: "reviewing" };
    if (!reviewed) { reasons.set(item.index, "标准改过，没按它评"); return { ...row, status: "gap", gap: STALE_GAP }; }
    if (reviewed.verdict !== "met") { reasons.set(item.index, reviewed.reason); return { ...row, status: "gap", gap: reviewed.fix ?? reviewed.reason }; }
    const named = items.filter((entry) => reviewed.evidence?.includes(entry.name));
    const evidence = { versionId: latest.id, versionNumber: latest.number, locator: reviewed.evidence,
      items: (named.length ? named : items.length === 1 ? items : []).map(({ id, kind, name, url }) => ({ id, kind, name, url })) };
    return { ...row, status: item.acceptor && item.acceptor.personId !== access.ownerId ? "needs_acceptor" : "evidenced", evidence };
  });
  const asking = criteria.filter((item) => item.status === "needs_acceptor");
  if (asking.length) {
    const day = shanghaiDate(now);
    const keys = new Set(((await q("SELECT dedupe_key FROM jobs WHERE dedupe_key=ANY($1::text[])",
      [asking.map((item) => notifyKey(access.task.taskId, item.index, item.acceptor!.personId, day))])).rows as { dedupe_key: string }[]).map((row) => row.dedupe_key));
    for (const item of asking) item.notifiedToday = keys.has(notifyKey(access.task.taskId, item.index, item.acceptor!.personId, day));
  }
  const missing = criteria.filter((item) => item.status !== "evidenced" && item.status !== "needs_acceptor");
  const notices = [basisNotice(agreement.basisChanged, !!latest && JSON.stringify(latest.criteria) !== JSON.stringify(access.criteria))].filter((item) => item !== null);
  if (!agreement.complete) {
    const unwritten = agreement.criteria.filter((item) => !item.proof).map((item) => item.index);
    notices.push({ code: "agreement_incomplete", text: unwritten.length === agreement.criteria.length ? "约定还没补：每条用什么证明都还没写。"
      : `约定还没补全：第 ${unwritten.join("、")} 条没写用什么证明。` });
  }
  return { ...base, verdict: missing.length ? "not_ready" : "ready", conclusion: conclusionOf(criteria, missing, latest, rechecking, reasons), notices, criteria,
    version: latest ? { id: latest.id, number: latest.number, reviewStatus: latest.review_status, deliveredAt: latest.delivered_at?.toISOString() ?? null } : null,
    beyondScope: latest?.review?.beyondScope ?? [] };
}

function conclusionOf(criteria: TTaskCheckCriterion[], missing: TTaskCheckCriterion[], latest: LatestRow | undefined, rechecking: boolean, reasons: Map<number, string>): string {
  if (!missing.length) {
    const byAcceptor = new Map<string, { name: string; indices: number[] }>();
    for (const item of criteria.filter((entry) => entry.status === "needs_acceptor")) {
      const group = byAcceptor.get(item.acceptor!.personId) ?? { name: item.acceptor!.name, indices: [] };
      group.indices.push(item.index);
      byAcceptor.set(item.acceptor!.personId, group);
    }
    const asks = [...byAcceptor.values()].map((group) => `${group.name}确认第 ${group.indices.join("、")} 条`);
    return `约定的 ${criteria.length} 条都有证据了，可以交。${asks.length ? `交之前请${asks.join("，")}。` : ""}再改要重新谈范围。`;
  }
  if (!latest) return "还不能交：还没交付物。";
  if (latest.review_status === "failed") return `还不能交：第 ${latest.number} 版的评审没做完，重评以后再对表。`;
  if (latest.review_status !== "done" && !rechecking) return `还不能交：第 ${latest.number} 版还在评审，评完再对表。`;
  return `还不能交：差${missing.map((item) => `第 ${item.index} 条（${item.status === "reviewing" ? "评审中" : reasons.get(item.index)}）`).join("、")}。`;
}

/**
 * 「请 X 看」：负责人给这一条约定的认可人推一条飞书私聊（谁的哪个 Task、第几条、交付物第几版，带 Task 面板的链接），
 * 走飞书通知队列（feishu/notify.ts，发送用 feishu/messages.ts），同一条一天只推一次。
 */
export async function notifyAcceptor(q: Query, access: PlanTaskAccess, check: TTaskCheckResponse, request: { index: number; personId: string },
  now: Date, names: Map<string, string>, feishuOn: boolean): Promise<TCheckNotifyResponse> {
  if (!access.canEdit) throw new DeliverableError(403, "FORBIDDEN", "只有负责人能请人看");
  const item = check.criteria.find((entry) => entry.index === request.index);
  if (!item) throw new DeliverableError(404, "NOT_FOUND", "没有这一条");
  if (item.acceptor?.personId !== request.personId) throw new DeliverableError(400, "NOT_ACCEPTOR", "这一条约定的认可人不是这个人");
  if (item.status !== "needs_acceptor" || !check.version) throw new DeliverableError(409, "NOT_AWAITING_ACCEPTOR", "这一条还没有证据，先不用请人看");
  if (!feishuOn) throw new DeliverableError(503, "FEISHU_NOT_CONFIGURED", "飞书还没接上，推不了");
  // 认可人没关联飞书时通知队列会直接算完成、什么也不发，这里先说清楚。
  if (!(await q("SELECT 1 FROM feishu_identities WHERE person_id=$1", [request.personId])).rows.length)
    throw new DeliverableError(409, "ACCEPTOR_NOT_ON_FEISHU", `${item.acceptor.name}还没关联飞书，推不了`);
  const task = access.task;
  const owner = names.get(access.ownerId) ?? access.ownerId;
  const notice: FeishuNotice = { personId: request.personId, source: "acceptor", title: `请看「${task.name}」第 ${item.index} 条`.slice(0, 200),
    body: `${owner}的 Task「${task.name}」第 ${item.index} 条约定由你来认：${item.text}\n交付物第 ${check.version.number} 版${item.evidence?.locator ? `，证据在 ${item.evidence.locator}` : ""}。`,
    links: [{ label: "打开 Task", path: `/me?planTask=${encodeURIComponent(task.taskId)}` }] };
  const sent = await enqueueJob(q, { kind: FEISHU_NOTIFY_KIND, dedupeKey: notifyKey(task.taskId, item.index, request.personId, shanghaiDate(now)), payload: notice });
  return { status: sent ? "sent" : "already_sent" };
}
