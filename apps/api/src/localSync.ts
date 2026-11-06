import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { TLocalPlanEntry, TLocalRunActivity, TLocalSessionStatus, TLocalSyncBatchRequest, TLocalSyncBatchResponse, TLocalSyncItem, TLocalTopicVersionKind } from "@warmap/contracts";
import { MAX_MATERIAL_TEXT_CHARS, runWorker } from "./materialParser.js";
import { htmlToText } from "./meetingEvidence.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { taskStandards } from "./tasks.js";
import { settleHandback } from "./cardAcceptance.js";
import { saveLocalCardPlan, standardLines } from "./cardPlanner.js";
import type { HandbackRow } from "./cardProjection.js";
import type { CardPlanTask } from "./taskCards.js";

/**
 * 本机程序单向上报的接收端（POST /api/local-runner/sync，载荷是本机程序契约 localRunner.ts 的 LocalSyncBatchRequest）。
 * 一条一个事务：幂等键收过的直接回 accepted；不是本人的卡或专题、对不上的条目永久拒收（rejected，本机不再重发）；
 * 意外出错的不出现在回执里，本机稍后重发。状态、计划按本机序号只往前走，晚到的旧条目不改它们。
 */

export class SyncReject extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type Owner = { personId: string; deviceId: string };
type RunRow = { id: string; owner_id: string; kind: "card" | "topic" | "plan" | "verify"; task_id: string | null; topic_id: string | null; plan_task_id: string | null;
  state_seq: string; plan_seq: string;
  plan: TLocalPlanEntry[]; timeline: TLocalRunActivity[]; last_activity: TLocalRunActivity | null; running_at: Date | null };
type CardRow = { id: string; owner_id: string; status: string; executor: string | null; done_definition: string | null };

const TIMELINE_MAX = 50;
/** 本机能交的文件：按扩展名认。 */
const ARTIFACT_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};
const STATUS_TEXT: Record<TLocalSessionStatus, string> = { queued: "等空位", starting: "开工", running: "在做", waiting_permission: "等你批准", idle: "等你回复", exited: "停下了", failed: "异常退出" };
const MILESTONE_STATES = new Set<TLocalSessionStatus>(["starting", "exited", "failed"]);

/** 幂等键 <deviceId>:<sessionId>:<序号>：前两段要和这一批、这一条对得上，序号是本会话的同步序号。 */
export function seqOf(key: string, deviceId: string, sessionId: string): number {
  const prefix = `${deviceId}:${sessionId}:`;
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!/^\d{1,15}$/.test(rest)) throw new SyncReject("INVALID_KEY", "幂等键要是 <deviceId>:<sessionId>:<序号>");
  return Number(rest);
}

/** 文件里的文字（给验收和评审读）：Markdown、纯文本直接读，HTML 去标签，PDF、Word 交给材料解析进程；图片没有文字。 */
async function extractText(path: string, mime: string, buffer: Buffer): Promise<string | null> {
  try {
    const text = mime === "text/markdown" || mime === "text/plain" ? new TextDecoder("utf-8").decode(buffer)
      : mime === "text/html" ? htmlToText(new TextDecoder("utf-8").decode(buffer))
      : mime === "application/pdf" || mime.endsWith("wordprocessingml.document") ? (await runWorker(path, mime as Parameters<typeof runWorker>[1])).text : "";
    return text.trim().slice(0, MAX_MATERIAL_TEXT_CHARS) || null;
  } catch { return null; }
}

/**
 * 接收端的依赖。planTask：按本人打开一个 Task 和它的约定（规划员报的派活单要挂 Task 负责人的 Mission，读不到或不是负责人拒收）。
 */
export type SyncDeps = { pool: Pool; storageDir: string; now: () => Date; onError: (cause: unknown) => void;
  planTask: (personId: string, planTaskId: string) => Promise<CardPlanTask | null> };
/** 一条落下以后要接着做的：queued 是新排队等云端 Agent 验收的交回，proposal 是本机验收员第二次没过时记下的岗位修改。 */
type Applied = { queued?: string; proposal?: string };

