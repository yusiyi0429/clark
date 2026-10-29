import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Pool } from "pg";
import type { TDeliverableItem, TDeliverableNotePatch, TDeliverableReview, TDeliverableVersion, THomePlanTask, TReviewBasis, TTaskDeliverableResponse,
  TTaskDeliverableStatus } from "@warmap/contracts";
import { MAX_MATERIAL_FILE_BYTES, MAX_MATERIAL_TEXT_CHARS, runWorker } from "./materialParser.js";
import { htmlToText } from "./meetingEvidence.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { ownMissions, planTaskMissions } from "./homePlan.js";
import { readPlanTasks, type PlanTaskSource } from "./planTasks.js";
import type { StoredNote, StoredReview } from "./deliverableReview.js";

/**
 * Task 的交付物（spec 5.2–5.4）：只认本人 Mission 下的 Task；本体登记了负责人时只有负责人能传版本、交付，没登记时 Mission 的负责人（就是看的人）能。
 * 一个版本 = 一次评审；只有最新一版、评审完、每一条都达到才能交付。交付和版本说明这一版只记在天枢。
 */

export class DeliverableError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409 | 413, public readonly code: string, message: string) { super(message); }
}

export const MAX_DELIVERABLE_FILES = 10;
const MAX_DELIVERABLE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LINKS = 5;
const MAX_STATEMENT = 2000;
const VERDICT_SCORE = { met: 100, partial: 50, unmet: 0 } as const;

export type OwnTask = { task: THomePlanTask; viewerId: string; responsibleId: string | null; canEdit: boolean; basis: TReviewBasis; criteria: string[] };

/** 本人 Mission 下的这个 Task，带权限和按哪套标准评；不是本人 Mission 下的一律当找不到。 */
export async function findOwnTask(q: Query, planTasks: PlanTaskSource, viewerId: string, now: Date, taskId: string): Promise<OwnTask> {
  const { rows } = await ownMissions(q, viewerId, companyPeriod(now));
  const task = (await readPlanTasks(planTasks, planTaskMissions(rows))).find((item) => item.taskId === taskId);
  if (!task) throw new DeliverableError(404, "NOT_FOUND", "找不到这个 Task");
  const responsibleId = task.responsibleId ?? null;
  const [basis, criteria]: [TReviewBasis, string[]] = task.criteria.length ? ["acceptance", task.criteria]
    : task.doneDefinition ? ["definition", [task.doneDefinition]] : ["none", []];
  return { task, viewerId, responsibleId, canEdit: responsibleId ? responsibleId === viewerId : true, basis, criteria };
}
const requireEdit = (own: OwnTask) => {
  if (!own.canEdit) throw new DeliverableError(403, "FORBIDDEN", "这个 Task 由负责人交付");
};

type VersionRow = { id: string; task_id: string; number: number; statement: string | null; basis: TReviewBasis; criteria: string[];
  review_status: TDeliverableReview["status"]; review_phase: TDeliverableReview["phase"]; review: StoredReview | null; review_error: string | null;
  review_started_at: Date | null; review_finished_at: Date | null; delivered_at: Date | null; note: StoredNote | null; created_at: Date };
type ItemRow = { id: string; version_id: string; kind: TDeliverableItem["kind"]; name: string; mime_type: string | null; size_bytes: number | null;
  page_count: number | null; storage_key: string | null; url: string | null; extracted_text: string | null; read: TDeliverableItem["read"]; read_note: string | null };

/** 达标度：达到 100、部分 50、未达到 0 的平均；可以交付 = 有标准且每一条都达到。 */
function scoreOf(review: StoredReview | null) {
  const criteria = review?.criteria ?? [];
  const met = criteria.filter((item) => item.verdict === "met").length;
  return { score: criteria.length ? Math.round(criteria.reduce((sum, item) => sum + VERDICT_SCORE[item.verdict], 0) / criteria.length) : null,
    met, total: criteria.length, ready: criteria.length > 0 && met === criteria.length };
}

/** 预计用时：最近 20 次评完的中位数，30 秒到 10 分钟之间；还没有评完过的按 2 分钟。 */
async function expectedSeconds(q: Query): Promise<number> {
  const seconds = (await q(`SELECT extract(epoch FROM review_finished_at-review_started_at)::float AS s FROM deliverable_versions
    WHERE review_status='done' AND review_started_at IS NOT NULL AND review_finished_at IS NOT NULL ORDER BY review_finished_at DESC LIMIT 20`)).rows
    .map((row) => Number(row.s)).sort((a, b) => a - b);
  if (!seconds.length) return 120;
  const middle = seconds.length % 2 ? seconds[(seconds.length - 1) / 2] : (seconds[seconds.length / 2 - 1] + seconds[seconds.length / 2]) / 2;
  return Math.min(600, Math.max(30, Math.round(middle)));
}

