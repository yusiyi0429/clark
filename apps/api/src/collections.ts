import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  TActionDescriptor, TCollectionEntryView, TCollectionField, TCollectionScenario, TCollectionView, TDraftCollectionRequest,
  TDraftCollectionResponse, TRequestPerson, TRequestStep, TScheduleItem, TWeeklyReviewBody,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { CollectionAgent } from "./collectionAgent.js";
import { withTimeout } from "./delivery/requestAgent.js";
import type { BitableAdapter, BitableCell, BitableColumn, BitableTable } from "./feishu/bitable.js";
import { cellText } from "./feishu/bitable.js";
import type { FeishuEnv } from "./feishu/config.js";
import type { FeishuNotify } from "./feishu/notify.js";
import { readUserAccessToken } from "./feishu/tokens.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { addDays, weekStartOf } from "./weeklyReviews.js";

/**
 * ③ 信息收集（小版本）：只做财务每周开销、方法部门每周进展两个场景，大家共填一张飞书多维表格。
 * - 起草：Agent 判断场景、起草标题 / 收件人 / 截止 / 是否每周固定；收哪几栏按场景固定。草稿只有发起人看得到。
 * - 发出：发起人在预览里点「发送」；每一轮是一条 kind = collection 的请求（待办卡、通知栏、飞书通知走送达通道）。
 *   Agent 先给每人填一版草稿：方法部门的表，本人这周的周复盘已提交就用它起草（D-01）；开销天枢没有数据，留空。
 * - 确认：「确认完成」只在天枢里点；有人确认，发起人在天枢和飞书都收到通知。
 * - 后台（jobs 的 collection.tick，每分钟）：每周固定的开下一轮、截止前 3 小时提醒一次还没确认的人、
 *   用新提交的周复盘补草稿、「填完了主动提醒」只记影子、和飞书多维表格双向同步。
 */

export const COLLECTION_FIELDS: Record<TCollectionScenario, TCollectionField[]> = {
  expense: [
    { key: "amount", label: "本周开销（元）", kind: "number", required: true },
    { key: "purpose", label: "用途", kind: "text", required: true },
    { key: "project", label: "对应项目", kind: "text", required: true },
    { key: "receipt", label: "票据", kind: "link", required: true },
    { key: "note", label: "备注", kind: "text", required: false },
  ],
  method_progress: [
    { key: "progress", label: "本周进展", kind: "text", required: true },
    { key: "issues", label: "问题与卡点", kind: "text", required: true },
    { key: "nextWeek", label: "下周计划", kind: "text", required: true },
    { key: "support", label: "需要的支持", kind: "text", required: false },
  ],
};
export const SCENARIO_LABELS: Record<TCollectionScenario, string> = { expense: "每周开销", method_progress: "每周进展" };
/** 截止前多久提醒一次。 */
export const REMIND_BEFORE_MS = 3 * 3_600_000;
/** 「填完了主动提醒」影子记录：停止编辑多久以上才算。 */
export const NUDGE_IDLE_MS = 30 * 60_000;
export const COLLECTION_TICK_KIND = "collection.tick";
const WEEK_MS = 7 * 86_400_000;
const OFFSET = 8 * 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

type CollectionRow = {
  id: string; initiator_id: string; prompt: string; scenario: TCollectionScenario; title: string; fields: TCollectionField[];
  recipient_ids: string[]; deadline_at: Date; weekly: boolean; status: TCollectionView["status"]; version: number;
  bitable: BitableTable | null; sync_error: string | null; created_at: Date; sent_at: Date | null;
};
type RoundRow = { request_id: string; collection_id: string; seq: number; week_start: string; opens_at: Date; deadline_at: Date; reminded_at: Date | null };
type EntryRow = {
  request_id: string; person_id: string; values: Record<string, string>; draft_from: "weekly_review" | null; draft_review_id: string | null;
  edited: boolean; version: number; synced_version: number; record_id: string | null; last_edit_at: Date | null; confirmed_at: Date | null;
  shadow_nudge_at: Date | null; updated_at: Date;
};
export type CollectionError = { error: { status: number; code: string; message: string } };
const failure = (status: number, code: string, message: string): CollectionError => ({ error: { status, code, message } });
const NOT_FOUND = failure(404, "COLLECTION_NOT_FOUND", "收集任务不存在或不可见");
const ROUND_COLUMNS = "request_id, collection_id, seq, to_char(week_start, 'YYYY-MM-DD') AS week_start, opens_at, deadline_at, reminded_at";

