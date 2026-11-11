import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { TLocalPlanEntry, TLocalRunActivity, TLocalSessionStatus, TLocalSyncBatchRequest, TLocalSyncBatchResponse, TLocalSyncItem, TLocalTopicVersionKind } from "@warmap/contracts";
import { MAX_MATERIAL_TEXT_CHARS, runWorker } from "./materialParser.js";
import { htmlToText } from "./meetingEvidence.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { doneDefinitionProblem, taskStandards } from "./tasks.js";
import { settleHandback } from "./cardAcceptance.js";
import { saveLocalCardPlan, standardLines, type PlanTarget } from "./cardPlanner.js";
import type { HandbackRow } from "./cardProjection.js";
import { CardError, type CardPlanTask } from "./taskCards.js";
import { saveProposal } from "./cardAgreements.js";
import { ownProject } from "./projects.js";
import { closeStartsFor } from "./sessionStarts.js";
import { latestSuccessor } from "./taskContinuity.js";
import { recordStopReport, recordSubSessionStatus } from "./subSessionReports.js";

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
  project_id: string | null; device_id: string;
  state_seq: string; plan_seq: string;
  plan: TLocalPlanEntry[]; timeline: TLocalRunActivity[]; last_activity: TLocalRunActivity | null; running_at: Date | null };
type CardRow = { id: string; owner_id: string; status: string; executor: string | null; done_definition: string | null };

const TIMELINE_MAX = 50;
/** 本机能交的文件：按扩展名认。 */
const ARTIFACT_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
};
const STATUS_TEXT: Record<TLocalSessionStatus, string> = { queued: "等空位", starting: "开工", running: "在做", waiting_permission: "等你批准", idle: "在问你", exited: "停下了", failed: "异常退出", done: "做完收工" };
/** 会话结束了的几种（记结束时间）：停下了、异常退出、规划员和验收员交完收工。 */
const ENDED_STATES = new Set<TLocalSessionStatus>(["exited", "failed", "done"]);
const MILESTONE_STATES = new Set<TLocalSessionStatus>(["starting", ...ENDED_STATES]);

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
  planTask: (personId: string, planTaskId: string) => Promise<CardPlanTask | null>;
  /** 这件 Task 挂的项目（或这个项目）的对话现在最后一条消息的 sequence（17.2 第 29 条，派活单按它插进对话）；不给或读不到为 null。 */
  lastSequence?: (personId: string, target: { taskId: string | null; projectId: string | null }) => Promise<number | null> };
/**
 * 一条落下以后要接着做的：queued 是新排队等云端 Agent 验收的交回，proposal 是本机验收员第二次没过时记下的岗位修改；
 * report、decision 是子会话停了的报告、要介入的决定卡（18 节第 10 条，提交以后补 afterSequence，报告再触发项目主管线一轮）。
 */
type Applied = { queued?: string; proposal?: string; report?: string; decision?: string };

/** 一批：逐条处理，回 accepted / rejected；queued、proposals 交给调用方排队。 */
export async function applySyncBatch(deps: SyncDeps, personId: string, batch: TLocalSyncBatchRequest):
  Promise<{ response: TLocalSyncBatchResponse; queued: string[]; proposals: string[]; reports: string[]; decisions: string[] }> {
  const response: TLocalSyncBatchResponse = { accepted: [], rejected: [] };
  const queued: string[] = [], proposals: string[] = [], reports: string[] = [], decisions: string[] = [];
  for (const item of batch.items) {
    try {
      const applied = await applyItem(deps, { personId, deviceId: batch.deviceId }, item);
      response.accepted.push(item.key);
      if (applied.queued) queued.push(applied.queued);
      if (applied.proposal) proposals.push(applied.proposal);
      if (applied.report) reports.push(applied.report);
      if (applied.decision) decisions.push(applied.decision);
    } catch (cause) {
      if (cause instanceof SyncReject) response.rejected.push({ key: item.key, code: cause.code, message: cause.message });
      else deps.onError(cause);
    }
  }
  return { response, queued, proposals, reports, decisions };
}

