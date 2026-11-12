import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DONE_DEFINITION_LIMITS, type TCardAgreement, type TCardAgreementChange, type TCardAgreementView, type TLocalAgreementProposal,
  type TLocalCardAgreementResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { CardError } from "./taskCards.js";
import { taskStandards } from "./tasks.js";

/**
 * 卡的约定（主循环第 60 条）：交代 + 完成标准，依据只有云端卡上这一份（tasks.brief、tasks.done_definition），版本号 tasks.agreement_revision。
 * 三个入口都走 writeAgreement：本人在会话详情里改（PATCH 卡、老路 PATCH 执行事项）、项目管线的 update_card、本人接受执行方的提议。
 * 改了以后：版本号加 1、记一条修改记录；执行方在跑时登记一条转话（SessionCommand message，带 agreementRevision）把新标准全文告诉它。
 * 第二道保证在本机：交回前取 GET /api/local-runner/card-agreement 核对版本号。
 */

export type AgreementBy = { kind: "person" | "pipeline" | "worker"; name: string | null };
type AgreementRow = { id: string; owner_id: string; status: string; brief: string | null; done_definition: string | null; agreement_revision: number };

/** 本人改的、管线改的，只在执行方正在干活时转告（停着、交回在验收的，交回前本机会核对）；执行方提议的结果总要告诉它。 */
const WORKING = new Set(["starting", "running", "waiting_permission"]);
const COMMAND_MAX = 4000;

const agreementOf = (row: Pick<AgreementRow, "brief" | "done_definition">): TCardAgreement => ({ brief: row.brief, standards: taskStandards(row.done_definition) });

/** 新的完成标准整份：去掉空条，每条、整份照 DONE_DEFINITION_LIMITS，超了 400 TOO_LONG；一条都没有 400。返回存进 done_definition 的文字。 */
export function standardsText(standards: string[]): string {
  const lines = standards.map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new CardError(400, "INVALID_INPUT", "至少要有一条完成标准");
  const long = lines.findIndex((line) => line.length > DONE_DEFINITION_LIMITS.line);
  if (long >= 0) throw new CardError(400, "TOO_LONG", `完成标准第 ${long + 1} 条超过 ${DONE_DEFINITION_LIMITS.line} 字，写短一些`);
  const text = lines.join("\n");
  if (text.length > DONE_DEFINITION_LIMITS.total) throw new CardError(400, "TOO_LONG", `完成标准合起来超过 ${DONE_DEFINITION_LIMITS.total} 字，写短一些`);
  return text;
}

/** 告诉执行方「约定改了」的那句话：新的完成标准全文，交代改了也附上；超过转话的上限时截短交代。 */
function changeText(revision: number, after: TCardAgreement, briefChanged: boolean, reason: string | null): string {
  const head = [`卡的约定改了（第 ${revision} 版）${reason ? `，原因：${reason}` : ""}。按新的做，交回时逐条对新的完成标准自评。`, "新的完成标准：",
    ...after.standards.map((text, index) => `${index + 1}. ${text}`)].join("\n");
  if (!briefChanged) return head;
  const brief = `\n新的交代：\n${after.brief ?? "（不写交代了）"}`;
  return head.length + brief.length <= COMMAND_MAX ? head + brief : `${head}${brief.slice(0, COMMAND_MAX - head.length - 1)}…`;
}

/** 给这张卡最近一次本机会话登记一条转话（由那台电脑上开着的网页认领后说给执行方）。always = false 时只在执行方正在干活时登记。 */
async function tellExecutor(q: Query, ownerId: string, cardId: string, text: string, revision: number | null, now: Date, always: boolean): Promise<void> {
  const run = (await q("SELECT id::text,device_id::text,state FROM local_runs WHERE task_id=$1 AND kind='card' ORDER BY started_at DESC,id LIMIT 1", [cardId])).rows[0] as
    { id: string; device_id: string; state: string } | undefined;
  if (!run || (!always && !WORKING.has(run.state))) return;
  const command = { type: "message", text, ...(revision !== null ? { agreementRevision: revision } : {}) };
  await q(`INSERT INTO session_commands(id,owner_id,kind,card_id,topic_id,run_id,device_id,command,requested_at) VALUES($1,$2,'card',$3,NULL,$4,$5,$6::jsonb,$7)`,
    [randomUUID(), ownerId, cardId, run.id, run.device_id, JSON.stringify(command), now]);
}