const nameOf = (names: Map<string, string>, id: string) => names.get(id) ?? id;
const step = (label: string, status: TRequestStep["status"], result: string | null = null): TRequestStep => ({ label, status, result });
const local = (at: Date) => new Date(at.getTime() + OFFSET);
const pad = (value: number) => String(value).padStart(2, "0");
/** 「10/24 周五 18:00」。 */
export const deadlineLabel = (at: Date) => { const d = local(at); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} 周${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const weekLabel = (weekStart: string) => `${Number(weekStart.slice(5, 7))}/${Number(weekStart.slice(8, 10))} 周`;
const nowText = (at: Date) => { const d = local(at); return `${d.toISOString().slice(0, 10)} 周${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

/** 「2026-10-24 18:00」（上海时间）→ Date；格式不对返回 null。 */
export function parseLocalDeadline(text: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text?.trim() ?? "");
  if (!match) return null;
  const at = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}
/** 没说截止：本周五 18:00；已经过了（或不到 2 小时）就下周五。 */
export function defaultDeadline(now: Date): Date {
  const d = local(now);
  const friday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7), 18) - OFFSET;
  return new Date(friday - now.getTime() < 2 * 3_600_000 ? friday + WEEK_MS : friday);
}

const filledCount = (fields: TCollectionField[], values: Record<string, string>) =>
  fields.filter((field) => field.required && values[field.key]?.trim()).length;
const requiredCount = (fields: TCollectionField[]) => fields.filter((field) => field.required).length;
const cleanValues = (fields: TCollectionField[], values: Record<string, string>) =>
  Object.fromEntries(fields.flatMap((field) => { const value = values[field.key]?.trim(); return value ? [[field.key, value.slice(0, 4000)]] : []; }));

/** 周复盘正文去掉出处标记，只留文字。 */
const plain = (text: string | undefined) => (text ?? "").replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, "").replace(/[ \t]+([。，；])/g, "$1").trim();
/** 方法部门的表：用本人这周已提交的周复盘起草（D-01）。 */
export function valuesFromWeeklyReview(body: TWeeklyReviewBody): Record<string, string> {
  const progress = [plain(body.overall?.text), plain(body.progress?.text)].filter(Boolean).join("\n");
  return Object.fromEntries(Object.entries({ progress, issues: plain(body.issues?.text), nextWeek: plain(body.nextWeek?.text) }).filter(([, value]) => value));
}

// ---------- 读 ----------

async function getCollectionRow(q: Query, id: string, lock = false): Promise<CollectionRow | null> {
  if (!UUID.test(id)) return null;
  return (await q(`SELECT * FROM collections WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0] as CollectionRow | undefined ?? null;
}
const getRound = async (q: Query, requestId: string) => UUID.test(requestId)
  ? (await q(`SELECT ${ROUND_COLUMNS} FROM collection_rounds WHERE request_id = $1`, [requestId])).rows[0] as RoundRow | undefined ?? null : null;
const latestRound = async (q: Query, collectionId: string) =>
  (await q(`SELECT ${ROUND_COLUMNS} FROM collection_rounds WHERE collection_id = $1 ORDER BY seq DESC LIMIT 1`, [collectionId])).rows[0] as RoundRow | undefined ?? null;
const readEntries = async (q: Query, requestId: string) =>
  (await q(`SELECT * FROM collection_entries WHERE request_id = $1 ORDER BY person_id`, [requestId])).rows as EntryRow[];

function sign(secret: string, scope: ActionScope, label: string): TActionDescriptor {
  return { actionId: signActionId(secret, scope), actionType: scope.actionType, label, ...(scope.itemId ? { itemId: scope.itemId } : {}) };
}

function entryView(fields: TCollectionField[], row: EntryRow, names: Map<string, string>): TCollectionEntryView {
  const filled = filledCount(fields, row.values), required = requiredCount(fields);
  return {
    personId: row.person_id, displayName: nameOf(names, row.person_id), values: row.values, filled, required,
    status: row.confirmed_at ? "confirmed" : filled === required ? "filled" : "empty", draftFrom: row.draft_from,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
  };
}

type ViewDeps = { viewerId: string; names: Map<string, string>; people: TRequestPerson[]; secret: string };