/** 一批：逐条处理，回 accepted / rejected；queued、proposals 交给调用方排队。 */
export async function applySyncBatch(deps: SyncDeps, personId: string,
  batch: TLocalSyncBatchRequest): Promise<{ response: TLocalSyncBatchResponse; queued: string[]; proposals: string[] }> {
  const response: TLocalSyncBatchResponse = { accepted: [], rejected: [] };
  const queued: string[] = [], proposals: string[] = [];
  for (const item of batch.items) {
    try {
      const applied = await applyItem(deps, { personId, deviceId: batch.deviceId }, item);
      response.accepted.push(item.key);
      if (applied.queued) queued.push(applied.queued);
      if (applied.proposal) proposals.push(applied.proposal);
    } catch (cause) {
      if (cause instanceof SyncReject) response.rejected.push({ key: item.key, code: cause.code, message: cause.message });
      else deps.onError(cause);
    }
  }
  return { response, queued, proposals };
}

async function applyItem(deps: SyncDeps, owner: Owner, item: TLocalSyncItem): Promise<Applied> {
  const seq = seqOf(item.key, owner.deviceId, item.sessionId);
  const at = new Date(item.occurredAt);
  if (Number.isNaN(at.valueOf())) throw new SyncReject("INVALID_TIME", "occurredAt 不是合法时间");
  // 规划员的派活单要读本体里的 Task（不在事务里读）：本人是负责人才收。已经收过的重发不再读。
  const repeated = item.type === "card_plan" && Boolean((await deps.pool.query("SELECT 1 FROM local_sync_items WHERE key=$1", [item.key])).rowCount);
  const planned = item.type === "card_plan" && !repeated ? await plannedTask(deps, owner, item) : null;
  const written: string[] = [];
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const fresh = await client.query(`INSERT INTO local_sync_items(key,owner_id,run_id,type) VALUES($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [item.key, owner.personId, item.sessionId, item.type]);
    if (!fresh.rowCount) { await client.query("COMMIT"); return {}; }
    const card = await lockSubject(client, owner, item);
    const run = await lockRun(client, owner, item, at);
    const applied = await applyType(client, deps, owner, item, run, card, seq, at, written, planned);
    await client.query("UPDATE local_runs SET last_seq=GREATEST(last_seq,$2),updated_at=$3 WHERE id=$1", [run.id, seq, deps.now()]);
    // 本机开工了，卡变进行中；本机报「等空位」（queued）还没开工，卡留在待开始。验收员的会话不动卡。
    if (item.subject.kind === "card" && card?.status === "not_started" && !(item.type === "status" && item.data.status === "queued"))
      await client.query("UPDATE tasks SET status='in_progress',version=version+1,updated_at=now() WHERE id=$1 AND status='not_started'", [card.id]);
    await client.query("COMMIT");
    return applied;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw cause;
  } finally { client.release(); }
}

/** 规划员拆的那个 Task：本人打得开、而且是负责人（看板只给负责人）。 */
async function plannedTask(deps: SyncDeps, owner: Owner, item: TLocalSyncItem): Promise<CardPlanTask> {
  const taskId = item.subject.kind === "plan" ? item.subject.taskId : undefined;
  if (!taskId) throw new SyncReject("INVALID_SUBJECT", "派活单要挂在规划员的会话上（带 taskId）");
  const own = await deps.planTask(owner.personId, taskId);
  if (!own) throw new SyncReject("NOT_FOUND", "找不到这个 Task");
  if (!own.canEdit) throw new SyncReject("NOT_OWNER", "这个 Task 由负责人推进，派活单只收负责人的");
  return own;
}

/**
 * 会话挂的东西要是本人的：卡（执行事项）和验收员验的那张卡返回卡的几列；专题返回 null；规划员的会话挂的是本体里的 Task，
 * 这里只核对带了 taskId（派活单另外核对负责人）。
 */
async function lockSubject(client: PoolClient, owner: Owner, item: TLocalSyncItem): Promise<CardRow | null> {
  const { kind, cardId, topicId, taskId, handbackKey } = item.subject;
  if (kind === "plan") {
    if (!taskId) throw new SyncReject("INVALID_SUBJECT", "规划员的会话要带 taskId");
    return null;
  }
  const onCard = kind === "card" || kind === "verify";
  const id = onCard ? cardId : topicId;
  if (!id || (onCard ? topicId : cardId)) throw new SyncReject("INVALID_SUBJECT", onCard ? "卡要带 cardId" : "专题要带 topicId");
  if (kind === "verify" && !handbackKey) throw new SyncReject("INVALID_SUBJECT", "验收员的会话要带 handbackKey");
  if (!UUID_PATTERN.test(id)) throw new SyncReject("NOT_FOUND", onCard ? "找不到这张卡" : "找不到这个专题");
  const row = (await client.query(onCard
    ? "SELECT id::text,owner_id,status,executor,done_definition FROM tasks WHERE id=$1 FOR UPDATE"
    : "SELECT id::text,owner_id FROM research_topics WHERE id=$1 FOR UPDATE", [id])).rows[0] as CardRow | undefined;
  if (!row) throw new SyncReject("NOT_FOUND", onCard ? "找不到这张卡" : "找不到这个专题");
  if (row.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", onCard ? "这张卡不是你推进的" : "这个专题不是你的");
  return onCard ? row : null;
}

/** 这次执行的摘要行：第一次见到时建，之后锁住改。 */
async function lockRun(client: PoolClient, owner: Owner, item: TLocalSyncItem, at: Date): Promise<RunRow> {
  const { kind, cardId, topicId, taskId } = item.subject;
  const created = await client.query(`INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,topic_id,plan_task_id,started_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
    ON CONFLICT (id) DO NOTHING`, [item.sessionId, owner.personId, owner.deviceId, kind, kind === "card" || kind === "verify" ? cardId : null,
    kind === "topic" ? topicId : null, kind === "plan" ? taskId : null, at]);
  const run = (await client.query("SELECT * FROM local_runs WHERE id=$1 FOR UPDATE", [item.sessionId])).rows[0] as RunRow;
  if (run.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", "这次执行不是你的");
  const same = kind === "topic" ? run.topic_id === topicId : kind === "plan" ? run.plan_task_id === taskId : run.task_id === cardId;
  if (run.kind !== kind || !same) throw new SyncReject("SUBJECT_MISMATCH", "这次执行属于另一张卡、专题或 Task");
  // 开工（本机第一次报这次执行）时记下卡的岗位版本。
  if (created.rowCount && kind === "card")
    await client.query("UPDATE tasks t SET role_version=r.version FROM roles r WHERE t.id=$1 AND r.id=t.role_id", [cardId]);
  return run;
}

/** 记一条动静：最近一条动静取时间最新的；里程碑按时间排，最多留 50 条。 */
async function note(client: PoolClient, run: RunRow, at: Date, text: string, milestone: boolean) {
  const entry = { at: at.toISOString(), text: text.slice(0, 300) };
  const latest = !run.last_activity || run.last_activity.at <= entry.at ? entry : run.last_activity;
  const timeline = milestone ? [...run.timeline, entry].sort((a, b) => a.at.localeCompare(b.at)).slice(-TIMELINE_MAX) : run.timeline;
  run.last_activity = latest;
  run.timeline = timeline;
  await client.query("UPDATE local_runs SET last_activity=$2::jsonb,timeline=$3::jsonb WHERE id=$1", [run.id, JSON.stringify(latest), JSON.stringify(timeline)]);
}

async function applyType(client: PoolClient, deps: { storageDir: string }, owner: Owner, item: TLocalSyncItem, run: RunRow, card: CardRow | null,
  seq: number, at: Date, written: string[], planned: CardPlanTask | null): Promise<Applied> {
  switch (item.type) {
    case "status": {
      if (seq <= Number(run.state_seq)) return {};
      const { status, title, modelLabel } = item.data;
      await client.query(`UPDATE local_runs SET state=$2,state_seq=$3,title=$4,model_label=$5,ended_at=$6,running_at=COALESCE(running_at,$7) WHERE id=$1`,
        [run.id, status, seq, title, modelLabel, status === "exited" || status === "failed" ? at : null, status === "running" ? at : null]);
      await note(client, run, at, status === "starting" ? `${STATUS_TEXT.starting}（${modelLabel}）` : STATUS_TEXT[status], MILESTONE_STATES.has(status));
      return {};
    }
    case "plan": {
      if (seq <= Number(run.plan_seq)) return {};
      const { entries, progress } = item.data;
      await client.query("UPDATE local_runs SET plan=$2::jsonb,plan_progress=$4::jsonb,plan_seq=$3 WHERE id=$1",
        [run.id, JSON.stringify(entries), seq, JSON.stringify(progress)]);
      await note(client, run, at, progress.current ? `第 ${progress.step}/${progress.total} 步：${progress.current}` : `计划 ${progress.done}/${progress.total}`, false);
      return {};
    }
    case "evidence": {
      if (run.kind === "plan" || run.kind === "verify") throw new SyncReject("INVALID_SUBJECT", "规划员、验收员不交产出和证据");
      const { kind, title, text, url } = item.data;
      await client.query(`INSERT INTO local_outputs(id,owner_id,device_id,run_id,task_id,topic_id,kind,evidence_kind,title,url,text,client_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'evidence',$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), owner.personId, owner.deviceId, run.id, run.task_id, run.topic_id, kind, title, url ?? null, text ?? null, item.key, at]);
      await note(client, run, at, `证据：${title}`, false);
      return {};
    }
    case "artifact": {
      if (run.kind === "plan" || run.kind === "verify") throw new SyncReject("INVALID_SUBJECT", "规划员、验收员不交产出和证据");
      const { title, fileName, size, sha256, contentBase64 } = item.data;
      const mime = ARTIFACT_TYPES[extname(fileName).toLowerCase()];
      if (!mime) throw new SyncReject("UNSUPPORTED_TYPE", "只收 Markdown、纯文本、HTML、PDF、Word 和 PNG、JPG");
      const buffer = Buffer.from(contentBase64, "base64");
      if (buffer.length !== size || createHash("sha256").update(buffer).digest("hex") !== sha256) throw new SyncReject("CHECKSUM_MISMATCH", "文件大小或摘要对不上");
      const id = randomUUID(), storageKey = `local-outputs/${run.id}/${id}`, path = join(deps.storageDir, storageKey);
      await mkdir(join(deps.storageDir, "local-outputs", run.id), { recursive: true, mode: 0o700 });
      written.push(path);
      await writeFile(path, buffer, { mode: 0o600 });
      const text = mime.startsWith("image/") ? null : await extractText(path, mime, buffer);
      await client.query(`INSERT INTO local_outputs(id,owner_id,device_id,run_id,task_id,topic_id,kind,title,file_name,mime,size_bytes,sha256,storage_key,extracted_text,client_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'artifact',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, owner.personId, owner.deviceId, run.id, run.task_id, run.topic_id, title, fileName, mime, size, sha256, storageKey, text, item.key, at]);
      await note(client, run, at, `交出：${title}`, true);
      return {};
    }
    case "topic_version": {
      if (!run.topic_id) throw new SyncReject("INVALID_SUBJECT", "只有专题存版本");
      const label = await saveTopicVersion(client, run, { ...item.data, clientId: item.key }, at);
      await note(client, run, at, `存了${label}`, true);
      return {};
    }
    case "topic_version_feishu": {
      if (!run.topic_id) throw new SyncReject("INVALID_SUBJECT", "只有专题的版本能存进飞书");
      const { number, feishuUrl } = item.data;
      // 先认本会话自己存的那一版（本机号），再按号认以前的版本。
      const saved = await client.query(`UPDATE topic_versions SET feishu_url=$4 WHERE id=(SELECT id FROM topic_versions WHERE topic_id=$1
        AND ((run_id=$2 AND local_number=$3) OR number=$3) ORDER BY (run_id=$2 AND local_number=$3) IS TRUE DESC LIMIT 1) RETURNING label`,
      [run.topic_id, run.id, number, feishuUrl]);
      if (!saved.rowCount) throw new SyncReject("VERSION_NOT_FOUND", `没有第 ${number} 版`);
      await note(client, run, at, `${saved.rows[0].label}存进了飞书`, true);
      return {};
    }
    case "handback": {
      if (!card || run.kind !== "card") throw new SyncReject("INVALID_SUBJECT", "只有卡的会话交回");
      const queued = await insertHandback(client, owner, item.key, run, card, item.data, at);
      return queued ? { queued } : {};
    }
    case "card_plan": {
      if (run.kind !== "plan" || !planned) throw new SyncReject("INVALID_SUBJECT", "派活单只收规划员的会话");
      if (!item.data.summary.trim() || item.data.cards.some((card) => !card.title.trim() || !standardLines(card.doneDefinition)))
        throw new SyncReject("INVALID_PLAN", "计划要有一句话总结，每件派活单要有标题和完成标准");
      const saved = await saveLocalCardPlan(client, { ownerId: owner.personId, runId: run.id, own: planned, plan: item.data, at });
      await note(client, run, at, saved ? `出了派活单（第 ${item.data.revision} 次，${item.data.cards.length} 件）` : "旧的派活单晚到了", true);
      return {};
    }
    case "verdict": {
      if (run.kind !== "verify" || !card) throw new SyncReject("INVALID_SUBJECT", "验收结论只收验收员的会话");
      return applyVerdict(client, owner, run, card, item.subject.handbackKey!, item.data, at);
    }
    case "cost": {
      const { usage, modelLabel } = item.data;
      await client.query(`UPDATE local_runs SET model_label=$2,tokens=jsonb_build_object('input',(tokens->>'input')::bigint+$3,'output',(tokens->>'output')::bigint+$4,
        'cacheRead',(tokens->>'cacheRead')::bigint+$5,'cacheWrite',(tokens->>'cacheWrite')::bigint+$6),
        cost_usd=CASE WHEN $7::numeric IS NULL THEN cost_usd ELSE COALESCE(cost_usd,0)+$7::numeric END WHERE id=$1`,
      [run.id, modelLabel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd]);
      return {};
    }
  }
}

/**
 * 专题存一版：号用本机编的（开工时的 versionBase 往下编）；这个号云端已经有了（两处同时写同一个专题）就排到最后，不丢这一版。
 * 本机没起名时，提纲叫「提纲」，评审会的一版叫「评审」，正文按第几版正文叫「第 N 版」。返回这一版的名字。
 */
async function saveTopicVersion(client: PoolClient, run: Pick<RunRow, "id" | "topic_id">,
  version: { number: number; kind: TLocalTopicVersionKind; label: string | null; body: string; note: string | null; clientId: string }, at: Date): Promise<string> {
  const counts = (await client.query(`SELECT COALESCE(max(number),0)::int AS number,count(*) FILTER (WHERE kind='draft')::int AS drafts,
    bool_or(number=$2) AS taken FROM topic_versions WHERE topic_id=$1`, [run.topic_id, version.number])).rows[0] as { number: number; drafts: number; taken: boolean | null };
  const label = version.label ?? (version.kind === "outline" ? "提纲" : version.kind === "review" ? "评审" : `第 ${counts.drafts + 1} 版`);
  await client.query(`INSERT INTO topic_versions(id,topic_id,number,local_number,kind,label,body,note,client_id,run_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), run.topic_id, counts.taken ? counts.number + 1 : version.number, version.number, version.kind, label,
    version.body, version.note, version.clientId, run.id, at]);
  await client.query("UPDATE research_topics SET last_version_at=$2,updated_at=$2 WHERE id=$1", [run.topic_id, at]);
  return label;
}