/**
 * 改卡的约定。row 是卡改之前的样子（调用方读的，事务里的已锁住）；next 里不带的那一样不变。交代和完成标准都和原来一样时什么都不做，回 null。
 * 用版本号兜并发：期间别人先改了，回 409 AGREEMENT_CONFLICT（重读再改）。返回改完以后的版本号。
 * 只动约定和版本号；tasks.version 由调用方决定（PATCH 卡自己加），这里不加。
 */
export async function writeAgreement(q: Query, row: AgreementRow, next: { brief?: string | null; standards?: string[] }, by: AgreementBy, reason: string | null,
  now: Date, tellAlways = false): Promise<number | null> {
  const before = agreementOf(row);
  const brief = next.brief === undefined ? row.brief : next.brief?.trim() || null;
  const doneDefinition = next.standards === undefined ? row.done_definition : standardsText(next.standards);
  const after = agreementOf({ brief, done_definition: doneDefinition });
  const briefChanged = brief !== row.brief;
  if (!briefChanged && JSON.stringify(after.standards) === JSON.stringify(before.standards)) return null;
  if (row.status === "done") throw new CardError(409, "CARD_DONE", "这张卡已经完成了，约定不能再改");
  const revision = row.agreement_revision + 1;
  const updated = await q("UPDATE tasks SET brief=$2,done_definition=$3,agreement_revision=$4,updated_at=now() WHERE id=$1 AND agreement_revision=$5",
    [row.id, brief, doneDefinition, revision, row.agreement_revision]);
  if (!updated.rowCount) throw new CardError(409, "AGREEMENT_CONFLICT", "卡的约定刚被改过，重读以后再改");
  await q(`INSERT INTO card_agreement_changes(id,card_id,owner_id,revision,by_kind,by_name,agreement_before,agreement_after,reason,at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
  [randomUUID(), row.id, row.owner_id, revision, by.kind, by.name, JSON.stringify(before), JSON.stringify(after), reason, now]);
  await tellExecutor(q, row.owner_id, row.id, changeText(revision, after, briefChanged, reason), revision, now, tellAlways);
  return revision;
}

const BY_TEXT = { person: "本人直接改", worker: "本人确认执行方的提议", pipeline: "伙伴改的" } as const;

/**
 * 验收交代里的「约定后来改过」（跟在本人原话后面）：每次第几版、谁改的、原因，旧的在前。本人改过或确认过的，原话和新约定冲突的地方以新约定为准；
 * 只有伙伴改的那几次照列，不适用这句。没改过为空。
 */
export async function agreementChangeLines(q: Query, cardId: string): Promise<string[]> {
  const rows = (await q("SELECT revision,by_kind,reason FROM card_agreement_changes WHERE card_id=$1 ORDER BY revision", [cardId])).rows as
    { revision: number; by_kind: AgreementBy["kind"]; reason: string | null }[];
  if (!rows.length) return [];
  return ["## 约定后来改过", "", ...rows.map((row) => `- 第 ${row.revision} 版：${BY_TEXT[row.by_kind]}，原因：${row.reason?.trim() || "没写"}`),
    ...(rows.some((row) => row.by_kind !== "pipeline") ? ["", "原话和本人改过或确认过的新约定冲突的地方，以新约定为准，不算原话没要的或漏了的。"] : [])];
}

/** 本人的这张卡此刻的约定（带版本号）；不是本人的、没有的 404。lock 时在调用方的事务里锁住。 */
export async function agreementRow(q: Query, ownerId: string, cardId: string, lock = false): Promise<AgreementRow> {
  const row = /^[0-9a-f-]{36}$/i.test(cardId) ? (await q(`SELECT id::text,owner_id,status,brief,done_definition,agreement_revision FROM tasks WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [cardId])).rows[0] as AgreementRow | undefined : undefined;
  if (!row || row.owner_id !== ownerId) throw new CardError(404, "NOT_FOUND", "找不到这张卡");
  return row;
}

/** 卡的详情里的 agreement：版本号、改过几次、在等本人定的那个提议。 */
export async function agreementView(q: Query, cardId: string): Promise<TCardAgreementView> {
  const row = (await q(`SELECT t.agreement_revision,(SELECT count(*)::int FROM card_agreement_changes c WHERE c.card_id=t.id) AS changes FROM tasks t WHERE t.id=$1`,
    [cardId])).rows[0] as { agreement_revision: number; changes: number };
  const open = (await q("SELECT id::text,standards,brief,reason,created_at FROM card_agreement_proposals WHERE card_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 1",
    [cardId])).rows[0] as { id: string; standards: string[]; brief: string | null; reason: string; created_at: Date } | undefined;
  return { revision: row.agreement_revision, changes: row.changes,
    proposal: open ? { id: open.id, standards: open.standards, brief: open.brief, reason: open.reason, at: open.created_at.toISOString() } : null };
}