async function project(q: Query, row: CollectionRow, round: RoundRow | null, deps: ViewDeps): Promise<TCollectionView> {
  const isInitiator = row.initiator_id === deps.viewerId;
  const all = round ? await readEntries(q, round.request_id) : [];
  const mine = all.find((entry) => entry.person_id === deps.viewerId);
  const shown = isInitiator ? all : mine ? [mine] : [];
  const views = all.map((entry) => entryView(row.fields, entry, deps.names));
  const actions: TActionDescriptor[] = [];
  const draft = row.status === "draft";
  if (isInitiator && draft) actions.push(sign(deps.secret, { actionType: "collection.send", objectType: "collection", objectId: row.id, objectVersion: row.version }, "发送"));
  if (isInitiator && row.status === "active" && row.weekly) actions.push(sign(deps.secret, { actionType: "collection.stop", objectType: "collection", objectId: row.id, objectVersion: row.version }, "停用"));
  if (round && mine && !mine.confirmed_at) {
    const scope = { objectType: "collection-round", objectId: round.request_id, objectVersion: 1, itemId: deps.viewerId };
    actions.push(sign(deps.secret, { ...scope, actionType: "collection.save" }, "保存"), sign(deps.secret, { ...scope, actionType: "collection.confirm" }, "确认完成"));
  }
  return {
    id: row.id, status: row.status, version: row.version, scenario: row.scenario, title: row.title, fields: row.fields,
    initiator: { personId: row.initiator_id, displayName: nameOf(deps.names, row.initiator_id) }, weekly: row.weekly,
    deadlineAt: (round?.deadline_at ?? row.deadline_at).toISOString(),
    table: row.bitable?.url ? { url: row.bitable.url } : null,
    candidates: draft ? row.recipient_ids.map((personId) => ({ personId, displayName: nameOf(deps.names, personId) })) : [],
    directory: draft && isInitiator ? deps.people.filter((person) => person.personId !== deps.viewerId) : [],
    round: round ? { requestId: round.request_id, weekStart: round.week_start, deadlineAt: round.deadline_at.toISOString() } : null,
    entries: shown.map((entry) => entryView(row.fields, entry, deps.names)),
    counts: { total: views.length, filled: views.filter((entry) => entry.status !== "empty").length, confirmed: views.filter((entry) => entry.status === "confirmed").length },
    viewer: { isInitiator, isRecipient: Boolean(mine) },
    actions,
  };
}

/** 发起人读收集任务：草稿，或最近一轮的汇总。 */
export async function readCollection(q: Query, id: string, deps: ViewDeps): Promise<TCollectionView | null> {
  const row = await getCollectionRow(q, id);
  if (!row || row.initiator_id !== deps.viewerId) return null;
  return project(q, row, row.status === "draft" ? null : await latestRound(q, row.id), deps);
}

/** 某一轮（kind = collection 的请求）：发起人和这一轮的接收人看得到；打开即把这一轮给我的通知标为已读。 */
export async function readCollectionRound(q: Query, requestId: string, deps: ViewDeps): Promise<TCollectionView | null> {
  const round = await getRound(q, requestId);
  if (!round) return null;
  const row = await getCollectionRow(q, round.collection_id);
  if (!row) return null;
  const isRecipient = (await q("SELECT 1 FROM collection_entries WHERE request_id = $1 AND person_id = $2", [requestId, deps.viewerId])).rows.length > 0;
  if (row.initiator_id !== deps.viewerId && !isRecipient) return null;
  await q("UPDATE notifications SET read_at = now() WHERE person_id = $1 AND object_type = 'request' AND object_id = $2 AND read_at IS NULL", [deps.viewerId, requestId]);
  return project(q, row, round, deps);
}

/** 收到的收集（请求列表、通知栏用）：每条我那一行填了几栏。 */
export async function fieldsFilledByRequest(q: Query, personId: string, requestIds: string[]): Promise<Map<string, { filled: number; required: number }>> {
  if (!requestIds.length) return new Map();
  const rows = (await q(`SELECT e.request_id, e."values", c.fields FROM collection_entries e JOIN collection_rounds r ON r.request_id = e.request_id
    JOIN collections c ON c.id = r.collection_id WHERE e.person_id = $1 AND e.request_id = ANY($2::uuid[])`, [personId, requestIds])).rows as
    { request_id: string; values: Record<string, string>; fields: TCollectionField[] }[];
  return new Map(rows.map((row) => [row.request_id, { filled: filledCount(row.fields, row.values), required: requiredCount(row.fields) }]));
}

// ---------- 起草 ----------