async function applyItem(deps: SyncDeps, owner: Owner, item: TLocalSyncItem): Promise<Applied> {
  const seq = seqOf(item.key, owner.deviceId, item.sessionId);
  // 规划员拆的 Task 延续出去了（taskContinuity.ts，会话已经挂到新 Task 上）：本机还按旧 Task 报，接到它最后延续到的那件。
  if (item.subject.kind === "plan" && item.subject.taskId)
    item = { ...item, subject: { ...item.subject, taskId: await latestSuccessor(deps.pool.query.bind(deps.pool), item.subject.taskId) } };
  const at = new Date(item.occurredAt);
  if (Number.isNaN(at.valueOf())) throw new SyncReject("INVALID_TIME", "occurredAt 不是合法时间");
  // 规划员的派活单要读本体里的 Task（不在事务里读）：本人是负责人才收；拆项目的（16.3）本人是项目负责人才收。已经收过的重发不再读。
  const repeated = item.type === "card_plan" && Boolean((await deps.pool.query("SELECT 1 FROM local_sync_items WHERE key=$1", [item.key])).rowCount);
  const planned = item.type === "card_plan" && !repeated ? await plannedTarget(deps, owner, item) : null;
  // 项目对话现在的最后一条（读 Chat，不在事务里读）：这台电脑连着本机时网页直接开规划员、不经过登记，第一次建派活单时插在这后面。
  const currentSequence = planned && deps.lastSequence ? await deps.lastSequence(owner.personId, planned).catch(() => null) : null;
  const written: string[] = [];
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const fresh = await client.query(`INSERT INTO local_sync_items(key,owner_id,run_id,type) VALUES($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [item.key, owner.personId, item.sessionId, item.type]);
    if (!fresh.rowCount) { await client.query("COMMIT"); return {}; }
    const card = await lockSubject(client, owner, item);
    const run = await lockRun(client, owner, item, at);
    const applied = await applyType(client, deps, owner, item, run, card, seq, at, written, planned, currentSequence);
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

/** 规划员拆的那个 Task（本人打得开、而且是负责人，看板只给负责人），或没挂 Task 的那个项目（本人是项目负责人）。 */
async function plannedTarget(deps: SyncDeps, owner: Owner, item: TLocalSyncItem): Promise<PlanTarget> {
  const { kind, taskId, projectId } = item.subject;
  if (kind !== "plan" || (!taskId && !projectId)) throw new SyncReject("INVALID_SUBJECT", "派活单要挂在规划员的会话上（带 taskId 或 projectId）");
  if (!taskId) {
    await ownProject(deps.pool.query.bind(deps.pool), owner.personId, projectId!).catch(() => { throw new SyncReject("NOT_FOUND", "找不到这个项目"); });
    return { taskId: null, missionId: null, projectId: projectId!, criteria: [] };
  }
  const own = await deps.planTask(owner.personId, taskId);
  if (!own) throw new SyncReject("NOT_FOUND", "找不到这个 Task");
  if (!own.canEdit) throw new SyncReject("NOT_OWNER", "这个 Task 由负责人推进，派活单只收负责人的");
  return { taskId, missionId: own.task.missionId, projectId: null, criteria: own.criteria };
}

/**
 * 会话挂的东西要是本人的：卡（执行事项）和验收员验的那张卡返回卡的几列；专题返回 null；规划员的会话挂的是本体里的 Task，
 * 这里只核对带了 taskId（派活单另外核对负责人）；拆项目的（16.3）不带 taskId、带 projectId，项目要是本人的。
 */
async function lockSubject(client: PoolClient, owner: Owner, item: TLocalSyncItem): Promise<CardRow | null> {
  const { kind, cardId, topicId, taskId, projectId, handbackKey } = item.subject;
  if (kind === "plan") {
    if (!taskId && !projectId) throw new SyncReject("INVALID_SUBJECT", "规划员的会话要带 taskId 或 projectId");
    if (!taskId) {
      const project = (await client.query("SELECT owner_id FROM projects WHERE id=$1", [projectId])).rows[0] as { owner_id: string } | undefined;
      if (!project) throw new SyncReject("NOT_FOUND", "找不到这个项目");
      if (project.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", "这个项目不是你的");
    }
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
  const { kind, cardId, topicId } = item.subject;
  // 规划员：拆 Task 的记 plan_task_id，拆项目的（16.3，不带 taskId）记 project_id。
  const taskId = kind === "plan" ? item.subject.taskId ?? null : null;
  const projectId = kind === "plan" && !taskId ? item.subject.projectId ?? null : null;
  const created = await client.query(`INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,topic_id,plan_task_id,project_id,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT (id) DO NOTHING`, [item.sessionId, owner.personId, owner.deviceId, kind,
    kind === "card" || kind === "verify" ? cardId : null, kind === "topic" ? topicId : null, taskId, projectId, at]);
  const run = (await client.query("SELECT * FROM local_runs WHERE id=$1 FOR UPDATE", [item.sessionId])).rows[0] as RunRow;
  if (run.owner_id !== owner.personId) throw new SyncReject("NOT_OWNER", "这次执行不是你的");
  const same = kind === "topic" ? run.topic_id === topicId : kind === "plan" ? run.plan_task_id === taskId && run.project_id === projectId : run.task_id === cardId;
  if (run.kind !== kind || !same) throw new SyncReject("SUBJECT_MISMATCH", "这次执行属于另一张卡、专题或 Task");
  // 开工（本机第一次报这次执行）时记下卡的岗位版本。
  if (created.rowCount && kind === "card")
    await client.query("UPDATE tasks t SET role_version=r.version FROM roles r WHERE t.id=$1 AND r.id=t.role_id", [cardId]);
  // 这张卡、这个专题登记过要开工（第 4.4 节）：本机开起来了，那条了结，别处不再认领。
  if (created.rowCount && (kind === "card" || kind === "topic"))
    await closeStartsFor(client.query.bind(client), kind === "card" ? { cardId } : { topicId }, at);
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

async function applyType(client: PoolClient, deps: Pick<SyncDeps, "storageDir" | "now">, owner: Owner, item: TLocalSyncItem, run: RunRow, card: CardRow | null,
  seq: number, at: Date, written: string[], planned: PlanTarget | null, currentSequence: number | null): Promise<Applied> {
  switch (item.type) {
    case "status": {
      if (seq <= Number(run.state_seq)) return {};
      const { status, title, modelLabel, waitingFor, hold, question, permission, permissionMode, heldBy } = item.data;
      // waitingFor：排着、在等前面的卡（只有 queued 带）；别的状态清掉。hold：停着等额度恢复，恢复接着做时报的那条不带，就清掉。
      // ask：在问本人（idle 带 question）、在等批准的那一步（waiting_permission 带 permission）；别的状态、不带的清掉（新首页 9.6）。
      const ask = status === "idle" && question ? { kind: "question", request: question }
        : status === "waiting_permission" && permission ? { kind: "permission", request: permission } : null;
      await client.query(`UPDATE local_runs SET state=$2,state_seq=$3,title=$4,model_label=$5,ended_at=$6,running_at=COALESCE(running_at,$7),waiting_for=$8,hold=$9::jsonb,
        ask=$10::jsonb,permission_mode=COALESCE($11,permission_mode),held_by=$12::jsonb WHERE id=$1`, [run.id, status, seq, title, modelLabel, ENDED_STATES.has(status) ? at : null,
        status === "running" ? at : null, status === "queued" && waitingFor?.length ? waitingFor : null, hold ? JSON.stringify({ reason: hold.reason, until: hold.until }) : null,
        ask ? JSON.stringify(ask) : null, permissionMode ?? null,
        // 在等普通文件夹空出来（第 68 条）：占着它的是谁，只有 queued 带。
        status === "queued" && heldBy ? JSON.stringify(heldBy) : null]);
      await note(client, run, at, hold ? "额度用完，等恢复" : status === "starting" ? `${STATUS_TEXT.starting}（${modelLabel}）`
        : status === "idle" && !question ? "这一轮做完了" : STATUS_TEXT[status], MILESTONE_STATES.has(status));
      // 要介入：在项目对话里出决定卡（18 节第 10 条）；停了另有 stopped 条目。
      return recordSubSessionStatus(client.query.bind(client), owner.personId, run, { status, question, permission }, at);
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
      const tooLong = item.data.cards.map((card) => doneDefinitionProblem(card.doneDefinition)).find(Boolean);
      if (tooLong) throw new SyncReject("INVALID_PLAN", tooLong);
      if (item.data.cards.some((card, index) => (card.after ?? []).some((after) => after > index)))
        throw new SyncReject("INVALID_PLAN", "一件只能等排在它前面的几件（after 写前面的位置，从 1 起）");
      const saved = await saveLocalCardPlan(client, { ownerId: owner.personId, runId: run.id, target: planned, plan: item.data, at, currentSequence });
      await note(client, run, at, saved ? `出了派活单（第 ${item.data.revision} 次，${item.data.cards.length} 件）` : "旧的派活单晚到了", true);
      return {};
    }
    case "verdict": {
      if (run.kind !== "verify" || !card) throw new SyncReject("INVALID_SUBJECT", "验收结论只收验收员的会话");
      return applyVerdict(client, owner, run, card, item.subject.handbackKey!, item.data, at);
    }
    case "cost": {
      // token 订阅和网关都累计；cost_usd 是 Claude Code 按标价估的，不是花费。网关的真钱（money）按币种累计进 money，不换算；订阅的、旧条目没有 money。
      const { usage, modelLabel, source, money } = item.data;
      const paid = source === "gateway" && money ? money : null;
      await client.query(`UPDATE local_runs SET model_label=$2,tokens=jsonb_build_object('input',(tokens->>'input')::bigint+$3,'output',(tokens->>'output')::bigint+$4,
        'cacheRead',(tokens->>'cacheRead')::bigint+$5,'cacheWrite',(tokens->>'cacheWrite')::bigint+$6),
        cost_usd=CASE WHEN $7::numeric IS NULL THEN cost_usd ELSE COALESCE(cost_usd,0)+$7::numeric END,
        money=CASE WHEN $8::text IS NULL THEN money ELSE money||jsonb_build_object($8::text,COALESCE((money->>$8::text)::numeric,0)+$9::numeric) END WHERE id=$1`,
      [run.id, modelLabel, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd,
        paid ? paid.currency.toUpperCase() : null, paid?.amount ?? 0]);
      return {};
    }
    case "budget": {
      // 这件 Task（不挂 Task 的专题按会话）的预算用了多少：只存最新的一份（updatedAt 新的覆盖旧的），首页的预算提示以后读它。
      const view = item.data;
      const key = view.taskId ? `task:${view.taskId}` : `session:${view.sessionId ?? run.id}`;
      await client.query(`INSERT INTO local_task_budgets(owner_id,subject_key,view,updated_at) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT (owner_id,subject_key) DO UPDATE SET view=EXCLUDED.view,updated_at=EXCLUDED.updated_at WHERE local_task_budgets.updated_at < EXCLUDED.updated_at`,
      [owner.personId, key, JSON.stringify(view), view.updatedAt]);
      return {};
    }
    case "user_message": {
      // 本人在网页上说的一句（17.4）：存原话和附件的文件名；回执先到了的那一行补上原话。不记动静。
      const { messageId, text, attachments } = item.data;
      await client.query(`INSERT INTO local_run_messages(run_id,message_id,owner_id,text,attachments,sent_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (run_id,message_id) DO UPDATE SET text=EXCLUDED.text,attachments=EXCLUDED.attachments,sent_at=EXCLUDED.sent_at WHERE local_run_messages.text IS NULL`,
      [run.id, messageId, owner.personId, text, attachments ?? [], at]);
      return {};
    }
    case "receipt": {
      // 那句话的回执：以本机序号最新的为准（晚到的旧回执不覆盖）；比话先到时先占一行。
      const { messageId, state } = item.data;
      await client.query(`INSERT INTO local_run_messages(run_id,message_id,owner_id,receipt,receipt_seq,receipt_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (run_id,message_id) DO UPDATE SET receipt=EXCLUDED.receipt,receipt_seq=EXCLUDED.receipt_seq,receipt_at=EXCLUDED.receipt_at
        WHERE local_run_messages.receipt_seq IS NULL OR local_run_messages.receipt_seq < EXCLUDED.receipt_seq`,
      [run.id, messageId, owner.personId, state, seq, at]);
      return {};
    }
    case "background": {
      // 会话里的子 agent、后台命令：按会话 + 本机的 id 覆盖，序号更小的晚到了不改。只给首页右栏显示，不记动静。
      const { id, kind, title, state, startedAt, finishedAt, stoppable } = item.data;
      await client.query(`INSERT INTO local_background_items(run_id,item_id,owner_id,kind,title,state,started_at,finished_at,stoppable,seq,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (run_id,item_id) DO UPDATE SET kind=EXCLUDED.kind,title=EXCLUDED.title,state=EXCLUDED.state,
        started_at=EXCLUDED.started_at,finished_at=EXCLUDED.finished_at,stoppable=EXCLUDED.stoppable,seq=EXCLUDED.seq,updated_at=EXCLUDED.updated_at
        WHERE local_background_items.seq < EXCLUDED.seq`, [run.id, id, owner.personId, kind, title, state, startedAt, finishedAt, stoppable, seq, deps.now()]);
      return {};
    }
    case "stopped": {
      // 子会话停了（18 节第 10 条）：卡和专题在项目里的记一条报告，提交以后由路由补位置（不触发模型，主循环第 63 条）。规划员、验收员不报。
      if (run.kind !== "card" && run.kind !== "topic") return {};
      await note(client, run, at, item.data.blocker ? `停了：${item.data.blocker}` : "停了", false);
      return recordStopReport(client.query.bind(client), owner.personId, run, item.data, at);
    }
    case "agreement_proposal": {
      // 执行方提议改卡的约定（主循环第 60 条）：记成这张卡在等本人定的那一个，子会话里钉一个框。完成标准超长、卡已完成的拒收。
      if (!card || run.kind !== "card") throw new SyncReject("INVALID_SUBJECT", "改约定的提议只收卡的会话");
      if (card.status === "done") throw new SyncReject("CARD_DONE", "这张卡已经完成了");
      try {
        await saveProposal(client.query.bind(client), card, run.id, item.key, item.data, at);
      } catch (cause) {
        if (cause instanceof CardError) throw new SyncReject("INVALID_PROPOSAL", cause.message);
        throw cause;
      }
      await note(client, run, at, "提议改约定，等本人定", true);
      return {};
    }
    case "merge": {
      // 卡验收过以后合回到哪了（第 4.5 节）：记在验的那次交回上。同一次交回报了几条时以本机序号最大的为准（同一毫秒里可能报两条，不比时间）。
      if (!card || run.kind !== "card") throw new SyncReject("INVALID_SUBJECT", "合回结果只收卡的会话");
      const { handbackKey, merged, commit, baseBranch, reason, message, auto } = item.data;
      const row = (await client.query("SELECT id FROM card_handbacks WHERE client_id=$1 AND task_id=$2 AND owner_id=$3 FOR UPDATE",
        [handbackKey, card.id, owner.personId])).rows[0] as { id: string } | undefined;
      if (!row) throw new SyncReject("HANDBACK_NOT_FOUND", "云端没有这次交回");
      const saved = await client.query("UPDATE card_handbacks SET merge=$2::jsonb WHERE id=$1 AND (merge IS NULL OR (merge->>'seq')::bigint < $3)",
        [row.id, JSON.stringify({ merged, commit, baseBranch, reason, message, auto, at: at.toISOString(), seq }), seq]);
      if (saved.rowCount) await note(client, run, at, merged ? `已合进 ${baseBranch}` : `没能合回：${message ?? reason ?? "原因不明"}`, true);
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
    .map(({ index, verdict, reason, evidence, fix, fixBy }) => ({ index, verdict, reason: reason.trim(), evidence: evidence?.trim() || null, fix: fix?.trim() || null,
      ...(verdict === "met" ? {} : { fixBy: verdict === "needs_person" ? "person" as const : fixBy ?? "worker" }) })),
    sourceWordIssues: (data.sourceWordIssues ?? []).map(({ quote, kind, reason }) => ({ quote: quote.trim(), kind, reason: reason.trim() })) };
  const settled = await settleHandback(client, row, result,
    { source: "local", modelLabel: data.modelLabel, roleId: data.roleId, roleVersion: data.roleVersion, runId: run.id, commit: data.commit ?? null }, null, at);
  if (!settled.saved) throw new SyncReject("ALREADY_JUDGED", "这次交回已经有验收结论了");
  await note(client, run, at, settled.outcome === "pass" ? "验收通过" : settled.outcome === "needs_person" ? "验收：等本人补" : "验收没过", true);
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
