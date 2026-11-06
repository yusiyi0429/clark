import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ArticleFetcher } from "./articleText.js";
import { acceptanceProblem, type AcceptanceInput, type CardAcceptanceAgent } from "./cardAcceptanceAgent.js";
import type { Query } from "./meetingStore.js";
import { requestRoleProposal } from "./roleProposals.js";
import { reviewerRole, rolesById } from "./roles.js";
import { CardError, effectiveOutcome, failStreak, type HandbackRow, type StoredAcceptance } from "./taskCards.js";
import { postCoAgentMessage } from "./threads.js";

/**
 * Agent 验收（V2 设计第 7 节）的排队、落库、推翻：本机交回一次，就请验收员（cardAcceptanceAgent.ts 的作业）按卡的完成标准逐条判。
 * 都达到：卡完成、进下一版交付物的「准备中」；没都达到：用固定格式拼一段改法，等网页送回执行方；连续两次没过算受阻。本人能推翻。
 * 推翻（不论哪个方向）和第二次没过时，记一条要写的岗位修改（roleProposals.ts）。
 * 队列照交付物评审：进程内 Map，启动时和每分钟 recover；run_token 防覆盖，running 超过 10 分钟重排；单次 5 分钟超时。
 * 只验交回时执行方不是「本人自己做」的卡（本人自己做的照旧本人验收）。
 */

/** 没过时发回执行方的那段话：固定格式拼，不调模型。 */
export function returnText(criteria: string[], result: StoredAcceptance): string {
  const missed = result.criteria.filter((item) => item.verdict !== "met").sort((a, b) => a.index - b.index)
    .map((item) => `第 ${item.index} 条「${criteria[item.index - 1] ?? ""}」，${item.reason}；怎么补：${item.fix ?? "补上能核对的证据"}`);
  return `验收没过：${missed.join("。")}。改完再交回。`;
}

/** 通过时写进执行事项的验收记录：by 记推进人，agentHandbackId 表示是 Agent 验收；本人「仍然通过」时 verdict 写推翻的原因。 */
function acceptanceRecord(ownerId: string, handbackId: string, criteria: string[], result: StoredAcceptance | null, at: Date, verdict: string) {
  return { by: ownerId, at: at.toISOString(), verdict: verdict.slice(0, 200), deliverableMaterialIds: [], agentHandbackId: handbackId,
    standards: criteria.map((text, index) => ({ text: text.slice(0, 500), met: true,
      evidence: result?.criteria.find((item) => item.index === index + 1)?.evidence?.slice(0, 300) || null, materialId: null })) };
}

const tellGroup = (client: PoolClient, taskId: string, ownerId: string, text: string) =>
  postCoAgentMessage(client.query.bind(client), { objectType: "task", objectId: taskId }, text, [ownerId]);

/** 卡完成、进准备中（挂了 Task 的才进）。 */
async function completeCard(client: PoolClient, task: { id: string; owner_id: string; plan_task_id: string | null }, handbackId: string, acceptance: object) {
  await client.query(`UPDATE tasks SET status='done',acceptance=$2::jsonb,submission=NULL,blocked_reason=NULL,waiting_on=NULL,blocked_at=NULL,version=version+1,updated_at=now()
    WHERE id=$1`, [task.id, JSON.stringify(acceptance)]);
  if (task.plan_task_id) await client.query(`INSERT INTO deliverable_pending_items(id,plan_task_id,handback_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT (handback_id) DO NOTHING`,
    [randomUUID(), task.plan_task_id, handbackId, task.owner_id]);
}

const FEISHU_HOST = /(?:^|\.)(?:feishu\.cn|feishu\.net|larksuite\.com|larkoffice\.com)$/i;
const ITEM_TEXT_CHARS = 30_000;
const TOTAL_TEXT_CHARS = 120_000;
const MAX_IMAGES = 8;
const RUN_TIMEOUT_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const ACCEPTANCE_FAILED = "验收没做完，可以重试";

type TaskRow = { id: string; owner_id: string; title: string; brief: string | null; status: string; plan_task_id: string | null; criterion_index: number | null;
  criterion_text: string | null; role_id: string | null };
type OutputRow = { id: string; kind: "artifact" | "evidence"; title: string; file_name: string | null; mime: string | null; storage_key: string | null; url: string | null;
  text: string | null; extracted_text: string | null };

