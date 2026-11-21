import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentKind, type TReplyTeamDeliveryRequest, type TReviewBuddyReplyRequest, type TSendTeamDeliveryRequest,
} from "@warmap/contracts";
import { colleagueAccess } from "./colleagueAccess.js";
import { transact } from "./dbTransaction.js";
import { enqueueJob } from "./jobs.js";
import { htmlToText } from "./meetingEvidence.js";
import { MAX_MATERIAL_FILE_BYTES, MaterialParseError, runWorker } from "./materialParser.js";
import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { attachmentMimeType, listShareableSessionAttachments, readSessionAttachment } from "./sessionAttachments.js";
import { answeringLate, BUDDY_NOT_ANSWERED, latestReply, readTeamDelivery } from "./teamDeliveryInbox.js";
export { listPendingTeamRequests, listTeamDeliveries, readTeamDelivery } from "./teamDeliveryInbox.js";

/** people：人员目录里真人的名字；directory：整份人员目录（能不能问同事的伙伴由 colleagueAccess 按它判）。 */
/** dispatchNow：jobs 的 runNow，代答入队后立即跑；不给就只等轮询。 */
export type TeamDeliveryDeps = { q: Query; pool: Pool; storageDir: string; now: () => Date; people: ReadonlyMap<string, string>; directory: PeopleDirectory;
  dispatchNow?: (jobId: string) => Promise<unknown> };
type Upload = { filename: string; buffer: Buffer };
type Source = { id: string; sha256: string };
type FileInfo = { fileName: string; mimeType: string; size: number; sha256: string };
export class TeamDeliveryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const absent = () => new TeamDeliveryError(404, "NOT_FOUND", "来件或文件不存在，或你没有读取权限");
const mismatch = () => new TeamDeliveryError(409, "ATTACHMENT_VERSION_CHANGED", "原件与发送时的版本不符，请联系发送人提供可分享版本");
const invalid = (message: string) => new TeamDeliveryError(400, "INVALID_INPUT", message);
const sha = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

function prepareFiles(uploads: Upload[], sources: Source[]) {
  if (uploads.length + sources.length > ATTACHMENT_MAX_COUNT) throw new TeamDeliveryError(413, "TOO_MANY_ATTACHMENTS", "最多 20 个附件");
  return uploads.map(({ filename, buffer }) => {
    const fileName = filename.split(/[\\/]/).pop()?.trim() ?? "";
    const kind = attachmentKind(fileName);
    if (!kind || fileName.length > 255 || /[\u0000-\u001f\u007f]/.test(fileName)) throw invalid("文件名或文件格式不支持");
    if (!buffer.length || buffer.length > ATTACHMENT_MAX_BYTES) throw invalid("附件须非空且不超过 30 MB");
    return { buffer, fileName, mimeType: attachmentMimeType(fileName, kind), size: buffer.length, sha256: sha(buffer) };
  });
}
type Prepared = ReturnType<typeof prepareFiles>;
const fileFingerprint = (files: Prepared) => files.map(({ fileName, size, sha256 }) => [fileName, size, sha256]);

function sameOperation(saved: string, actual: string) {
  if (saved !== actual) throw new TeamDeliveryError(409, "IDEMPOTENCY_CONFLICT", "这次发送标识已用于不同内容，请使用新的发送标识");
}

async function sourceFile(q: Query, storageDir: string, sharer: string, source: Source) {
  const found = await readSessionAttachment(q, storageDir, sharer, source.id);
  if (!found) throw absent();
  if (found.attachment.sha256 !== source.sha256 || found.attachment.size !== found.data.length || sha(found.data) !== source.sha256) throw mismatch();
  return found;
}