export async function draftCollection(pool: Pool, agent: CollectionAgent, input: TDraftCollectionRequest, deps: ViewDeps & { now: Date }):
  Promise<(TDraftCollectionResponse & { scenario: TCollectionScenario }) | (CollectionError & { steps?: TRequestStep[] })> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const existing = input.collectionId ? await getCollectionRow(q, input.collectionId) : null;
  if (input.collectionId && (!existing || existing.initiator_id !== deps.viewerId)) return NOT_FOUND;
  if (existing && existing.status !== "draft") return failure(409, "COLLECTION_ALREADY_SENT", "已经发出");
  const id = existing?.id ?? randomUUID();
  const people = deps.people.filter((person) => person.personId !== deps.viewerId);
  let candidate;
  try {
    candidate = await withTimeout((signal) => agent.draft({
      prompt: input.prompt, now: nowText(deps.now), people, initiator: nameOf(deps.names, deps.viewerId),
      current: existing ? { scenario: existing.scenario, title: existing.title, recipientIds: existing.recipient_ids,
        deadline: `${local(existing.deadline_at).toISOString().slice(0, 10)} ${pad(local(existing.deadline_at).getUTCHours())}:${pad(local(existing.deadline_at).getUTCMinutes())}`, weekly: existing.weekly } : null,
    }, { collectionId: id, personId: deps.viewerId }, signal));
  } catch { return failure(503, "COLLECTION_DRAFT_FAILED", "起草没有成功，请重试"); }
  if (candidate.scenario === "unsupported") {
    return { ...failure(422, "COLLECTION_SCENARIO_UNSUPPORTED", "只能收每周开销和每周进展"),
      steps: [step("判断场景", "done", "不是开销或周进展"), step("起草收集表", "pending"), step("等你确认", "pending")] };
  }
  const scenario = candidate.scenario;
  const title = candidate.title?.trim().slice(0, 30) || SCENARIO_LABELS[scenario];
  const allowed = new Set(people.map((person) => person.personId));
  const recipients = [...new Set(candidate.recipientIds)].filter((personId) => allowed.has(personId));
  const parsed = parseLocalDeadline(candidate.deadline);
  const deadline = parsed && parsed.getTime() > deps.now.getTime() ? parsed : defaultDeadline(deps.now);
  const fields = COLLECTION_FIELDS[scenario];
  const saved = existing
    ? await q(`UPDATE collections SET prompt = $2, scenario = $3, title = $4, fields = $5::jsonb, recipient_ids = $6::jsonb, deadline_at = $7, weekly = $8,
        version = version + 1, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id, input.prompt, scenario, title, JSON.stringify(fields), JSON.stringify(recipients), deadline, candidate.weekly])
    : await q(`INSERT INTO collections (id, initiator_id, prompt, scenario, title, fields, recipient_ids, deadline_at, weekly)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9) RETURNING *`,
    [id, deps.viewerId, input.prompt, scenario, title, JSON.stringify(fields), JSON.stringify(recipients), deadline, candidate.weekly]);
  const row = saved.rows[0] as CollectionRow | undefined;
  if (!row) return failure(409, "COLLECTION_ALREADY_SENT", "已经发出");
  return {
    collection: await project(q, row, null, deps), scenario,
    steps: [step("判断场景", "done", SCENARIO_LABELS[scenario]), step("起草收集表", "done", `${fields.length} 栏 · ${recipients.length} 人`), step("等你确认", "current")],
  };
}

// ---------- 发出一轮 ----------

export type CollectionDeps = {
  pool: Pool;
  bitable: BitableAdapter;
  /** live 模式读发起人的 user token 要用；mock 不需要。 */
  feishu?: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">;
  /** 飞书通知（送达通道的飞书那一半）；没配飞书时为空。 */
  notify?: FeishuNotify;
  /** 站内路径：CEO 在 /requests，其他人在 /me/requests。 */
  isCeo: (personId: string) => boolean;
  names: () => Map<string, string>;
  now: () => Date;
};
const requestPath = (deps: Pick<CollectionDeps, "isCeo">, personId: string, requestId: string) => `${deps.isCeo(personId) ? "" : "/me"}/requests/${requestId}`;

async function submittedReview(q: Query, personId: string, weekStart: string) {
  return (await q("SELECT id, body FROM weekly_reviews WHERE person_id = $1 AND week_start = $2 AND status = 'submitted' AND body IS NOT NULL",
    [personId, weekStart])).rows[0] as { id: string; body: TWeeklyReviewBody } | undefined;
}


const roundBody = (row: CollectionRow, deadlineAt: Date) =>
  [`截止 ${deadlineLabel(deadlineAt)}${row.weekly ? " · 每周固定" : ""}`, "", ...row.fields.map((field) => `- ${field.label}${field.required ? "" : "（选填）"}`)].join("\n");

/**
 * 在事务里开一轮（调用方已锁住 collections 这一行）：建 kind = collection 的请求、每人一行草稿、站内通知；
 * 飞书通知入队，同一轮同一人只发一次。
 */
async function openRound(client: PoolClient, row: CollectionRow, seq: number, opensAt: Date, deadlineAt: Date, deps: CollectionDeps): Promise<string> {
  const q: Query = (sql, params) => client.query(sql, params);
  const requestId = randomUUID();
  const weekStart = weekStartOf(opensAt);
  const title = `${row.title}（${weekLabel(weekStart)}）`;
  await q(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, sent_at) VALUES ($1, 'collection', $2, $3, $4, $5, 'open', $6)`,
    [requestId, row.initiator_id, row.prompt, title, roundBody(row, deadlineAt), opensAt]);
  await q(`INSERT INTO collection_rounds (request_id, collection_id, seq, week_start, opens_at, deadline_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [requestId, row.id, seq, weekStart, opensAt, deadlineAt]);
  const initiator = nameOf(deps.names(), row.initiator_id);
  for (const personId of row.recipient_ids) {
    const review = row.scenario === "method_progress" ? await submittedReview(q, personId, weekStart) : undefined;
    const values = review ? valuesFromWeeklyReview(review.body) : {};
    await q("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [requestId, personId]);
    await q(`INSERT INTO collection_entries (request_id, person_id, "values", draft_from, draft_review_id) VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [requestId, personId, JSON.stringify(values), review && Object.keys(values).length ? "weekly_review" : null, review?.id ?? null]);
    await insertNotification(client, { personId, kind: "request_received", objectType: "request", objectId: requestId, actorId: row.initiator_id });
    await deps.notify?.({ personId, title: `${initiator}请你填：${title}`, body: `截止 ${deadlineLabel(deadlineAt)}`,
      links: [{ label: "打开待办", path: requestPath(deps, personId, requestId) }] }, `collection:${requestId}:open:${personId}`);
  }
  return requestId;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