/** GET /api/me/cards/:id/agreement-changes：修改记录，新的在前。 */
export async function listAgreementChanges(q: Query, ownerId: string, cardId: string): Promise<TCardAgreementChange[]> {
  await agreementRow(q, ownerId, cardId);
  const rows = (await q("SELECT * FROM card_agreement_changes WHERE card_id=$1 ORDER BY revision DESC", [cardId])).rows as { id: string; revision: number; at: Date;
    by_kind: AgreementBy["kind"]; by_name: string | null; agreement_before: TCardAgreement; agreement_after: TCardAgreement; reason: string | null }[];
  return rows.map((row) => ({ id: row.id, revision: row.revision, at: row.at.toISOString(), by: { kind: row.by_kind, name: row.by_name },
    before: row.agreement_before, after: row.agreement_after, reason: row.reason }));
}

/** GET /api/local-runner/card-agreement：本机交回前核对用。 */
export async function cardAgreementForDevice(q: Query, ownerId: string, cardId: string): Promise<TLocalCardAgreementResponse> {
  const row = await agreementRow(q, ownerId, cardId);
  return { cardId: row.id, revision: row.agreement_revision, ...agreementOf(row) };
}

/**
 * 同步条目 agreement_proposal 落下（localSync.ts 的事务里）：记成这张卡在等本人定的那一个，旧的 open 记 superseded。同一个 key 再来不重复记。
 * 完成标准超长的、卡已完成的由调用方拒收。
 */
export async function saveProposal(q: Query, card: { id: string; owner_id: string }, runId: string, key: string, data: TLocalAgreementProposal, at: Date): Promise<void> {
  standardsText(data.standards);
  const id = randomUUID();
  const inserted = await q(`INSERT INTO card_agreement_proposals(id,card_id,owner_id,client_id,run_id,standards,brief,reason,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT (client_id) DO NOTHING`,
  [id, card.id, card.owner_id, key, runId, JSON.stringify(data.standards.map((line) => line.trim()).filter(Boolean)), data.brief?.trim() || null, data.reason.trim(), at]);
  if (inserted.rowCount) await q("UPDATE card_agreement_proposals SET status='superseded',decided_at=$3 WHERE card_id=$1 AND status='open' AND id<>$2", [card.id, id, at]);
}

/**
 * 本人对执行方的提议拍板：accept 照改（by worker，原因是执行方写的），reject 不改；两种都登记转话告诉执行方（它停着也续上，好接着做）。
 * 已经定过、作废了 409 PROPOSAL_CLOSED；没有 404。
 */
export async function decideProposal(pool: Pool, ownerId: string, cardId: string, proposalId: string, decision: "accept" | "reject", now: Date): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: Query = client.query.bind(client);
    const card = await agreementRow(q, ownerId, cardId, true);
    const proposal = /^[0-9a-f-]{36}$/i.test(proposalId) ? (await q("SELECT * FROM card_agreement_proposals WHERE id=$1 AND card_id=$2 FOR UPDATE", [proposalId, cardId])).rows[0] as
      { status: string; standards: string[]; brief: string | null; reason: string } | undefined : undefined;
    if (!proposal) throw new CardError(404, "NOT_FOUND", "找不到这个提议");
    if (proposal.status !== "open") throw new CardError(409, "PROPOSAL_CLOSED", "这个提议已经定过或作废了");
    if (decision === "accept") {
      const revision = await writeAgreement(q, card, { standards: proposal.standards, ...(proposal.brief ? { brief: proposal.brief } : {}) },
        { kind: "worker", name: "执行方" }, proposal.reason, now, true);
      // 提的和现在的一样（没变）：照样告诉它本人同意了。
      if (revision === null) await tellExecutor(q, ownerId, cardId, "本人同意了你提的约定，和现在的一样，照现在的做。", null, now, true);
    } else await tellExecutor(q, ownerId, cardId, "本人不改约定，照原来的完成标准做。", null, now, true);
    await q("UPDATE card_agreement_proposals SET status=$2,decided_at=$3 WHERE id=$1", [proposalId, decision === "accept" ? "accepted" : "rejected", now]);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}