async function attachFiles(q: Query, storageDir: string, actor: string, requestId: string, replyId: string | null,
  uploads: Prepared, sources: Source[], createdFiles: string[]) {
  let position = 0;
  const record = async (id: string, sourceId: string | null, file: FileInfo) => {
    await q("INSERT INTO team_delivery_attachments(id,request_id,reply_id,shared_by,source_attachment_id,position,file_name,mime_type,size,sha256) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, requestId, replyId, actor, sourceId, position++, file.fileName, file.mimeType, file.size, file.sha256]);
  };
  for (const source of sources) {
    const { attachment } = await sourceFile(q, storageDir, actor, source);
    await record(randomUUID(), source.id, attachment);
  }
  if (uploads.length) await mkdir(join(storageDir, "team-deliveries"), { recursive: true, mode: 0o700 });
  for (const file of uploads) {
    const id = randomUUID();
    const path = join(storageDir, "team-deliveries", id);
    const handle = await open(path, "wx", 0o600);
    createdFiles.push(path);
    try { await handle.writeFile(file.buffer); } finally { await handle.close(); }
    await record(id, null, file);
  }
}

export const listTeamDeliverySources = (deps: TeamDeliveryDeps, viewer: string) => listShareableSessionAttachments(deps.q, viewer);

async function projectWritten(deps: TeamDeliveryDeps, actor: string, id: string) {
  const delivery = await readTeamDelivery(deps, actor, id);
  if (!delivery) throw absent();
  return delivery;
}

async function setRequestStatus(q: Query, id: string) {
  await q("UPDATE requests SET status=CASE WHEN EXISTS (SELECT 1 FROM request_recipients rr WHERE rr.request_id=requests.id " +
    "AND (rr.team_delivery_error IS NOT NULL OR (requests.team_kind='question' AND rr.status='pending'))) THEN 'open' ELSE 'done' END," +
    "updated_at=clock_timestamp() WHERE id=$1", [id]);
}

export const TEAM_BUDDY_ANSWER_JOB = "team.buddy-answer";
/** 被问的人每天被代答最多几次；同一个问的人对同一个被问的人每天最多几次（A7，公司时区，发出时占名额，重试不另占）。 */
export const BUDDY_DAILY_ANSWERS = 20;
export const BUDDY_DAILY_PER_ASKER = 10;
/** triggerId：追问那条回复的 id，首问为 null。 */
export type BuddyAnswerTrigger = { requestId: string; recipientId: string; triggerId: string | null };
export const buddyAnswerKey = (trigger: BuddyAnswerTrigger) =>
  `${TEAM_BUDDY_ANSWER_JOB}:${trigger.requestId}:${trigger.recipientId}:${trigger.triggerId ?? "q"}`;

/**
 * 代答不等每 5 秒一轮的轮询（轮询里一条一条串着跑）：事务提交后，给了 dispatchNow 就把这一单还没被领的代答作业立即派出去，不等它跑完。
 * 作业照常排着兜底：派之前进程退出，轮询照样领到；直派和轮询只有一方领得到（jobs.ts runNow）。
 */
async function dispatchBuddy(deps: TeamDeliveryDeps, requestId: string) {
  if (!deps.dispatchNow) return;
  const jobs = (await deps.q("SELECT id::text FROM jobs WHERE kind=$1 AND status='pending' AND dedupe_key LIKE $2",
    [TEAM_BUDDY_ANSWER_JOB, `${TEAM_BUDDY_ANSWER_JOB}:${requestId}:%`])).rows as { id: string }[];
  for (const job of jobs)
    void deps.dispatchNow(job.id).catch((error: Error) => console.warn(`team buddy answer dispatch failed, left to jobs: ${error.message}`));
}

async function startBuddy(q: Query, trigger: BuddyAnswerTrigger, dedupeKey: string, now: Date) {
  await q("UPDATE request_recipients SET buddy_state='answering',buddy_note=NULL,buddy_asked_at=$3,buddy_asked_owner=false WHERE request_id=$1 AND person_id=$2",
    [trigger.requestId, trigger.recipientId, now]);
  await enqueueJob(q, { kind: TEAM_BUDDY_ANSWER_JOB, dedupeKey, payload: trigger });
}

/**
 * 在调用方的事务里：先问 colleagueAccess(ask)；不可以就什么都不做、回 false（这位收件人照没有伙伴的老路走）。
 * 可以：当天名额满了标「超上限」（不入队，不进被问的人的等你，问的人只能问本人）；没满就占一个名额、标「伙伴在答」并入队。都回 true。
 * 去重键 team.buddy-answer:<requestId>:<recipientId>:<triggerId 或 q>；名额按同一个触发记一行。同一个触发已经记过账的直接回 true（不另占、不重置状态）。
 */
export async function askBuddy(q: Query, directory: PeopleDirectory, asker: string, trigger: BuddyAnswerTrigger, now: Date): Promise<boolean> {
  if (!(await colleagueAccess(q, directory, asker, trigger.recipientId, "ask")).allowed) return false;
  // 同一个被问的人的名额串行数，事务结束释放。
  await q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["team-buddy-asks/" + trigger.recipientId]);
  if ((await q("SELECT 1 FROM team_buddy_asks WHERE request_id=$1 AND recipient_id=$2 AND trigger_key=$3",
    [trigger.requestId, trigger.recipientId, trigger.triggerId ?? "q"])).rowCount) return true;
  const used = (await q(`SELECT count(*)::int AS total,count(*) FILTER (WHERE asker_id=$3)::int AS mine FROM team_buddy_asks WHERE recipient_id=$1
    AND date_trunc('day',asked_at AT TIME ZONE 'Asia/Shanghai')=date_trunc('day',$2::timestamptz AT TIME ZONE 'Asia/Shanghai')`,
  [trigger.recipientId, now, asker])).rows[0] as { total: number; mine: number };
  const full = used.total >= BUDDY_DAILY_ANSWERS ? `今天伙伴代答已到 ${BUDDY_DAILY_ANSWERS} 次`
    : used.mine >= BUDDY_DAILY_PER_ASKER ? `今天问这位同事的伙伴已到 ${BUDDY_DAILY_PER_ASKER} 次` : null;
  if (full) {
    await q("UPDATE request_recipients SET buddy_state='limited',buddy_note=$3,buddy_asked_at=$4,buddy_asked_owner=false WHERE request_id=$1 AND person_id=$2",
      [trigger.requestId, trigger.recipientId, full, now]);
    return true;
  }
  await q("INSERT INTO team_buddy_asks(request_id,recipient_id,trigger_key,asker_id,asked_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [trigger.requestId, trigger.recipientId, trigger.triggerId ?? "q", asker, now]);
  await startBuddy(q, trigger, buddyAnswerKey(trigger), now);
  return true;
}

function sourceUrl(raw: string | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return raw;
  } catch { /* 输入校验在下面统一返回。 */ }
  throw invalid("来源须是有效的 HTTP 或 HTTPS 链接");
}
const accountMissing = "这位成员还没有可登录的伙伴账号，开通后可单独重试";