class Refused extends Error { constructor(readonly result: CollectionError) { super(result.error.message); } }
const refuse = (status: number, code: string, message: string): never => { throw new Refused(failure(status, code, message)); };

/**
 * collection.send / save / confirm / stop。只有 send 校验版本（发出的必须是预览那一版）；
 * save / confirm 针对的是本人那一行，确认以后不能再改；重放按各自的幂等规则返回当前视图。
 * 返回这次动作之后该看的那一轮（发出后是第一轮）。
 */
export async function executeCollectionAction(deps: CollectionDeps, viewerId: string, scope: ActionScope, input: unknown, allowed: Set<string>):
  Promise<{ collectionId: string; requestId: string | null } | CollectionError> {
  try {
    return await inTransaction(deps.pool, async (client) => {
      const q: Query = (sql, params) => client.query(sql, params);
      const now = deps.now();
      if (scope.actionType === "collection.send" || scope.actionType === "collection.stop") {
        const row = await getCollectionRow(q, scope.objectId, true);
        if (!row || row.initiator_id !== viewerId) return refuse(404, NOT_FOUND.error.code, NOT_FOUND.error.message);
        if (scope.actionType === "collection.stop") {
          if (row.status === "active" && row.weekly) await q("UPDATE collections SET status = 'stopped', updated_at = now() WHERE id = $1", [row.id]);
          return { collectionId: row.id, requestId: (await latestRound(q, row.id))?.request_id ?? null };
        }
        if (row.status !== "draft") return { collectionId: row.id, requestId: (await latestRound(q, row.id))?.request_id ?? null };
        if (scope.objectVersion !== row.version) return refuse(409, "VERSION_CONFLICT", "草稿已经改过，请看过最新预览再发送");
        const send = input as { recipientIds: string[]; deadlineAt: string; weekly: boolean };
        const ids = [...new Set(send.recipientIds)];
        if (ids.some((personId) => personId === viewerId || !allowed.has(personId))) return refuse(400, "INVALID_RECIPIENT", "收件人不在名单里");
        const deadline = new Date(send.deadlineAt);
        if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) return refuse(400, "INVALID_DEADLINE", "截止时间要晚于现在");
        const sent = (await q(`UPDATE collections SET status = 'active', recipient_ids = $2::jsonb, deadline_at = $3, weekly = $4, sent_at = $5, updated_at = now()
          WHERE id = $1 RETURNING *`, [row.id, JSON.stringify(ids), deadline, send.weekly, now])).rows[0] as CollectionRow;
        return { collectionId: row.id, requestId: await openRound(client, sent, 1, now, deadline, deps) };
      }

      const round = await getRound(q, scope.objectId);
      if (!round) return refuse(404, NOT_FOUND.error.code, NOT_FOUND.error.message);
      const row = (await getCollectionRow(q, round.collection_id))!;
      if (scope.itemId !== viewerId) return refuse(403, "FORBIDDEN", "只能改自己那一行");
      const entry = (await q(`SELECT * FROM collection_entries WHERE request_id = $1 AND person_id = $2 FOR UPDATE`, [round.request_id, viewerId])).rows[0] as EntryRow | undefined;
      if (!entry) return refuse(404, NOT_FOUND.error.code, NOT_FOUND.error.message);
      const result = { collectionId: row.id, requestId: round.request_id };
      if (scope.actionType === "collection.save") {
        if (entry.confirmed_at) return refuse(409, "COLLECTION_CONFIRMED", "已经确认完成");
        const values = cleanValues(row.fields, (input as { values: Record<string, string> }).values);
        if (JSON.stringify(values) === JSON.stringify(entry.values)) return result;
        await q(`UPDATE collection_entries SET "values" = $3::jsonb, edited = TRUE, version = version + 1, last_edit_at = $4, updated_at = now()
          WHERE request_id = $1 AND person_id = $2`, [round.request_id, viewerId, JSON.stringify(values), now]);
        return result;
      }
      if (scope.actionType === "collection.confirm") {
        if (entry.confirmed_at) return result;
        if (filledCount(row.fields, entry.values) < requiredCount(row.fields)) return refuse(409, "COLLECTION_INCOMPLETE", "还有必填的没填");
        await q(`UPDATE collection_entries SET confirmed_at = $3, version = version + 1, updated_at = now() WHERE request_id = $1 AND person_id = $2`,
          [round.request_id, viewerId, now]);
        await q("UPDATE request_recipients SET status = 'done', done_by = $2, done_at = $3 WHERE request_id = $1 AND person_id = $2", [round.request_id, viewerId, now]);
        await q(`UPDATE requests SET status = 'done', updated_at = now() WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM request_recipients WHERE request_id = $1 AND status = 'pending')`, [round.request_id]);
        await insertNotification(client, { personId: row.initiator_id, kind: "request_done", objectType: "request", objectId: round.request_id, actorId: viewerId });
        const confirmed = (await q("SELECT count(*)::int AS n FROM collection_entries WHERE request_id = $1 AND confirmed_at IS NOT NULL", [round.request_id])).rows[0].n as number;
        const total = (await q("SELECT count(*)::int AS n FROM collection_entries WHERE request_id = $1", [round.request_id])).rows[0].n as number;
        await deps.notify?.({ personId: row.initiator_id, title: `${nameOf(deps.names(), viewerId)}确认了：${row.title}`,
          body: `已确认 ${confirmed}/${total}`, links: [{ label: "看汇总", path: requestPath(deps, row.initiator_id, round.request_id) }] },
        `collection:${round.request_id}:confirm:${viewerId}`);
        return result;
      }
      return refuse(404, "UNKNOWN_ACTION", "未注册的 actionType");
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

// ---------- 后台：每周固定、提醒、补草稿、影子记录、同步飞书 ----------

const isWorkTime = (at: Date) => { const d = local(at); return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && d.getUTCHours() >= 9 && d.getUTCHours() < 19; };

/** 每周固定的开下一轮：上一轮发出 7 天后发（停机好几周只补最近的一轮）；名单、栏目照旧，截止同样往后推。 */
async function openDueRounds(deps: CollectionDeps, now: Date): Promise<void> {
  const due = (await deps.pool.query(`SELECT c.id FROM collections c
    JOIN LATERAL (SELECT opens_at FROM collection_rounds r WHERE r.collection_id = c.id ORDER BY seq DESC LIMIT 1) last ON TRUE
    WHERE c.status = 'active' AND c.weekly AND last.opens_at + interval '7 days' <= $1`, [now])).rows as { id: string }[];
  for (const { id } of due) {
    await inTransaction(deps.pool, async (client) => {
      const q: Query = (sql, params) => client.query(sql, params);
      const row = await getCollectionRow(q, id, true);
      const last = row ? await latestRound(q, id) : null;
      if (!row || !last || row.status !== "active" || last.opens_at.getTime() + WEEK_MS > now.getTime()) return;
      const weeks = Math.max(1, Math.floor((now.getTime() - last.opens_at.getTime()) / WEEK_MS));
      await openRound(client, row, last.seq + 1, new Date(last.opens_at.getTime() + weeks * WEEK_MS), new Date(last.deadline_at.getTime() + weeks * WEEK_MS), deps);
    });
  }
}

/** 截止前 3 小时提醒一次还没确认的人（这一轮发出时离截止已不到 3 小时就不提醒）。 */
async function remind(deps: CollectionDeps, now: Date): Promise<void> {
  const remindAt = new Date(now.getTime() + REMIND_BEFORE_MS);
  const rounds = (await deps.pool.query(`UPDATE collection_rounds SET reminded_at = $1
    WHERE reminded_at IS NULL AND deadline_at > $1 AND deadline_at <= $2 AND opens_at + make_interval(secs => $3::double precision / 1000) < deadline_at
    RETURNING request_id, collection_id, deadline_at`, [now, remindAt, REMIND_BEFORE_MS])).rows as { request_id: string; collection_id: string; deadline_at: Date }[];
  for (const round of rounds) {
    await inTransaction(deps.pool, async (client) => {
      const row = (await getCollectionRow((sql, params) => client.query(sql, params), round.collection_id))!;
      const pending = (await client.query("SELECT person_id FROM collection_entries WHERE request_id = $1 AND confirmed_at IS NULL", [round.request_id])).rows as { person_id: string }[];
      for (const { person_id: personId } of pending) {
        await insertNotification(client, { personId, kind: "collection_reminder", objectType: "request", objectId: round.request_id, actorId: row.initiator_id });
        await deps.notify?.({ personId, title: `截止前提醒：${row.title}`, body: `截止 ${deadlineLabel(round.deadline_at)}`,
          links: [{ label: "打开待办", path: requestPath(deps, personId, round.request_id) }] }, `collection:${round.request_id}:remind:${personId}`);
      }
    });
  }
}

/** 方法部门的表：本人这周的周复盘提交了、这一行本人还没动过，就用周复盘补上草稿。 */
async function refillFromWeeklyReviews(deps: CollectionDeps, now: Date): Promise<void> {
  const rows = (await deps.pool.query(`SELECT e.request_id, e.person_id, w.id AS review_id, w.body FROM collection_entries e
    JOIN collection_rounds r ON r.request_id = e.request_id JOIN collections c ON c.id = r.collection_id
    JOIN weekly_reviews w ON w.person_id = e.person_id AND w.week_start = r.week_start AND w.status = 'submitted' AND w.body IS NOT NULL
    WHERE c.scenario = 'method_progress' AND e.confirmed_at IS NULL AND NOT e.edited AND e.draft_review_id IS NULL AND r.deadline_at > $1::timestamptz - interval '7 days'`,
  [now])).rows as { request_id: string; person_id: string; review_id: string; body: TWeeklyReviewBody }[];
  for (const row of rows) {
    const values = valuesFromWeeklyReview(row.body);
    if (!Object.keys(values).length) continue;
    await deps.pool.query(`UPDATE collection_entries SET "values" = $3::jsonb, draft_from = 'weekly_review', draft_review_id = $4, version = version + 1, updated_at = now()
      WHERE request_id = $1 AND person_id = $2 AND NOT edited AND draft_review_id IS NULL AND confirmed_at IS NULL`,
    [row.request_id, row.person_id, JSON.stringify(values), row.review_id]);
  }
}

/**
 * 「填完了主动提醒确认」先影子运行：必填都填了、停止编辑 30 分钟以上、工作时间，就记下「如果推，会在这时推给他」，不打扰人。
 * 之后对照 confirmed_at 统计有用率和误报率（记了以后还在改的比例）。
 */
async function recordShadowNudges(deps: CollectionDeps, now: Date): Promise<void> {
  if (!isWorkTime(now)) return;
  const rows = (await deps.pool.query(`SELECT e.request_id, e.person_id, e."values", c.fields FROM collection_entries e
    JOIN collection_rounds r ON r.request_id = e.request_id JOIN collections c ON c.id = r.collection_id
    WHERE e.confirmed_at IS NULL AND e.shadow_nudge_at IS NULL AND e.last_edit_at <= $1 AND r.deadline_at > $2`,
  [new Date(now.getTime() - NUDGE_IDLE_MS), now])).rows as { request_id: string; person_id: string; values: Record<string, string>; fields: TCollectionField[] }[];
  for (const row of rows) {
    if (filledCount(row.fields, row.values) < requiredCount(row.fields)) continue;
    await deps.pool.query("UPDATE collection_entries SET shadow_nudge_at = $3 WHERE request_id = $1 AND person_id = $2 AND shadow_nudge_at IS NULL",
      [row.request_id, row.person_id, now]);
  }
}

const columnsOf = (row: CollectionRow): BitableColumn[] => [
  { name: "填写人", type: "text" }, { name: "周", type: "text" },
  ...row.fields.map((field): BitableColumn => ({ name: field.label, type: field.kind === "number" ? "number" : "text" })),
  { name: "已确认", type: "checkbox" },
];
function recordFields(row: CollectionRow, entry: EntryRow, weekStart: string, names: Map<string, string>): Record<string, BitableCell> {
  const cells: Record<string, BitableCell> = { 填写人: nameOf(names, entry.person_id), 周: weekLabel(weekStart), 已确认: Boolean(entry.confirmed_at) };
  for (const field of row.fields) {
    const value = entry.values[field.key] ?? "";
    if (field.kind !== "number") cells[field.label] = value;
    else if (value.trim() && Number.isFinite(Number(value))) cells[field.label] = Number(value);
  }
  return cells;
}

/**
 * 和飞书多维表格同步一个收集任务：表跟着收集任务走，只有新建的收集第一次同步时建表（收件人加成可编辑）；
 * 每周固定的后续各轮沿用这张表，每人每轮追加一行、带「周」这一栏（D-46）。天枢这边改过的行推上去，
 * 再把飞书里改过的行读回来（天枢这边没有待推的改动时才覆盖）。失败只记 sync_error，下一分钟再试。
 */
export async function syncCollection(deps: CollectionDeps, collectionId: string): Promise<void> {
  const q: Query = (sql, params) => deps.pool.query(sql, params);
  const row = await getCollectionRow(q, collectionId);
  if (!row || row.status === "draft") return;
  try {
    const accessToken = deps.bitable.mode === "mock" ? "mock" : deps.feishu ? await readUserAccessToken(q, deps.feishu, row.initiator_id, deps.now()) : null;
    if (!accessToken) throw new Error("发起人还没有授权飞书");
    let table = row.bitable;
    if (!table) {
      const openIds = (await q("SELECT open_id FROM feishu_identities WHERE person_id = ANY($1::text[])", [row.recipient_ids])).rows.map((item) => item.open_id as string);
      table = await deps.bitable.createTable({ accessToken, name: row.title, columns: columnsOf(row), editorOpenIds: openIds });
      await q("UPDATE collections SET bitable = $2::jsonb WHERE id = $1", [row.id, JSON.stringify(table)]);
    }
    const names = deps.names();
    const entries = (await q(`SELECT e.*, to_char(r.week_start, 'YYYY-MM-DD') AS week_start FROM collection_entries e JOIN collection_rounds r ON r.request_id = e.request_id
      WHERE r.collection_id = $1 AND r.deadline_at > $2::timestamptz - interval '14 days'`, [row.id, deps.now()])).rows as (EntryRow & { week_start: string })[];
    for (const entry of entries.filter((item) => item.version > item.synced_version)) {
      const recordId = await deps.bitable.upsertRecord({ accessToken, table, recordId: entry.record_id, fields: recordFields(row, entry, entry.week_start, names) });
      await q("UPDATE collection_entries SET record_id = $3, synced_version = $4 WHERE request_id = $1 AND person_id = $2 AND version = $4",
        [entry.request_id, entry.person_id, recordId, entry.version]);
      entry.record_id = recordId;
      entry.synced_version = entry.version;
    }
    const remote = new Map((await deps.bitable.listRecords({ accessToken, table })).map((record) => [record.recordId, record.fields]));
    for (const entry of entries) {
      const fields = entry.record_id ? remote.get(entry.record_id) : undefined;
      if (!fields || entry.version !== entry.synced_version) continue;
      const values = cleanValues(row.fields, Object.fromEntries(row.fields.map((field) => [field.key, cellText(fields[field.label])])));
      if (JSON.stringify(values) === JSON.stringify(cleanValues(row.fields, entry.values))) continue;
      await q(`UPDATE collection_entries SET "values" = $3::jsonb, edited = TRUE, last_edit_at = $4, version = version + 1, synced_version = synced_version + 1, updated_at = now()
        WHERE request_id = $1 AND person_id = $2 AND version = $5`, [entry.request_id, entry.person_id, JSON.stringify(values), deps.now(), entry.version]);
    }
    if (row.sync_error) await q("UPDATE collections SET sync_error = NULL WHERE id = $1", [row.id]);
  } catch (error) {
    await q("UPDATE collections SET sync_error = $2 WHERE id = $1", [row.id, ((error as Error).message || String(error)).slice(0, 500)]);
  }
}

export async function collectionTick(deps: CollectionDeps): Promise<void> {
  const now = deps.now();
  await openDueRounds(deps, now);
  await remind(deps, now);
  await refillFromWeeklyReviews(deps, now);
  await recordShadowNudges(deps, now);
  const open = (await deps.pool.query(`SELECT DISTINCT r.collection_id FROM collection_rounds r JOIN collections c ON c.id = r.collection_id
    WHERE r.deadline_at > $1::timestamptz - interval '14 days'`, [now])).rows as { collection_id: string }[];
  for (const { collection_id: id } of open) await syncCollection(deps, id);
}

export function collectionJobs(deps: CollectionDeps): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return { handlers: { [COLLECTION_TICK_KIND]: () => collectionTick(deps) }, recurring: [{ kind: COLLECTION_TICK_KIND, everyMs: 60_000 }] };
}

// ---------- 设置里的定时任务区 ----------

const cadenceOf = (deadline: Date) => { const d = local(deadline); return `每周${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} 截止`; };

export async function listSchedules(q: Query, viewer: { personId: string; isCeo: boolean }, secret: string): Promise<TScheduleItem[]> {
  const collections = (await q(`SELECT c.*, last.request_id AS last_request_id, last.opens_at AS last_opens_at, last.deadline_at AS last_deadline_at FROM collections c
    LEFT JOIN LATERAL (SELECT request_id, opens_at, deadline_at FROM collection_rounds r WHERE r.collection_id = c.id ORDER BY seq DESC LIMIT 1) last ON TRUE
    WHERE c.initiator_id = $1 AND c.weekly AND c.status <> 'draft' ORDER BY c.status = 'stopped', c.sent_at DESC`, [viewer.personId])).rows as
    (CollectionRow & { last_request_id: string | null; last_opens_at: Date | null; last_deadline_at: Date | null })[];
  const items: TScheduleItem[] = collections.map((row) => ({
    id: `collection:${row.id}`, category: "collect", origin: "collection", name: row.title, cadence: cadenceOf(row.last_deadline_at ?? row.deadline_at),
    nextRunAt: row.status === "active" && row.last_opens_at ? new Date(row.last_opens_at.getTime() + WEEK_MS).toISOString() : null,
    active: row.status === "active", href: row.last_request_id ? `${viewer.isCeo ? "" : "/me"}/requests/${row.last_request_id}` : null, deviceName: null,
    actions: row.status === "active" ? [sign(secret, { actionType: "collection.stop", objectType: "collection", objectId: row.id, objectVersion: row.version }, "停用")] : [],
  }));
  const moved = (await q(`SELECT s.id, s.name, s.cadence, COALESCE(d.device_name, s.source_device_id) AS device_name FROM schedules s
    LEFT JOIN (SELECT device_id, max(device_name) AS device_name FROM collector_health WHERE person_id = $1 GROUP BY device_id) d ON d.device_id = s.source_device_id
    WHERE s.person_id = $1 ORDER BY s.created_at`, [viewer.personId])).rows as { id: string; name: string; cadence: string | null; device_name: string }[];
  for (const row of moved) items.push({ id: `local:${row.id}`, category: "other", origin: "local", name: row.name, cadence: row.cadence, nextRunAt: null,
    active: true, href: null, deviceName: row.device_name, actions: [] });
  return items;
}