/** onProposal：第二次没过时记下的岗位修改，提交后交给提岗位修改的队列。 */
export function createCardAcceptanceQueue(options: { pool: Pool; storageDir: string; agent: CardAcceptanceAgent; fetchArticle: ArticleFetcher; now: () => Date;
  onError: (cause: unknown) => void; onProposal: (proposalId: string) => void }) {
  const running = new Map<string, Promise<void>>(), abort = new AbortController();
  const q: Query = options.pool.query.bind(options.pool);
  const stale = () => new Date(options.now().getTime() - STALE_MS);

  /** 产出交给 Agent：文档读抽出的文字，链接照评审的读法去取（飞书链接读不了），截图当图片附上，最多 8 张。 */
  async function material(rows: OutputRow[], signal: AbortSignal) {
    const outputs: AcceptanceInput["outputs"] = [], unreadable: AcceptanceInput["unreadable"] = [], images: ImageContent[] = [];
    let left = TOTAL_TEXT_CHARS;
    const take = (text: string | null) => {
      if (!text) return null;
      const part = text.slice(0, Math.min(ITEM_TEXT_CHARS, Math.max(left, 0)));
      left -= part.length;
      return part || null;
    };
    for (const row of rows) {
      const name = row.file_name ?? row.title;
      if (row.kind === "artifact" && row.mime?.startsWith("image/")) {
        const data = images.length < MAX_IMAGES ? await readFile(join(options.storageDir, row.storage_key!)).catch(() => null) : null;
        if (data) { images.push({ type: "image", data: data.toString("base64"), mimeType: row.mime }); outputs.push({ name, kind: "artifact", text: null, url: null }); }
        else unreadable.push({ name, note: images.length >= MAX_IMAGES ? `一次最多看 ${MAX_IMAGES} 张截图` : "截图找不到了" });
        continue;
      }
      if (row.kind === "artifact") {
        if (row.extracted_text) outputs.push({ name, kind: "artifact", text: take(row.extracted_text), url: null });
        else unreadable.push({ name, note: "这份产出里读不出文字" });
        continue;
      }
      let linkText: string | null = null;
      if (row.url) {
        let host = "";
        try { host = new URL(row.url).hostname; } catch { /* 落到下面 */ }
        if (FEISHU_HOST.test(host)) unreadable.push({ name: row.url, note: "飞书文档读不了" });
        else {
          const article = host ? await options.fetchArticle(row.url, { signal }).catch(() => null) : null;
          if (article?.text.trim()) linkText = article.text.slice(0, 20_000);
          else unreadable.push({ name: row.url, note: "链接打不开" });
        }
      }
      outputs.push({ name: row.title, kind: "evidence", text: take([row.text, linkText].filter(Boolean).join("\n\n") || null), url: row.url });
    }
    return { outputs, unreadable, images };
  }

  async function accept(handbackId: string) {
    const token = randomUUID();
    const row = (await q(`UPDATE card_handbacks SET status='running',run_token=$2,started_at=$3,finished_at=NULL,error=NULL
      WHERE id=$1 AND (status='queued' OR (status='running' AND (run_token IS NULL OR started_at<$4))) RETURNING *`,
    [handbackId, token, options.now(), stale()])).rows[0] as HandbackRow | undefined;
    if (!row) return;
    const guard = "id=$1 AND run_token=$2 AND status='running'";
    const fail = (message: string) => q(`UPDATE card_handbacks SET status='failed',error=$3,finished_at=$4 WHERE ${guard}`, [handbackId, token, message, options.now()]);
    try {
      if (!row.criteria.length) { await fail("这张卡没写完成标准，写好以后重新交回"); return; }
      const task = (await q("SELECT id::text,owner_id,title,brief,status,plan_task_id,criterion_index,criterion_text,role_id FROM tasks WHERE id=$1", [row.task_id])).rows[0] as TaskRow;
      const role = task.role_id ? (await rolesById(q, [task.role_id])).get(task.role_id) ?? null : null;
      const reviewer = await reviewerRole(q, row.owner_id);
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const rows = row.output_ids.length ? (await q("SELECT * FROM local_outputs WHERE id=ANY($1::uuid[]) ORDER BY created_at,id", [row.output_ids])).rows as OutputRow[] : [];
      const { outputs, unreadable, images } = await material(rows, signal);
      const previous = (await q(`SELECT * FROM card_handbacks WHERE task_id=$1 AND attempt<$2 AND status='done' AND result IS NOT NULL ORDER BY attempt DESC LIMIT 1`,
        [row.task_id, row.attempt])).rows[0] as HandbackRow | undefined;
      const input: AcceptanceInput = {
        card: { title: task.title, brief: task.brief, criteria: row.criteria.map((text, index) => ({ index: index + 1, text })) },
        taskCriterion: task.criterion_index && task.criterion_text ? { index: task.criterion_index, text: task.criterion_text } : null,
        claims: row.claims, summary: row.summary, outputs, unreadable, agreement: null,
        role: role ? { name: role.name, acceptanceMd: role.acceptance_md } : null,
        reviewer: reviewer ? { name: reviewer.name, practiceMd: reviewer.practice_md, acceptanceMd: reviewer.acceptance_md } : null,
        ...(previous && effectiveOutcome(previous) === "fail" ? { previous: previous.result!.criteria.map((item) => ({ index: item.index,
          text: previous.criteria[item.index - 1] ?? "", verdict: item.verdict, reason: item.reason, fix: item.fix })) } : {}),
      };
      const candidate = await Promise.race([options.agent.accept(input, { handbackId, personId: row.owner_id, images, signal }), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      const problem = acceptanceProblem(candidate, row.criteria.length);
      if (problem) throw new Error(problem);
      const result: StoredAcceptance = { headline: candidate.headline, beyondScope: candidate.beyondScope,
        criteria: [...candidate.criteria].sort((a, b) => a.index - b.index) };
      const met = result.criteria.filter((item) => item.verdict === "met").length;
      const outcome = met === result.criteria.length ? "pass" : "fail";
      const client = await options.pool.connect();
      let proposal: string | null = null;
      try {
        await client.query("BEGIN");
        const locked = (await client.query("SELECT id::text,owner_id,status,plan_task_id FROM tasks WHERE id=$1 FOR UPDATE", [row.task_id])).rows[0] as TaskRow;
        const saved = await client.query(`UPDATE card_handbacks SET status='done',result=$3::jsonb,outcome=$4,return_text=$5,finished_at=$6 WHERE ${guard}`,
          [handbackId, token, JSON.stringify(result), outcome, outcome === "fail" ? returnText(row.criteria, result) : null, options.now()]);
        // 旧的一次交回验完了，新的已经交上来：只记结论，不动卡。
        const latest = (await client.query("SELECT max(attempt)::int AS n FROM card_handbacks WHERE task_id=$1", [row.task_id])).rows[0].n as number;
        if (saved.rowCount && latest === row.attempt && outcome === "pass" && locked.status !== "done" && locked.status !== "returned") {
          await completeCard(client, locked, handbackId, acceptanceRecord(locked.owner_id, handbackId, row.criteria, result, options.now(),
            `Agent 验收通过（${met}/${result.criteria.length}）`));
          await tellGroup(client, locked.id, locked.owner_id, `Agent 验收通过（${met}/${result.criteria.length}）。`);
        }
        // 同一张卡第二次没过：提一条岗位修改。
        if (saved.rowCount && latest === row.attempt && outcome === "fail") {
          const history = (await client.query("SELECT * FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC", [row.task_id])).rows as HandbackRow[];
          if (failStreak(history) === 2)
            proposal = await requestRoleProposal(client, { taskId: row.task_id, ownerId: row.owner_id, sourceKind: "second_fail", sourceId: handbackId, reason: null });
        }
        await client.query("COMMIT");
      } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
      finally { client.release(); }
      if (proposal) options.onProposal(proposal);
    } catch (cause) {
      // 关闭时放回队列，下次启动接着验；其余算这次没验完，可以重试。
      if (abort.signal.aborted) await q(`UPDATE card_handbacks SET status='queued',run_token=NULL WHERE ${guard}`, [handbackId, token]);
      else { await fail(ACCEPTANCE_FAILED); options.onError(cause); }
    }
  }

  function enqueue(handbackId: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    const existing = running.get(handbackId); if (existing) return existing;
    const job = accept(handbackId).catch(options.onError).finally(() => { running.delete(handbackId); });
    running.set(handbackId, job); return job;
  }
  return {
    enqueue,
    async recover() {
      const rows = await q(`SELECT id FROM card_handbacks WHERE status='queued' OR (status='running' AND (run_token IS NULL OR started_at<$1))`, [stale()]);
      for (const { id } of rows.rows) void enqueue(id);
    },
    async idle() { while (running.size) await Promise.all(running.values()); },
    async close() { abort.abort(); await Promise.all(running.values()); },
  };
}
export type CardAcceptanceQueue = ReturnType<typeof createCardAcceptanceQueue>;

/** 推进人这张卡的这次交回（锁住）。 */
async function lockedHandback(client: PoolClient, ownerId: string, cardId: string, handbackId: string) {
  const task = (await client.query("SELECT id::text,owner_id,status,plan_task_id FROM tasks WHERE id=$1 FOR UPDATE", [cardId])).rows[0] as TaskRow | undefined;
  if (!task || task.owner_id !== ownerId) throw new CardError(404, "NOT_FOUND", "找不到这张卡");
  const row = (await client.query("SELECT * FROM card_handbacks WHERE id=$1 AND task_id=$2 FOR UPDATE", [handbackId, cardId])).rows[0] as HandbackRow | undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "找不到这次交回");
  return { task, row };
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

/**
 * 推翻（只有推进人，只推翻最近一次有结论的交回）：
 * - 通过的推翻：卡回进行中，验收记录清掉，从准备中拿掉（已经进了某一版的不能推翻）；推翻的原因当改法，等网页送回执行方。
 * - 没过的推翻（「仍然通过」）：卡完成、进准备中，验收记录写本人，verdict 写推翻的原因。
 * 两个方向都记一条要写的岗位修改，返回它的 id（没记为 null），调用方提交后排队。
 */
export function overruleHandback(pool: Pool, ownerId: string, cardId: string, handbackId: string, reason: string, now: Date, names: Map<string, string>): Promise<string | null> {
  const text = reason.trim();
  if (!text) throw new CardError(400, "INVALID_INPUT", "写一句为什么");
  return inTransaction(pool, async (client) => {
    const { task, row } = await lockedHandback(client, ownerId, cardId, handbackId);
    if (row.status !== "done" || !row.outcome) throw new CardError(409, "NOT_JUDGED", "这次交回还没有验收结论");
    if (row.overruled_at) throw new CardError(409, "ALREADY_OVERRULED", "这次验收已经推翻过了");
    const latest = (await client.query("SELECT max(attempt)::int AS n FROM card_handbacks WHERE task_id=$1", [cardId])).rows[0].n as number;
    if (row.attempt !== latest) throw new CardError(409, "NOT_LATEST", "只能推翻最近一次交回的验收");
    const who = names.get(ownerId) ?? ownerId;
    if (row.outcome === "pass") {
      const pending = (await client.query("SELECT version_id FROM deliverable_pending_items WHERE handback_id=$1", [handbackId])).rows[0] as { version_id: string | null } | undefined;
      if (pending?.version_id) throw new CardError(409, "ALREADY_INCLUDED", "这张卡已经进了交付物的某一版，不能推翻");
      await client.query("DELETE FROM deliverable_pending_items WHERE handback_id=$1", [handbackId]);
      if (task.status === "done") await client.query("UPDATE tasks SET status='in_progress',acceptance=NULL,version=version+1,updated_at=now() WHERE id=$1", [cardId]);
      await client.query(`UPDATE card_handbacks SET overruled_at=$2,overruled_by=$3,overrule_reason=$4,return_text=$5,returned_at=NULL WHERE id=$1`,
        [handbackId, now, ownerId, text, `验收被推翻：${text}。改完再交回。`]);
      await tellGroup(client, cardId, ownerId, `${who}推翻了 Agent 验收，卡回到进行中：${text}`);
    } else {
      if (task.status !== "done" && task.status !== "returned")
        await completeCard(client, task, handbackId, acceptanceRecord(ownerId, handbackId, row.criteria, row.result, now, `推翻 Agent 验收：${text}`));
      await client.query("UPDATE card_handbacks SET overruled_at=$2,overruled_by=$3,overrule_reason=$4 WHERE id=$1", [handbackId, now, ownerId, text]);
      await tellGroup(client, cardId, ownerId, `${who}推翻了 Agent 验收，算通过：${text}`);
    }
    return requestRoleProposal(client, { taskId: cardId, ownerId, sourceKind: "overrule", sourceId: handbackId, reason: text });
  });
}

/** 验收本身出错了（failed），重排一次；调用方开始验收。 */
export function retryHandback(pool: Pool, ownerId: string, cardId: string, handbackId: string): Promise<void> {
  return inTransaction(pool, async (client) => {
    const { row } = await lockedHandback(client, ownerId, cardId, handbackId);
    if (row.status !== "failed") throw new CardError(409, "NOT_FAILED", "验收没有出错，不用重试");
    await client.query("UPDATE card_handbacks SET status='queued',error=NULL,run_token=NULL WHERE id=$1", [handbackId]);
  });
}

/** 网页已经把没过的改法送到本机：记一笔；已经记过的不动。 */
export function markHandbackReturned(pool: Pool, ownerId: string, cardId: string, handbackId: string, now: Date): Promise<void> {
  return inTransaction(pool, async (client) => {
    const { row } = await lockedHandback(client, ownerId, cardId, handbackId);
    if (row.status !== "done" || effectiveOutcome(row) !== "fail" || !row.return_text) throw new CardError(409, "NOTHING_TO_RETURN", "这次交回没有要送回的改法");
    await client.query("UPDATE card_handbacks SET returned_at=COALESCE(returned_at,$2) WHERE id=$1", [handbackId, now]);
  });
}