export async function sendTeamDelivery(deps: TeamDeliveryDeps, actor: string, input: TSendTeamDeliveryRequest, uploads: Upload[] = []) {
  const text = input.text?.trim() ?? "";
  const url = sourceUrl(input.sourceUrl);
  const sources = input.sourceAttachments ?? [];
  const files = prepareFiles(uploads, sources);
  const recipients = [...new Set(input.recipientIds)].sort();
  if (input.kind === "question" && !text) throw invalid("请填写要征集的问题");
  if (!text && !url && !sources.length && !files.length) throw invalid("请填写内容、来源或添加文件");
  if (input.dueAt && input.kind !== "question") throw invalid("只有临时问题可设置截止时间");
  const dueAt = input.dueAt ? new Date(input.dueAt).toISOString() : null;
  const fingerprint = sha(JSON.stringify([input.kind, recipients, text, url, dueAt, sources.map(s => [s.id, s.sha256]), fileFingerprint(files)]));
  const id = await transact(deps.pool, async (q, createdFiles) => {
    // 同发送人、同操作串行，失败事务释放锁；另一个请求读取已提交的原件身份。
    await q("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [actor + "/" + input.clientId.toLowerCase()]);
    const existing = (await q("SELECT id,team_fingerprint FROM requests WHERE initiator_id=$1 AND team_client_id=$2 AND team_kind IS NOT NULL",
      [actor, input.clientId])).rows[0];
    if (existing) { sameOperation(existing.team_fingerprint, fingerprint); return existing.id as string; }
    if (!recipients.length || recipients.some(person => person === actor || !deps.people.has(person))) throw invalid("请选择人员目录里的其他成员");
    const accounts = (await q("SELECT person_id FROM member_access WHERE person_id=ANY($1::text[])", [recipients])).rows;
    const active = new Set(accounts.map(row => row.person_id as string));
    const requestId = randomUUID();
    const title = (text || files[0]?.fileName || url || "分享文件").slice(0, 200);
    await q("INSERT INTO requests (id,kind,initiator_id,prompt,title,body,status,sent_at,created_at,updated_at,team_kind,team_client_id,team_fingerprint,team_source_url,team_due_at) " +
      "VALUES ($1,'relay',$2,$3,$3,$4,'open',$5,$5,$5,$6,$7,$8,$9,$10)",
    [requestId, actor, title, text, deps.now(), input.kind, input.clientId, fingerprint, url, dueAt]);
    for (const person of recipients) {
      await q("INSERT INTO request_recipients(request_id,person_id,team_delivery_error) VALUES($1,$2,$3)",
        [requestId, person, active.has(person) ? null : accountMissing]);
    }
    await attachFiles(q, deps.storageDir, actor, requestId, null, files, sources, createdFiles);
    // 只问一个人、没附件、没截止的征集先交他的伙伴答（A6）；能不能问由 askBuddy 里的 colleagueAccess 定。
    if (input.kind === "question" && recipients.length === 1 && !dueAt && !sources.length && !files.length && active.has(recipients[0]))
      await askBuddy(q, deps.directory, actor, { requestId, recipientId: recipients[0], triggerId: null }, deps.now());
    await setRequestStatus(q, requestId);
    return requestId;
  });
  await dispatchBuddy(deps, id);
  return projectWritten(deps, actor, id);
}

export async function retryTeamRecipient(deps: TeamDeliveryDeps, actor: string, id: string, personId: string) {
  await transact(deps.pool, async q => {
    const target = (await q("SELECT rr.team_delivery_error FROM requests r JOIN request_recipients rr ON rr.request_id=r.id " +
      "WHERE r.id=$1 AND r.team_kind IS NOT NULL AND r.initiator_id=$2 AND rr.person_id=$3 FOR UPDATE OF r,rr", [id, actor, personId])).rows[0];
    if (!target) throw absent();
    if (target.team_delivery_error === null) return;
    const account = deps.people.has(personId) && (await q("SELECT 1 FROM member_access WHERE person_id=$1", [personId])).rowCount;
    await q("UPDATE request_recipients SET team_delivery_error=$3 WHERE request_id=$1 AND person_id=$2", [id, personId, account ? null : accountMissing]);
    await setRequestStatus(q, id);
  });
  return projectWritten(deps, actor, id);
}

/**
 * 被问的人亲自回了（答复、需要补充、把往来答完的更正）：本人接手，之后照普通征集走。伙伴在答、答了、没答上来、超上限的标记都清掉
 * （作业见他不在「伙伴在答」就不落；回复各自的来源照旧）。转本人的不清。
 */
const clearBuddyWait = (q: Query, id: string, person: string) => q("UPDATE request_recipients SET buddy_state=NULL,buddy_note=NULL,buddy_asked_at=NULL " +
  "WHERE request_id=$1 AND person_id=$2 AND buddy_state IN ('answering','answered','failed','limited')", [id, person]);

export async function replyTeamDelivery(deps: TeamDeliveryDeps, actor: string, id: string, input: TReplyTeamDeliveryRequest, uploads: Upload[] = []) {
  const text = input.text?.trim() ?? "";
  const sources = input.sourceAttachments ?? [];
  const files = prepareFiles(uploads, sources);
  if (!text && !sources.length && !files.length) throw invalid("请写回复或添加文件");
  // 补充说明和追问是发起人发给指定接收人的。
  const fromAsker = input.status === "clarification" || input.status === "follow_up";
  const recipient = fromAsker ? input.recipientId : actor;
  if (!recipient || (!fromAsker && input.recipientId && input.recipientId !== actor)) throw invalid("接收人无效");
  const fingerprint = sha(JSON.stringify([input.status, recipient, text, sources.map(s => [s.id, s.sha256]), fileFingerprint(files)]));
  await transact(deps.pool, async (q, createdFiles) => {
    const row = (await q("SELECT r.initiator_id,r.team_kind,rr.status,rr.buddy_state FROM requests r JOIN request_recipients rr ON rr.request_id=r.id " +
      "WHERE r.id=$1 AND r.team_kind IS NOT NULL AND rr.person_id=$3 AND rr.team_delivery_error IS NULL " +
      "AND (r.initiator_id=$2 OR rr.person_id=$2) FOR UPDATE OF r,rr", [id, actor, recipient])).rows[0];
    if (!row) throw absent();
    if (row.team_kind !== "question") throw new TeamDeliveryError(409, "NOT_A_QUESTION", "只有临时问题可以回复");
    if (fromAsker !== (row.initiator_id === actor)) throw new TeamDeliveryError(403, "FORBIDDEN", "只能处理本人这次征集的回复");
    const existing = (await q("SELECT fingerprint FROM team_delivery_replies WHERE request_id=$1 AND author_id=$2 AND client_id=$3",
      [id, actor, input.clientId])).rows[0];
    if (existing) { sameOperation(existing.fingerprint, fingerprint); return; }
    if (input.status === "clarification") {
      const latest = (await q(latestReply("$1", "$2"), [id, recipient])).rows[0];
      if (latest?.status !== "needs_info") throw new TeamDeliveryError(409, "CLARIFICATION_NOT_REQUESTED", "该成员目前没有待澄清的问题");
    }
    // 转给本人、他还没答完的：追问会把这条从他的等你里拿走、又交回伙伴，所以不收，等本人回（他要补充的走补充说明）。
    if (input.status === "follow_up" && row.buddy_state === "handoff" && row.status === "pending")
      throw new TeamDeliveryError(409, "BUDDY_HANDOFF", "这一条已经转给本人，等本人回复");
    if (input.status === "follow_up" && !(await q("SELECT 1 FROM team_delivery_replies WHERE request_id=$1 AND recipient_id=$2 AND origin='buddy' LIMIT 1",
      [id, recipient])).rowCount) throw new TeamDeliveryError(409, "FOLLOW_UP_NOT_AVAILABLE", "这位同事的伙伴还没答过这一条");
    const replyId = randomUUID();
    const at = deps.now();
    await q("INSERT INTO team_delivery_replies(id,request_id,recipient_id,author_id,client_id,fingerprint,status,body,created_at) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [replyId, id, recipient, actor, input.clientId, fingerprint, input.status, text, at]);
    await attachFiles(q, deps.storageDir, actor, id, replyId, files, sources, createdFiles);
    const answered = input.status === "answered";
    await q("UPDATE request_recipients SET status=$3,done_by=$4,done_at=$5 WHERE request_id=$1 AND person_id=$2",
      [id, recipient, answered ? "done" : "pending", answered ? actor : null, answered ? at : null]);
    if (!fromAsker) await clearBuddyWait(q, id, recipient);
    // 追问：收件人回到待回复，交他的伙伴带着整段往来再答（占名额同首问）。不让问了就整笔回滚，追问不落库。
    if (input.status === "follow_up" && !(await askBuddy(q, deps.directory, actor, { requestId: id, recipientId: recipient, triggerId: replyId }, at))) throw unavailable();
    await setRequestStatus(q, id);
  });
  if (input.status === "follow_up") await dispatchBuddy(deps, id);
  return projectWritten(deps, actor, id);
}

/** 问的人对伙伴没答上来、超上限的那位收件人：只有发起人，只限没投递失败的征集。 */
async function buddyTarget(q: Query, actor: string, id: string, personId: string) {
  const row = (await q("SELECT rr.buddy_state,rr.buddy_note,rr.buddy_asked_at FROM requests r JOIN request_recipients rr ON rr.request_id=r.id " +
    "WHERE r.id=$1 AND r.team_kind='question' AND r.initiator_id=$2 AND rr.person_id=$3 AND rr.team_delivery_error IS NULL FOR UPDATE OF rr",
  [id, actor, personId])).rows[0] as { buddy_state: string | null; buddy_note: string | null; buddy_asked_at: Date | null } | undefined;
  if (!row) throw absent();
  return row;
}
const notStuck = () => new TeamDeliveryError(409, "BUDDY_NOT_STUCK", "这一条现在不用重试或转本人");
/** colleagueAccess 不让问了（问的人或被问的人不再被覆盖）：重试和追问都回这个。 */
const unavailable = () => new TeamDeliveryError(409, "BUDDY_UNAVAILABLE", "这位同事的伙伴现在不能代答，可以直接问本人");

/** 「重试」：伙伴没答上来（含在答超过 2 分钟）时重新入队，不另占名额；在答还没超时的照旧（不重复入队）；超上限 409。 */
export async function retryTeamBuddy(deps: TeamDeliveryDeps, actor: string, id: string, personId: string) {
  await transact(deps.pool, async q => {
    const row = await buddyTarget(q, actor, id, personId);
    const now = deps.now();
    const late = answeringLate(row.buddy_state, row.buddy_asked_at, now);
    if (row.buddy_state === "limited") throw new TeamDeliveryError(409, "BUDDY_LIMIT", "今天的代答次数满了，可以直接问本人");
    if (row.buddy_state === "answering" && !late) return;
    if (row.buddy_state !== "failed" && !late) throw notStuck();
    if (!(await colleagueAccess(q, deps.directory, actor, personId, "ask")).allowed) throw unavailable();
    const latest = (await q(latestReply("$1", "$2"), [id, personId])).rows[0];
    const trigger = { requestId: id, recipientId: personId, triggerId: (latest?.id as string | undefined) ?? null };
    await startBuddy(q, trigger, `${buddyAnswerKey(trigger)}:retry-${now.getTime()}`, now);
  });
  await dispatchBuddy(deps, id);
  return projectWritten(deps, actor, id);
}

/** 「问本人」：伙伴没答上来或超上限时，这条变成普通征集进被问的人的等你（转本人，原因留着）。已经转了的照旧。 */
export async function askTeamOwner(deps: TeamDeliveryDeps, actor: string, id: string, personId: string) {
  await transact(deps.pool, async q => {
    const row = await buddyTarget(q, actor, id, personId);
    if (row.buddy_state === "handoff") return;
    const late = answeringLate(row.buddy_state, row.buddy_asked_at, deps.now());
    if (row.buddy_state !== "failed" && row.buddy_state !== "limited" && !late) throw notStuck();
    await q("UPDATE request_recipients SET buddy_state='handoff',buddy_note=$3,buddy_asked_owner=true WHERE request_id=$1 AND person_id=$2",
      [id, personId, late ? BUDDY_NOT_ANSWERED : row.buddy_note]);
  });
  return projectWritten(deps, actor, id);
}

const reviewed = () => new TeamDeliveryError(409, "ALREADY_REVIEWED", "这一条已经看过或改过了");
/**
 * 被问的人更正 corrected 那条伙伴答复时，这段往来还没答完（更正只补旧答复、提醒问的人，不算答了，收件人和伙伴的状态都不动）：
 * 最新一条（latestReply，更正不算）是问的人的追问、补充说明（他在等回答）；或是被问的人的「需要补充」（他在等补充说明）；
 * 或是伙伴转本人的那条答复（buddy_state='handoff'）而改的不是它。改的正是转本人那条，算他亲自回了。
 * 只在落更正时判这一次，结果写在收件人行上；读卡和等你只读收件人行和最新一条，不再判。
 */
const answerStillOpen = (latest: { id: string; status: string; origin: string } | undefined, buddyState: string | null, corrected: string) =>
  latest?.status === "follow_up" || latest?.status === "clarification" || latest?.status === "needs_info"
  || (latest?.origin === "buddy" && buddyState === "handoff" && latest.id !== corrected);

/**
 * 被问的人看伙伴替他答的那条（只限这条伙伴答复的被问的人，别的一律 404）。ok：标看过，看过或改过的 409；转本人时（伙伴判的或问的人转的）
 * 要本人亲自回，ok 409 BUDDY_HANDOFF。corrected：伙伴那条原话保留并标看过，另起一条本人的答复（corrects 指向它）进问的人的等你，收件人算已答；
 * 但这段往来还没答完时（answerStillOpen）只落这条更正，收件人和伙伴的状态不动。点过「没问题」也能改，一条最多改一次。
 * 按 clientId 幂等：一样的照旧 200，不一样的 409。
 */
export async function reviewBuddyReply(deps: TeamDeliveryDeps, actor: string, id: string, replyId: string, input: TReviewBuddyReplyRequest) {
  const text = input.verdict === "corrected" ? input.text.trim() : "";
  if (input.verdict === "corrected" && !text) throw invalid("请写更正的内容");
  await transact(deps.pool, async q => {
    const target = (await q(`SELECT p.reviewed_at,rr.buddy_state FROM team_delivery_replies p JOIN requests r ON r.id=p.request_id
      JOIN request_recipients rr ON rr.request_id=p.request_id AND rr.person_id=p.recipient_id
      WHERE p.request_id=$1 AND p.id=$2 AND p.recipient_id=$3 AND p.origin='buddy' AND r.team_kind='question' AND rr.team_delivery_error IS NULL
      FOR UPDATE OF p,rr`, [id, replyId, actor])).rows[0] as { reviewed_at: Date | null; buddy_state: string | null } | undefined;
    if (!target) throw absent();
    const at = deps.now();
    if (input.verdict === "ok") {
      if (target.buddy_state === "handoff") throw new TeamDeliveryError(409, "BUDDY_HANDOFF", "转给你本人的这一条，请直接回复或改一下");
      if (target.reviewed_at) throw reviewed();
      await q("UPDATE team_delivery_replies SET reviewed_at=$3 WHERE request_id=$1 AND id=$2", [id, replyId, at]);
      return;
    }
    const fingerprint = sha(JSON.stringify(["corrected", replyId, text]));
    const existing = (await q("SELECT fingerprint FROM team_delivery_replies WHERE request_id=$1 AND author_id=$2 AND client_id=$3",
      [id, actor, input.clientId])).rows[0];
    if (existing) { sameOperation(existing.fingerprint, fingerprint); return; }
    if ((await q("SELECT 1 FROM team_delivery_replies WHERE request_id=$1 AND corrects=$2", [id, replyId])).rowCount) throw reviewed();
    const open = answerStillOpen((await q(latestReply("$1", "$2"), [id, actor])).rows[0], target.buddy_state, replyId);
    await q("UPDATE team_delivery_replies SET reviewed_at=COALESCE(reviewed_at,$3) WHERE request_id=$1 AND id=$2", [id, replyId, at]);
    await q("INSERT INTO team_delivery_replies(id,request_id,recipient_id,author_id,client_id,fingerprint,status,body,created_at,corrects) " +
      "VALUES($1,$2,$3,$3,$4,$5,'answered',$6,$7,$8)", [randomUUID(), id, actor, input.clientId, fingerprint, text, at, replyId]);
    if (open) return;
    await q("UPDATE request_recipients SET status='done',done_by=$2,done_at=$3 WHERE request_id=$1 AND person_id=$2", [id, actor, at]);
    await clearBuddyWait(q, id, actor);
    await setRequestStatus(q, id);
  });
  return projectWritten(deps, actor, id);
}

/** 问的人「知道了」这条更正：只有发起人，只限更正；已经点过的照旧 200。 */
export async function markCorrectionSeen(deps: TeamDeliveryDeps, actor: string, id: string, replyId: string) {
  const seen = await deps.q(`UPDATE team_delivery_replies p SET correction_seen_at=COALESCE(p.correction_seen_at,$3) FROM requests r
    WHERE r.id=p.request_id AND p.request_id=$1 AND p.id=$2 AND p.corrects IS NOT NULL AND r.initiator_id=$4 AND r.team_kind='question'`,
  [id, replyId, deps.now(), actor]);
  if (!seen.rowCount) throw absent();
  return projectWritten(deps, actor, id);
}

/** 来件文件仅对指定成员可读，回复附件只对该接收人和发起人可读。读其他原对象仍走它自己的权限。 */
export async function readTeamFile(deps: TeamDeliveryDeps, actor: string, id: string, attachmentId: string) {
  const file = (await deps.q("SELECT f.* FROM team_delivery_attachments f JOIN requests r ON r.id=f.request_id " +
    "LEFT JOIN team_delivery_replies p ON p.request_id=r.id AND p.id=f.reply_id WHERE r.id=$1 AND f.id=$3 AND r.team_kind IS NOT NULL " +
    "AND (r.initiator_id=$2 OR EXISTS (SELECT 1 FROM request_recipients rr WHERE rr.request_id=r.id AND rr.person_id=$2 " +
    "AND rr.team_delivery_error IS NULL AND (f.reply_id IS NULL OR p.recipient_id=rr.person_id)))", [id, actor, attachmentId])).rows[0];
  if (!file) throw absent();
  let data: Buffer;
  if (file.source_attachment_id) {
    if (!deps.people.has(file.shared_by)) throw absent();
    const found = await sourceFile(deps.q, deps.storageDir, file.shared_by, { id: file.source_attachment_id, sha256: file.sha256 });
    data = found.data;
  } else {
    try { data = await readFile(join(deps.storageDir, "team-deliveries", file.id)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw absent(); throw cause; }
    if (sha(data) !== file.sha256) throw mismatch();
  }
  if (data.length !== file.size) throw mismatch();
  return { data, fileName: file.file_name as string, mimeType: file.mime_type as string, sha256: file.sha256 as string };
}

export async function readTeamFileText(deps: TeamDeliveryDeps, actor: string, id: string, attachmentId: string) {
  const file = await readTeamFile(deps, actor, id, attachmentId);
  const limit = 24_000;
  const unreadable = () => new TeamDeliveryError(422, "ATTACHMENT_NO_TEXT", "未能读取有效文字，请打开原件");
  let text: string;
  let truncated = false;
  if (file.mimeType === "application/pdf" || file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (file.data.length > MAX_MATERIAL_FILE_BYTES) throw new TeamDeliveryError(413, "ATTACHMENT_PARSE_TOO_LARGE", "文件超过文字提取上限，请下载原件");
    // 将已验哈希的字节交给已有的带超时、内存及文档格式限制的解析器。
    const directory = await mkdtemp(join(tmpdir(), "team-attachment-"));
    try {
      const path = join(directory, "source");
      await writeFile(path, file.data, { mode: 0o600 });
      try { text = (await runWorker(path, file.mimeType)).text; }
      catch (cause) { if (cause instanceof MaterialParseError) throw unreadable(); throw cause; }
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json" || file.mimeType === "application/xml") {
    // 只解码一段 UTF-8；stream 避免字节上限处截断中文时把它误判为损坏。
    const prefix = file.data.subarray(0, 4 * (limit + 1));
    truncated = prefix.length < file.data.length;
    if (prefix.includes(0)) throw unreadable();
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(prefix, { stream: truncated });
      if (file.mimeType === "text/html") text = htmlToText(text);
    } catch { throw unreadable(); }
  } else throw new TeamDeliveryError(415, "ATTACHMENT_TEXT_UNSUPPORTED", "暂不支持提取这一格式的文字，请下载原件");
  text = text.trim();
  if (!text) throw unreadable();
  return { fileName: file.fileName, text: text.slice(0, limit), truncated: truncated || text.length > limit };
}
