import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, attachmentKind, type TReplyTeamDeliveryRequest, type TSendTeamDeliveryRequest,
} from "@warmap/contracts";
import { htmlToText } from "./meetingEvidence.js";
import { MAX_MATERIAL_FILE_BYTES, MaterialParseError, runWorker } from "./materialParser.js";
import type { Query } from "./meetingStore.js";
import { attachmentMimeType, listShareableSessionAttachments, readSessionAttachment } from "./sessionAttachments.js";
import { readTeamDelivery } from "./teamDeliveryInbox.js";
export { listPendingTeamRequests, listTeamDeliveries, readTeamDelivery } from "./teamDeliveryInbox.js";

export type TeamDeliveryDeps = { q: Query; pool: Pool; storageDir: string; now: () => Date; people: ReadonlyMap<string, string> };
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

async function transact<T>(pool: Pool, work: (q: Query, createdFiles: string[]) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const createdFiles: string[] = [];
  let committing = false;
  try {
    await client.query("BEGIN");
    const result = await work((sql, params) => client.query(sql, params), createdFiles);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    // 连接在提交时断开，数据库可能已成功；此时不得删除已提交来件的原件。
    const dbCode = (cause as { code?: string }).code ?? "";
    if (!committing || /^(?:22|23|40)[0-9A-Z]{3}$/.test(dbCode)) {
      await Promise.all(createdFiles.map((path) => rm(path, { force: true })));
    }
    throw cause;
  } finally { client.release(); }
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
    await setRequestStatus(q, requestId);
    return requestId;
  });
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

export async function replyTeamDelivery(deps: TeamDeliveryDeps, actor: string, id: string, input: TReplyTeamDeliveryRequest, uploads: Upload[] = []) {
  const text = input.text?.trim() ?? "";
  const sources = input.sourceAttachments ?? [];
  const files = prepareFiles(uploads, sources);
  if (!text && !sources.length && !files.length) throw invalid("请写回复或添加文件");
  const recipient = input.status === "clarification" ? input.recipientId : actor;
  if (!recipient || (input.status !== "clarification" && input.recipientId && input.recipientId !== actor)) throw invalid("接收人无效");
  const fingerprint = sha(JSON.stringify([input.status, recipient, text, sources.map(s => [s.id, s.sha256]), fileFingerprint(files)]));
  await transact(deps.pool, async (q, createdFiles) => {
    const row = (await q("SELECT r.initiator_id,r.team_kind FROM requests r JOIN request_recipients rr ON rr.request_id=r.id " +
      "WHERE r.id=$1 AND r.team_kind IS NOT NULL AND rr.person_id=$3 AND rr.team_delivery_error IS NULL " +
      "AND (r.initiator_id=$2 OR rr.person_id=$2) FOR UPDATE OF r,rr", [id, actor, recipient])).rows[0];
    if (!row) throw absent();
    if (row.team_kind !== "question") throw new TeamDeliveryError(409, "NOT_A_QUESTION", "只有临时问题可以回复");
    const clarifying = input.status === "clarification";
    if (clarifying !== (row.initiator_id === actor)) throw new TeamDeliveryError(403, "FORBIDDEN", "只能处理本人这次征集的回复");
    const existing = (await q("SELECT fingerprint FROM team_delivery_replies WHERE request_id=$1 AND author_id=$2 AND client_id=$3",
      [id, actor, input.clientId])).rows[0];
    if (existing) { sameOperation(existing.fingerprint, fingerprint); return; }
    if (clarifying) {
      const latest = (await q("SELECT status FROM team_delivery_replies WHERE request_id=$1 AND recipient_id=$2 ORDER BY seq DESC LIMIT 1", [id, recipient])).rows[0];
      if (latest?.status !== "needs_info") throw new TeamDeliveryError(409, "CLARIFICATION_NOT_REQUESTED", "该成员目前没有待澄清的问题");
    }
    const replyId = randomUUID();
    const at = deps.now();
    await q("INSERT INTO team_delivery_replies(id,request_id,recipient_id,author_id,client_id,fingerprint,status,body,created_at) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [replyId, id, recipient, actor, input.clientId, fingerprint, input.status, text, at]);
    await attachFiles(q, deps.storageDir, actor, id, replyId, files, sources, createdFiles);
    const answered = input.status === "answered";
    await q("UPDATE request_recipients SET status=$3,done_by=$4,done_at=$5 WHERE request_id=$1 AND person_id=$2",
      [id, recipient, answered ? "done" : "pending", answered ? actor : null, answered ? at : null]);
    await setRequestStatus(q, id);
  });
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