function versionView(row: VersionRow, items: ItemRow[], expected: number): TDeliverableVersion {
  const review = row.review;
  return {
    id: row.id, number: row.number, statement: row.statement, createdAt: row.created_at.toISOString(),
    items: items.map((item) => ({ id: item.id, kind: item.kind, name: item.name, mimeType: item.mime_type, sizeBytes: item.size_bytes, pageCount: item.page_count,
      url: item.url, read: item.read, readNote: item.read_note })),
    review: { status: row.review_status, phase: row.review_phase, startedAt: row.review_started_at?.toISOString() ?? null,
      finishedAt: row.review_finished_at?.toISOString() ?? null, expectedSeconds: expected, basis: row.basis,
      headline: review?.headline ?? null, summary: review?.summary ?? null, gain: review?.gain ?? null, ...scoreOf(review),
      criteria: (review?.criteria ?? []).map((item) => ({ index: item.index, text: row.criteria[item.index - 1] ?? "", verdict: item.verdict, reason: item.reason,
        evidence: item.evidence, fix: item.fix, dissent: item.dissent })),
      error: row.review_status === "failed" ? row.review_error : null },
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    note: row.note ? { status: row.note.status, achieved: row.note.achieved, gain: row.note.gain, why: row.note.why, lesson: row.note.lesson,
      edited: row.note.edited, dismissed: row.note.dismissed } : null,
  };
}

async function versionsOf(q: Query, taskId: string, versionId?: string): Promise<TDeliverableVersion[]> {
  const rows = (await q(`SELECT * FROM deliverable_versions WHERE task_id=$1 ${versionId ? "AND id=$2" : ""} ORDER BY number DESC`,
    versionId ? [taskId, versionId] : [taskId])).rows as VersionRow[];
  if (!rows.length) return [];
  const items = (await q("SELECT * FROM deliverable_items WHERE version_id=ANY($1::uuid[]) ORDER BY position", [rows.map((row) => row.id)])).rows as ItemRow[];
  const expected = await expectedSeconds(q);
  return rows.map((row) => versionView(row, items.filter((item) => item.version_id === row.id), expected));
}

async function readVersion(q: Query, taskId: string, versionId: string): Promise<TDeliverableVersion> {
  const [version] = await versionsOf(q, taskId, versionId);
  if (!version) throw new DeliverableError(404, "NOT_FOUND", "找不到这一版");
  return version;
}

export async function readTaskDeliverable(q: Query, own: OwnTask, names: Map<string, string>): Promise<TTaskDeliverableResponse> {
  return { taskId: own.task.taskId, responsibleId: own.responsibleId, responsibleName: own.responsibleId ? names.get(own.responsibleId) ?? null : null,
    canEdit: own.canEdit, basis: own.basis, criteria: own.criteria, versions: await versionsOf(q, own.task.taskId) };
}

/** 首页 Task 的状态：按每个 Task 的最新一版。 */
export async function deliverableStatuses(q: Query, taskIds: string[]): Promise<Map<string, TTaskDeliverableStatus>> {
  if (!taskIds.length) return new Map();
  const rows = (await q(`SELECT DISTINCT ON (task_id) task_id,review_status,review,delivered_at FROM deliverable_versions
    WHERE task_id=ANY($1::text[]) ORDER BY task_id, number DESC`, [taskIds])).rows as Pick<VersionRow, "task_id" | "review_status" | "review" | "delivered_at">[];
  return new Map(rows.map((row) => {
    const { score, ready } = scoreOf(row.review);
    const status: TTaskDeliverableStatus["status"] = row.delivered_at ? "delivered" : row.review_status === "queued" || row.review_status === "running" ? "reviewing"
      : row.review_status === "done" && ready ? "ready" : "iterating";
    return [row.task_id, { status, score: status === "reviewing" ? null : score }];
  }));
}