/**
 * 本机验收员的结论（第 21 节）：按 handbackKey 找到那次交回，照云端验收的规则落下（cardAcceptance.settleHandback）：
 * 过了进准备中；没过拼好改法写在交回上，网页照原来的「送回」送一次；第二次没过受阻，记一条岗位修改。
 * 逐条要和交回时的完成标准对上（编号 1..n 各一次）；这次交回已经有结论（验过、推翻过）的拒收。
 */
async function applyVerdict(client: PoolClient, owner: Owner, run: RunRow, card: CardRow, handbackKey: string,
  data: Extract<TLocalSyncItem, { type: "verdict" }>["data"], at: Date): Promise<Applied> {
  const row = (await client.query("SELECT * FROM card_handbacks WHERE client_id=$1 AND task_id=$2 AND owner_id=$3 FOR UPDATE",
    [handbackKey, card.id, owner.personId])).rows[0] as HandbackRow | undefined;
  if (!row) throw new SyncReject("HANDBACK_NOT_FOUND", "云端没有这次交回");
  if (row.outcome || row.overruled_at) throw new SyncReject("ALREADY_JUDGED", "这次交回已经有验收结论了");
  const indexes = data.criteria.map((item) => item.index).sort((a, b) => a - b);
  if (indexes.length !== row.criteria.length || indexes.some((index, position) => index !== position + 1))
    throw new SyncReject("INVALID_VERDICT", `完成标准有 ${row.criteria.length} 条，每条判一次`);
  const result = { headline: data.summary, beyondScope: data.beyondScope,
    criteria: [...data.criteria].sort((a, b) => a.index - b.index)
    .map(({ index, verdict, reason, evidence, fix }) => ({ index, verdict, reason: reason.trim(), evidence: evidence?.trim() || null, fix: fix?.trim() || null })) };
  const settled = await settleHandback(client, row, result,
    { source: "local", modelLabel: data.modelLabel, roleId: data.roleId, roleVersion: data.roleVersion, runId: run.id, commit: data.commit ?? null }, null, at);
  if (!settled.saved) throw new SyncReject("ALREADY_JUDGED", "这次交回已经有验收结论了");
  await note(client, run, at, settled.outcome === "pass" ? "验收通过" : "验收没过", true);
  return settled.proposal ? { proposal: settled.proposal } : {};
}

