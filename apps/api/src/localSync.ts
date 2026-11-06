import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { TLocalPlanEntry, TLocalRunActivity, TLocalSessionStatus, TLocalSyncBatchRequest, TLocalSyncBatchResponse, TLocalSyncItem, TLocalTopicVersionKind } from "@warmap/contracts";
import { MAX_MATERIAL_TEXT_CHARS, runWorker } from "./materialParser.js";
import { htmlToText } from "./meetingEvidence.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { taskStandards } from "./tasks.js";

/**
 * 本机程序单向上报的接收端（POST /api/local-runner/sync，载荷是本机程序契约 localRunner.ts 的 LocalSyncBatchRequest）。
 * 一条一个事务：幂等键收过的直接回 accepted；不是本人的卡或专题、对不上的条目永久拒收（rejected，本机不再重发）；
 * 意外出错的不出现在回执里，本机稍后重发。状态、计划按本机序号只往前走，晚到的旧条目不改它们。
 */

export class SyncReject extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

type Owner = { personId: string; deviceId: string };
type RunRow = { id: string; owner_id: string; kind: "card" | "topic"; task_id: string | null; topic_id: string | null; state_seq: string; plan_seq: string;
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

/** 一批：逐条处理，回 accepted / rejected；queued 是这一批新排队等 Agent 验收的交回。 */
export async function applySyncBatch(deps: { pool: Pool; storageDir: string; now: () => Date; onError: (cause: unknown) => void }, personId: string,
  batch: TLocalSyncBatchRequest): Promise<{ response: TLocalSyncBatchResponse; queued: string[] }> {
  const response: TLocalSyncBatchResponse = { accepted: [], rejected: [] };
  const queued: string[] = [];
  for (const item of batch.items) {
    try {
      const handbackId = await applyItem(deps, { personId, deviceId: batch.deviceId }, item);
      response.accepted.push(item.key);
      if (handbackId) queued.push(handbackId);
    } catch (cause) {
      if (cause instanceof SyncReject) response.rejected.push({ key: item.key, code: cause.code, message: cause.message });
      else deps.onError(cause);
    }
  }
  return { response, queued };
}

async function applyItem(deps: { pool: Pool; storageDir: string; now: () => Date }, owner: Owner, item: TLocalSyncItem): Promise<string | null> {
  const seq = seqOf(item.key, owner.deviceId, item.sessionId);
  const at = new Date(item.occurredAt);
  if (Number.isNaN(at.valueOf())) throw new SyncReject("INVALID_TIME", "occurredAt 不是合法时间");
  const written: string[] = [];
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const fresh = await client.query(`INSERT INTO local_sync_items(key,owner_id,run_id,type) VALUES($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [item.key, owner.personId, item.sessionId, item.type]);
    if (!fresh.rowCount) { await client.query("COMMIT"); return null; }
    const card = await lockSubject(client, owner, item);
    const run = await lockRun(client, owner, item, at);
    const handbackId = await applyType(client, deps, owner, item, run, card, seq, at, written);
    await client.query("UPDATE local_runs SET last_seq=GREATEST(last_seq,$2),updated_at=$3 WHERE id=$1", [run.id, seq, deps.now()]);
    if (card?.status === "not_started")
      await client.query("UPDATE tasks SET status='in_progress',version=version+1,updated_at=now() WHERE id=$1 AND status='not_started'", [card.id]);
    await client.query("COMMIT");
    return handbackId;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw cause;
  } finally { client.release(); }
}

/** 卡（执行事项）或专题要是本人的。卡返回它的几列，专题返回 null。 */
async function lockSubject(client: PoolClient, owner: Owner, item: TLocalSyncItem): Promise<CardRow | null> {
  const { kind, cardId, topicId } = item.subject;
  const id = kind === "card" ? cardId : topicId;
  if (!id || (kind === "card" ? topicId : cardId)) throw new SyncReject("INVALID_SUBJECT", kind === "card" ? "卡要带 cardId" : "专题要带 topicId");
  if (!UUID_PATTERN.test(id)) throw new SyncReject("NOT_FOUND", kind === "card" ? "找不到这张卡" : "找不到这个专题");
  const row = (await client.query(kind === "card"
    ? "SELECT id::text,owner_id,status,executor,done_definition FROM tasks WHERE id=$1 FOR UPDATE"
    : "SELECT id::text,owner_id FROM research_topics WHERE id=$1 FOR UPDATE", [id])).rows[0] as CardRow | undefined;
  if (!row) throw new SyncReject("NOT_FOUND", kind === "card" ? "找不到这张卡" : "找不到这个专题");
  if (row.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", kind === "card" ? "这张卡不是你推进的" : "这个专题不是你的");
  return kind === "card" ? row : null;
}

/** 这次执行的摘要行：第一次见到时建，之后锁住改。 */
async function lockRun(client: PoolClient, owner: Owner, item: TLocalSyncItem, at: Date): Promise<RunRow> {
  const { kind, cardId, topicId } = item.subject;
  const created = await client.query(`INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,topic_id,started_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
    ON CONFLICT (id) DO NOTHING`, [item.sessionId, owner.personId, owner.deviceId, kind, kind === "card" ? cardId : null, kind === "topic" ? topicId : null, at]);
  const run = (await client.query("SELECT * FROM local_runs WHERE id=$1 FOR UPDATE", [item.sessionId])).rows[0] as RunRow;
  if (run.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", "这次执行不是你的");
  if (run.kind !== kind || (kind === "card" ? run.task_id !== cardId : run.topic_id !== topicId)) throw new SyncReject("SUBJECT_MISMATCH", "这次执行属于另一张卡或专题");
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
  seq: number, at: Date, written: string[]): Promise<string | null> {
  switch (item.type) {
    case "status": {
      if (seq <= Number(run.state_seq)) return null;
      const { status, title, modelLabel } = item.data;
      await client.query(`UPDATE local_runs SET state=$2,state_seq=$3,title=$4,model_label=$5,ended_at=$6,running_at=COALESCE(running_at,$7) WHERE id=$1`,
        [run.id, status, seq, title, modelLabel, status === "exited" || status === "failed" ? at : null, status === "running" ? at : null]);
      await note(client, run, at, status === "starting" ? `${STATUS_TEXT.starting}（${modelLabel}）` : STATUS_TEXT[status], MILESTONE_STATES.has(status));
      return null;
    }
    case "plan": {
      if (seq <= Number(run.plan_seq)) return null;
      const { entries, progress } = item.data;
      await client.query("UPDATE local_runs SET plan=$2::jsonb,plan_progress=$4::jsonb,plan_seq=$3 WHERE id=$1",
        [run.id, JSON.stringify(entries), seq, JSON.stringify(progress)]);
      await note(client, run, at, progress.current ? `第 ${progress.step}/${progress.total} 步：${progress.current}` : `计划 ${progress.done}/${progress.total}`, false);
      return null;
    }
    case "evidence": {
      const { kind, title, text, url } = item.data;
      await client.query(`INSERT INTO local_outputs(id,owner_id,device_id,run_id,task_id,topic_id,kind,evidence_kind,title,url,text,client_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'evidence',$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), owner.personId, owner.deviceId, run.id, run.task_id, run.topic_id, kind, title, url ?? null, text ?? null, item.key, at]);
      await note(client, run, at, `证据：${title}`, false);
      return null;
    }
    case "artifact": {
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
      return null;
    }
    case "topic_version": {
      if (!run.topic_id) throw new SyncReject("INVALID_SUBJECT", "只有专题存版本");
      const label = await saveTopicVersion(client, run, { ...item.data, clientId: item.key }, at);
      await note(client, run, at, `存了${label}`, true);
      return null;
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
      return null;
    }
    case "handback": {
      if (!card) throw new SyncReject("INVALID_SUBJECT", "专题不用交回");
      return insertHandback(client, owner, item.key, run, card, item.data, at);
    }
    case "cost": {
      const { usage, modelLabel } = item.data;
      await client.query(`UPDATE local_runs SET model_label=$2,tokens=jsonb_build_object('input',(tokens->>'input')::bigint+$3,'output',(tokens->>'output')::bigint+$4,
        'cacheRead',(tokens->>'cacheRead')::bigint+$5,'cacheWrite',(tokens->>'cacheWrite')::bigint+$6),
        cost_usd=CASE WHEN $7::numeric IS NULL THEN cost_usd ELSE COALESCE(cost_usd,0)+$7::numeric END WHERE id=$1`,
      [run.id, modelLabel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd]);
      return null;
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
  await client.query(`INSERT INTO card_handbacks(id,task_id,run_id,owner_id,client_id,attempt,criteria,claims,summary,output_ids,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11,$12)`,
  [id, card.id, run.id, owner.personId, key, attempt, JSON.stringify(taskStandards(card.done_definition)), JSON.stringify(data.criteria),
    data.summary.trim() || null, JSON.stringify(outputs), agent ? "queued" : "done", at]);
  await note(client, run, at, agent ? "交回，等验收" : "交回", true);
  return agent ? id : null;
}