const KINDS: Record<string, { kind: "file" | "image"; mime: string }> = {
  ".pdf": { kind: "file", mime: "application/pdf" },
  ".docx": { kind: "file", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".md": { kind: "file", mime: "text/markdown" },
  ".html": { kind: "file", mime: "text/html" },
  ".htm": { kind: "file", mime: "text/html" },
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".webp": { kind: "image", mime: "image/webp" },
};
const UNREADABLE: Record<string, string> = {
  "application/pdf": "这份 PDF 没有文字层，请导出可复制文字的版本",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "这份 Word 打不开，请另存后重新上传",
  "text/markdown": "这份 Markdown 里没有能读的文字",
  "text/html": "这个网页里没有能读的文字",
};

export type DeliverableFile = { filename: string; buffer: Buffer };
export type DeliverableFields = { links: string[]; statement: string | null; keep: string[] };

const jsonList = (value: string | undefined, code: string, message: string): string[] => {
  if (!value?.trim()) return [];
  try {
    const list = JSON.parse(value) as unknown;
    if (Array.isArray(list) && list.every((item) => typeof item === "string")) return list;
  } catch { /* 落到下面 */ }
  throw new DeliverableError(400, code, message);
};

/** multipart 的文本字段：links、keep 是 JSON 数组；statement 去掉首尾空白。 */
export function parseDeliverableFields(fields: Map<string, string>): DeliverableFields {
  const links = [...new Set(jsonList(fields.get("links"), "INVALID_LINK", "链接要以 http:// 或 https:// 开头").map((link) => link.trim()).filter(Boolean))];
  for (const link of links) {
    let protocol = "";
    try { protocol = new URL(link).protocol; } catch { /* 落到下面 */ }
    if (protocol !== "http:" && protocol !== "https:") throw new DeliverableError(400, "INVALID_LINK", "链接要以 http:// 或 https:// 开头");
  }
  if (links.length > MAX_LINKS) throw new DeliverableError(400, "TOO_MANY_LINKS", `一版最多 ${MAX_LINKS} 个链接`);
  const statement = fields.get("statement")?.trim() || null;
  if (statement && statement.length > MAX_STATEMENT) throw new DeliverableError(400, "STATEMENT_TOO_LONG", `一句话不能超过 ${MAX_STATEMENT} 字`);
  return { links, statement, keep: [...new Set(jsonList(fields.get("keep"), "INVALID_KEEP", "沿用的东西不在上一版里"))] };
}

/** 文件类型按扩展名认；大小在收文件时已限到 20 MB，图片另限 5 MB。 */
function deliverableKind(filename: string, size: number): { kind: "file" | "image"; mime: string } {
  const found = KINDS[extname(filename).toLowerCase()];
  if (!found) throw new DeliverableError(400, "UNSUPPORTED_DELIVERABLE_TYPE", "支持 PDF、Word、Markdown、HTML 和图片");
  if (found.kind === "image" && size > MAX_DELIVERABLE_IMAGE_BYTES) throw new DeliverableError(400, "IMAGE_TOO_LARGE", "图片不能超过 5 MB");
  if (size > MAX_MATERIAL_FILE_BYTES) throw new DeliverableError(413, "FILE_TOO_LARGE", "单份文件不能超过 20 MB");
  if (!size) throw new DeliverableError(400, "EMPTY_FILE", "文件是空的");
  return found;
}

/** 上传时抽文字：读不出来也收下，只标读不了和原因。 */
async function extractText(path: string, mime: string, buffer: Buffer): Promise<{ text: string | null; pageCount: number | null }> {
  try {
    if (mime === "text/html") return { text: htmlToText(new TextDecoder("utf-8").decode(buffer)).trim().slice(0, MAX_MATERIAL_TEXT_CHARS) || null, pageCount: null };
    const result = await runWorker(path, mime as Parameters<typeof runWorker>[1]);
    return { text: result.text.trim().slice(0, MAX_MATERIAL_TEXT_CHARS) || null, pageCount: result.pageCount ?? null };
  } catch {
    return { text: null, pageCount: null };
  }
}

const fileName = (name: string) => basename(name).replace(/[\u0000-\u001f/\\]/g, "_").trim().slice(0, 240) || "未命名";

/** 传一个新版本：沿用上一版的几样（同一份存储）、加文件和链接、附一句话；落库后评审排队，由调用方开始评审。 */
export async function createDeliverableVersion(pool: Pool, own: OwnTask, files: DeliverableFile[], fields: DeliverableFields, storageDir: string): Promise<TDeliverableVersion> {
  requireEdit(own);
  if (files.length > MAX_DELIVERABLE_FILES) throw new DeliverableError(400, "TOO_MANY_FILES", `一版最多 ${MAX_DELIVERABLE_FILES} 份文件`);
  const kinds = files.map((file) => deliverableKind(file.filename, file.buffer.length));
  if (!files.length && !fields.links.length && !fields.statement && !fields.keep.length) throw new DeliverableError(400, "EMPTY_VERSION", "这一版还是空的");
  const versionId = randomUUID(), directory = join(storageDir, "deliverables", versionId);
  const uploaded: Omit<ItemRow, "version_id">[] = [];
  try {
    if (files.length) await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [index, file] of files.entries()) {
      const id = randomUUID(), path = join(directory, id), { kind, mime } = kinds[index];
      await writeFile(path, file.buffer, { mode: 0o600 });
      const { text, pageCount } = kind === "file" ? await extractText(path, mime, file.buffer) : { text: null, pageCount: null };
      uploaded.push({ id, kind, name: fileName(file.filename), mime_type: mime, size_bytes: file.buffer.length, page_count: pageCount,
        storage_key: `deliverables/${versionId}/${id}`, url: null, extracted_text: text,
        read: kind === "image" ? "pending" : text ? "read" : "unreadable", read_note: kind === "file" && !text ? UNREADABLE[mime] : null });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`deliverable:${own.task.taskId}`]);
      const latest = (await client.query("SELECT id,number FROM deliverable_versions WHERE task_id=$1 ORDER BY number DESC LIMIT 1", [own.task.taskId])).rows[0] as { id: string; number: number } | undefined;
      const kept = fields.keep.length && latest
        ? (await client.query("SELECT * FROM deliverable_items WHERE version_id=$1 AND id=ANY($2::uuid[]) ORDER BY position", [latest.id, fields.keep])).rows as ItemRow[] : [];
      if (kept.length !== fields.keep.length) throw new DeliverableError(400, "INVALID_KEEP", "沿用的东西不在上一版里");
      await client.query(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,done_definition,statement,basis,criteria)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [versionId, own.task.taskId, own.task.missionId, own.viewerId, (latest?.number ?? 0) + 1,
        own.task.name, own.task.doneDefinition, fields.statement, own.basis, JSON.stringify(own.criteria)]);
      const items = [...kept.map(({ version_id: _version, ...item }) => ({ ...item, id: randomUUID() })), ...uploaded,
        ...fields.links.map((url) => ({ id: randomUUID(), kind: "link" as const, name: url.slice(0, 2000), mime_type: null, size_bytes: null, page_count: null,
          storage_key: null, url, extracted_text: null, read: "pending" as const, read_note: null }))];
      for (const [position, item] of items.entries())
        await client.query(`INSERT INTO deliverable_items(id,version_id,position,kind,name,mime_type,size_bytes,page_count,storage_key,url,extracted_text,read,read_note)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [item.id, versionId, position, item.kind, item.name, item.mime_type, item.size_bytes, item.page_count,
          item.storage_key, item.url, item.extracted_text, item.read, item.read_note]);
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally { client.release(); }
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
  return readVersion(pool.query.bind(pool), own.task.taskId, versionId);
}

async function versionRow(q: Query, own: OwnTask, versionId: string): Promise<VersionRow> {
  const row = (await q("SELECT * FROM deliverable_versions WHERE id=$1 AND task_id=$2", [versionId, own.task.taskId])).rows[0] as VersionRow | undefined;
  if (!row) throw new DeliverableError(404, "NOT_FOUND", "找不到这一版");
  return row;
}

/** 交付：只交最新一版，评审完且每一条都达到；交付后版本说明排队（调用方开始写）。已交付的原样返回。 */
export async function deliverVersion(q: Query, own: OwnTask, versionId: string, now: Date): Promise<TDeliverableVersion> {
  requireEdit(own);
  const row = await versionRow(q, own, versionId);
  if (!row.delivered_at) {
    const latest = (await q("SELECT max(number) AS number FROM deliverable_versions WHERE task_id=$1", [own.task.taskId])).rows[0].number as number;
    if (row.number !== latest) throw new DeliverableError(409, "NOT_LATEST", "只能交付最新的一版");
    if (row.review_status !== "done" || !scoreOf(row.review).ready) throw new DeliverableError(409, "NOT_READY", "还有没达到的标准");
    const note: StoredNote = { status: "writing", achieved: null, gain: null, why: null, lesson: null, edited: false, dismissed: false };
    await q("UPDATE deliverable_versions SET delivered_at=$2,note=$3::jsonb WHERE id=$1 AND delivered_at IS NULL", [versionId, now, JSON.stringify(note)]);
  }
  return readVersion(q, own.task.taskId, versionId);
}

/** 撤回交付：清掉交付时间和版本说明。 */
export async function withdrawVersion(q: Query, own: OwnTask, versionId: string): Promise<TDeliverableVersion> {
  requireEdit(own);
  const row = await versionRow(q, own, versionId);
  if (!row.delivered_at) throw new DeliverableError(409, "NOT_DELIVERED", "这一版还没交付");
  await q("UPDATE deliverable_versions SET delivered_at=NULL,note=NULL WHERE id=$1", [versionId]);
  return readVersion(q, own.task.taskId, versionId);
}

/** 改版本说明：改了哪一句就算本人改过；dismissed 是不要这段。 */
export async function patchVersionNote(q: Query, own: OwnTask, versionId: string, patch: TDeliverableNotePatch): Promise<TDeliverableVersion> {
  requireEdit(own);
  const row = await versionRow(q, own, versionId);
  if (!row.note) throw new DeliverableError(409, "NO_NOTE", "这一版还没有说明");
  if (row.note.status === "writing") throw new DeliverableError(409, "NOTE_WRITING", "说明还在写");
  const texts = (["achieved", "gain", "why", "lesson"] as const).filter((key) => patch[key] !== undefined);
  const note: StoredNote = { ...row.note, ...Object.fromEntries(texts.map((key) => [key, patch[key]?.trim() || null])),
    ...(texts.length ? { edited: true, status: "done" as const } : {}), ...(patch.dismissed !== undefined ? { dismissed: patch.dismissed } : {}) };
  await q("UPDATE deliverable_versions SET note=$2::jsonb WHERE id=$1", [versionId, JSON.stringify(note)]);
  return readVersion(q, own.task.taskId, versionId);
}

/** 不同意某一条：只对评完的部分 / 未达到，一次只重评一条；带着本人的理由重评（调用方开始评审）。 */
export async function dissentCriterion(q: Query, own: OwnTask, versionId: string, index: number, reason: string): Promise<TDeliverableVersion> {
  requireEdit(own);
  const text = reason.trim();
  if (!text) throw new DeliverableError(400, "INVALID_INPUT", "写一句为什么");
  const row = await versionRow(q, own, versionId);
  if (row.review_status !== "done" || !row.review) throw new DeliverableError(409, "NOT_REVIEWED", "评审还没做完");
  const criterion = row.review.criteria.find((item) => item.index === index);
  if (!criterion) throw new DeliverableError(404, "NOT_FOUND", "没有这一条");
  if (criterion.verdict === "met") throw new DeliverableError(409, "ALREADY_MET", "这一条已经达到了");
  if (row.review.criteria.some((item) => item.dissent?.upheld === null)) throw new DeliverableError(409, "DISSENT_PENDING", "还有一条在重评");
  const review: StoredReview = { ...row.review, criteria: row.review.criteria.map((item) => item.index === index ? { ...item, dissent: { reason: text, upheld: null } } : item) };
  await q(`UPDATE deliverable_versions SET review=$2::jsonb,review_status='running',review_run_token=NULL,review_error=NULL,review_phase=$3::jsonb
    WHERE id=$1 AND review_status='done'`, [versionId, JSON.stringify(review), JSON.stringify({ step: 1, total: 1, label: `重评第 ${index} 条` })]);
  return readVersion(q, own.task.taskId, versionId);
}

/** 评审没做完时重评（调用方开始评审）。 */
export async function retryReview(q: Query, own: OwnTask, versionId: string): Promise<TDeliverableVersion> {
  requireEdit(own);
  const row = await versionRow(q, own, versionId);
  if (row.review_status !== "failed") throw new DeliverableError(409, "NOT_FAILED", "评审没有失败，不用重试");
  await q("UPDATE deliverable_versions SET review_status='queued',review_error=NULL,review_run_token=NULL WHERE id=$1 AND review_status='failed'", [versionId]);
  return readVersion(q, own.task.taskId, versionId);
}

/** 打开一份文件或图片：链接没有原件。 */
export async function deliverableItemFile(q: Query, taskId: string, itemId: string): Promise<{ name: string; mimeType: string; storageKey: string }> {
  const row = (await q(`SELECT i.name,i.mime_type,i.storage_key FROM deliverable_items i JOIN deliverable_versions v ON v.id=i.version_id
    WHERE i.id=$1 AND v.task_id=$2 AND i.storage_key IS NOT NULL`, [itemId, taskId])).rows[0] as { name: string; mime_type: string; storage_key: string } | undefined;
  if (!row) throw new DeliverableError(404, "NOT_FOUND", "没有这份文件");
  return { name: row.name, mimeType: row.mime_type, storageKey: row.storage_key };
}