/**
 * 交回：记一行，完成标准取此刻卡的快照，算进去的产出是本机点名的那几份（outputKeys 是它们的同步条目键；本机拒收过的、对不上这张卡的不算）。
 * 卡已完成、或执行方是本人自己做的，只记下来，不排 Agent 验收；没设执行方的老事项从本机交回，就当作 Claude Code 干的。
 */
async function insertHandback(client: PoolClient, owner: Owner, key: string, run: RunRow, card: CardRow,
  data: Extract<TLocalSyncItem, { type: "handback" }>["data"], at: Date): Promise<string | null> {
  const attempt = (await client.query("SELECT COALESCE(max(attempt),0)::int+1 AS n FROM card_handbacks WHERE task_id=$1", [card.id])).rows[0].n as number;
  const outputs = (await client.query("SELECT id::text FROM local_outputs WHERE task_id=$1 AND client_id=ANY($2::text[]) ORDER BY created_at,id",
    [card.id, data.outputKeys])).rows.map((row) => row.id as string);
  const agent = card.status !== "done" && card.executor !== "self";
  if (agent && card.executor === null) await client.query("UPDATE tasks SET executor='claude_code' WHERE id=$1", [card.id]);
  const id = randomUUID();
  // git：卡在自己的工作树里做时交回的分支和提交（ADR 0038），在文件夹里做的不带。
  await client.query(`INSERT INTO card_handbacks(id,task_id,run_id,owner_id,client_id,attempt,criteria,claims,summary,output_ids,status,created_at,git)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb)`,
  [id, card.id, run.id, owner.personId, key, attempt, JSON.stringify(taskStandards(card.done_definition)), JSON.stringify(data.criteria),
    data.summary.trim() || null, JSON.stringify(outputs), agent ? "queued" : "done", at, data.git ? JSON.stringify(data.git) : null]);
  await note(client, run, at, agent ? "交回，等验收" : "交回", true);
  return agent ? id : null;
}
