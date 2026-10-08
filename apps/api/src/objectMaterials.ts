import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import type { TMaterialDetailResponse, TMaterialObjectType, TMaterialView } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import type { ObjectParsedMaterial } from "./materialParser.js";
import { MAX_MATERIAL_HTML_CHARS, MAX_MATERIAL_TEXT_CHARS } from "./materialParser.js";
import { moveStagedFile } from "./meetingMaterials.js";
import { diffHtmlMaterialLines, diffMaterialBlocks, splitMaterialBlocks } from "./materialDiff.js";
import { isActiveMember, postCoAgentMessage, type ThreadRef } from "./threads.js";
import { annotationRef, annotationView, listMaterialProposals, plainLetters, type AnnotationRow } from "./materialFeedback.js";
import { materialHistory, type MaterialHistoryRevision } from "./materialHistory.js";

export class ObjectMaterialError extends Error {
  constructor(public status: number, public code: string, message: string, public version?: number) { super(message); }
}

export type MaterialViewer = { personId: string; role: "ceo" | "member"; displayName: string };
type MaterialRow = { id: string; object_type: TMaterialObjectType; object_id: string; file_name: string;
  format: "markdown" | "pdf" | "docx" | "html"; size_bytes: number; page_count: number | null; storage_key: string | null;
  origin: "upload" | "agent"; owner_id: string; current_version: number; created_at: Date; updated_at: Date;
  revision_version: number | null; revision_by: string | null; revision_summary: string | null; revision_at: Date | null;
  annotation_id: string | null; quote: string; annotation_body: string; author_id: string };
type RevisionRow = { version: number; body: string; requested_by: string | null; summary: string | null; created_at: Date;
  annotation_id: string | null; quote: string; annotation_body: string; author_id: string };
const COLUMNS = `m.*, r.version AS revision_version, r.requested_by AS revision_by,
  r.summary AS revision_summary, r.created_at AS revision_at, r.annotation_id, a.quote, a.body AS annotation_body, a.author_id`;
const JOIN = `LEFT JOIN material_revisions r ON r.material_id=m.id AND r.version=m.current_version
  LEFT JOIN material_annotations a ON a.id=r.annotation_id`;

export async function canAccessObjectMaterials(q: Query, ref: ThreadRef, viewer: MaterialViewer): Promise<boolean> {
  if (await isActiveMember(q, ref, viewer.personId)) return true;
  if (viewer.role !== "ceo") return false;
  if (ref.objectType === "meeting") {
    const meeting = await q("SELECT 1 FROM meetings WHERE id::text=$1", [ref.objectId]);
    return Boolean(meeting.rowCount);
  }
  if (ref.objectType !== "issue") return false;
  const issue = await q("SELECT 1 FROM issues WHERE id::text=$1", [ref.objectId]);
  if (!issue.rowCount) return false;
  const group = await q("SELECT 1 FROM thread_members WHERE object_type='issue' AND object_id=$1 LIMIT 1", [ref.objectId]);
  return !group.rowCount;
}

export async function requireMaterialAccess(q: Query, ref: ThreadRef, viewer: MaterialViewer): Promise<void> {
  if (!await canAccessObjectMaterials(q, ref, viewer)) throw new ObjectMaterialError(404, "MATERIAL_NOT_FOUND", "材料不存在");
}

/**
 * 能改材料的人（决定记录 2026-10-06 第 6 条）= 上传者 + 对象负责人：执行事项是推进人，会议是主持人，议题是 CEO。
 * 返回「这个人能不能改某位上传的材料」。立即修改、采用 / 不采用、修改提议、恢复和对话里直接改都只按它判断。
 */
export async function materialEditor(q: Query, ref: ThreadRef, viewer: MaterialViewer): Promise<(uploaderId: string) => boolean> {
  const ownsObject = ref.objectType === "issue" ? viewer.role === "ceo"
    : (await q(ref.objectType === "task" ? "SELECT owner_id AS owner FROM tasks WHERE id::text=$1"
      : "SELECT lead_dri_id AS owner FROM meetings WHERE id::text=$1", [ref.objectId])).rows[0]?.owner === viewer.personId;
  return (uploaderId) => ownsObject || uploaderId === viewer.personId;
}
type ViewerAccess = { editor: (uploaderId: string) => boolean; pending: Map<string, number> };
/** 每份材料等本人采用 / 不采用的批注条数（别人保存的；只对能改的人有意义）。 */
async function viewerAccess(q: Query, ref: ThreadRef, viewer: MaterialViewer): Promise<ViewerAccess> {
  const rows = await q(`SELECT material_id, count(*)::int AS n FROM material_annotations
    WHERE object_type=$1 AND object_id=$2 AND status='noted' AND author_id<>$3 GROUP BY material_id`, [ref.objectType, ref.objectId, viewer.personId]);
  return { editor: await materialEditor(q, ref, viewer), pending: new Map(rows.rows.map((row) => [row.material_id as string, row.n as number])) };
}

function person(id: string, names: Map<string, string>) { return { personId: id, displayName: names.get(id) ?? id }; }
function revision(row: RevisionRow, names: Map<string, string>) {
  return { version: row.version, requestedBy: row.requested_by ? person(row.requested_by, names) : null,
    summary: row.summary, at: row.created_at.toISOString(), annotation: annotationRef(row, names) };
}
function view(row: MaterialRow, viewer: MaterialViewer, names: Map<string, string>, access: ViewerAccess): TMaterialView {
  const editable = row.format === "markdown" || row.format === "html";
  const canEdit = editable && access.editor(row.owner_id);
  return { id: row.id, objectType: row.object_type, objectId: row.object_id, fileName: row.file_name,
    format: row.format, sizeBytes: row.size_bytes, ...(row.page_count ? { pageCount: row.page_count } : {}),
    origin: row.origin, owner: person(row.owner_id, names), createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), version: row.current_version,
    editable, canEdit, pending: canEdit ? access.pending.get(row.id) ?? 0 : 0, canDelete: row.owner_id === viewer.personId,
    lastRevision: (row.current_version > 1 || row.origin === "agent") && row.revision_at ? {
      version: row.revision_version!, requestedBy: person(row.revision_by!, names),
      summary: row.revision_summary!, at: row.revision_at.toISOString(), annotation: annotationRef(row, names),
    } : null };
}
async function rowFor(q: Query, ref: ThreadRef, id: string): Promise<MaterialRow> {
  const result = await q(`SELECT ${COLUMNS} FROM object_materials m ${JOIN}
    WHERE m.id=$1 AND m.object_type=$2 AND m.object_id=$3 AND m.deleted_at IS NULL`, [id, ref.objectType, ref.objectId]);
  if (!result.rows[0]) throw new ObjectMaterialError(404, "MATERIAL_NOT_FOUND", "材料不存在");
  return result.rows[0] as MaterialRow;
}
export async function listObjectMaterials(q: Query, ref: ThreadRef, viewer: MaterialViewer, names: Map<string, string>) {
  await requireMaterialAccess(q, ref, viewer);
  const rows = await q(`SELECT ${COLUMNS} FROM object_materials m ${JOIN}
    WHERE m.object_type=$1 AND m.object_id=$2 AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`, [ref.objectType, ref.objectId]);
  const access = await viewerAccess(q, ref, viewer);
  return { materials: (rows.rows as MaterialRow[]).map((row) => view(row, viewer, names, access)), canUpload: rows.rows.length < 30 };
}
export async function getObjectMaterial(q: Query, ref: ThreadRef, id: string, viewer: MaterialViewer, names: Map<string, string>) {
  await requireMaterialAccess(q, ref, viewer);
  return view(await rowFor(q, ref, id), viewer, names, await viewerAccess(q, ref, viewer));
}
export async function readObjectMaterial(q: Query, ref: ThreadRef, id: string, viewer: MaterialViewer, version?: number) {
  await requireMaterialAccess(q, ref, viewer);
  const row = await rowFor(q, ref, id);
  const selectedVersion = version ?? row.current_version;
  const result = await q("SELECT body FROM material_revisions WHERE material_id=$1 AND version=$2", [id, selectedVersion]);
  if (!result.rows[0]) throw new ObjectMaterialError(404, "MATERIAL_REVISION_NOT_FOUND", "材料版本不存在");
  return { body: result.rows[0].body as string, version: selectedVersion, currentVersion: row.current_version,
    fileName: row.file_name, format: row.format, storageKey: row.storage_key, ownerId: row.owner_id };
}
export async function materialRevisionHistory(q: Query, id: string, names: Map<string, string>): Promise<MaterialHistoryRevision[]> {
  const result = await q(`SELECT r.*, a.quote, a.body AS annotation_body, a.author_id FROM material_revisions r
    LEFT JOIN material_annotations a ON a.id=r.annotation_id WHERE r.material_id=$1 ORDER BY r.version`, [id]);
  return (result.rows as RevisionRow[]).map((row) => ({ ...revision(row, names), body: row.body }));
}
export async function getObjectMaterialDetail(q: Query, ref: ThreadRef, id: string, viewer: MaterialViewer,
  names: Map<string, string>, version?: number): Promise<TMaterialDetailResponse> {
  await requireMaterialAccess(q, ref, viewer);
  const row = await rowFor(q, ref, id);
  const revisions = (await materialRevisionHistory(q, id, names)).filter((item) => item.version <= row.current_version);
  const selected = revisions.find((item) => item.version === (version ?? row.current_version));
  if (!selected) throw new ObjectMaterialError(404, "MATERIAL_REVISION_NOT_FOUND", "材料版本不存在");
  const currentBody = selected.body;
  const previousBody = revisions.find((item) => item.version === selected.version - 1)?.body;
  const latest = selected.version === row.current_version;
  const history = latest && (row.format === "markdown" || row.format === "html") ? materialHistory(revisions, row.format) : null;
  const blocks = row.format === "html" ? (previousBody === undefined ? []
      : diffHtmlMaterialLines(previousBody, currentBody).filter((block) => block.change !== null))
      : row.format !== "markdown" ? null : previousBody !== undefined
        ? diffMaterialBlocks(previousBody, currentBody)
        : splitMaterialBlocks(currentBody).map((text) => ({ text, change: null }));
  const annotations = await q("SELECT * FROM material_annotations WHERE material_id=$1 ORDER BY created_at DESC,id DESC", [id]);
  const views = revisions.map(({ body: _body, ...item }) => item).reverse();
  const material = view(row, viewer, names, await viewerAccess(q, ref, viewer));
  // 原文已改：和最新版比，不和正在看的旧版比。
  const source = plainLetters(revisions.at(-1)!.body);
  let blockIndex = 0;
  return { material, version: selected.version, latest,
    revision: views.find((item) => item.version === selected.version)!, revisions: views,
    blocks: blocks?.map((block) => ({ ...block, history: block.change?.kind === "removed" ? [] : history?.histories[blockIndex++] ?? [] })) ?? null,
    annotations: (annotations.rows as AnnotationRow[]).map((item) => annotationView(item, names, viewer.personId, material.canEdit,
      item.status === "noted" && item.version < row.current_version && !source.includes(plainLetters(item.quote)))),
    removed: history?.removed.map(({ previous: _previous, index: _index, ...item }) => ({ ...item, restorable: material.canEdit })) ?? [],
    proposals: latest ? await listMaterialProposals(q, id, viewer.personId, material.canEdit, names) : [] };
}

export async function uploadObjectMaterial(pool: Pool, ref: ThreadRef, viewer: MaterialViewer,
  parsed: ObjectParsedMaterial, storageDir: string, names: Map<string, string>): Promise<TMaterialView> {
  const client = await pool.connect();
  const q = client.query.bind(client) as Query;
  const id = randomUUID();
  const storageKey = `objects/${ref.objectType}/${ref.objectId}/${id}`;
  const destination = join(storageDir, storageKey);
  let moved = false;
  try {
    await client.query("BEGIN");
    await requireMaterialAccess(q, ref, viewer);
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`material:${ref.objectType}:${ref.objectId}`]);
    const count = await q("SELECT count(*)::int AS n FROM object_materials WHERE object_type=$1 AND object_id=$2 AND deleted_at IS NULL", [ref.objectType, ref.objectId]);
    if (count.rows[0].n >= 30) throw new ObjectMaterialError(409, "MATERIAL_LIMIT", "这件事最多保存 30 份材料");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await moveStagedFile(parsed.tempPath, destination);
    moved = true;
    const format = parsed.mimeType === "text/markdown" ? "markdown" : parsed.mimeType === "text/html" ? "html"
      : parsed.mimeType === "application/pdf" ? "pdf" : "docx";
    const now = new Date();
    await q(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,page_count,storage_key,sha256,origin,owner_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'upload',$10,$11,$11)`,
      [id, ref.objectType, ref.objectId, parsed.fileName, format, parsed.sizeBytes, parsed.pageCount ?? null, storageKey, parsed.sha256, viewer.personId, now]);
    await q("INSERT INTO material_revisions(material_id,version,body,created_at) VALUES($1,1,$2,$3)", [id, parsed.source ?? parsed.extractedText, now]);
    const row = await rowFor(q, ref, id);
    if (ref.objectType === "meeting") await postCoAgentMessage(q, ref, `${viewer.displayName}上传了《${parsed.fileName}》`, [viewer.personId]);
    const material = view(row, viewer, names, await viewerAccess(q, ref, viewer));
    await client.query("COMMIT");
    return material;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (moved) await rm(destination, { force: true });
    throw error;
  } finally { client.release(); }
}
export async function deleteObjectMaterial(q: Query, ref: ThreadRef, id: string, viewer: MaterialViewer): Promise<void> {
  await requireMaterialAccess(q, ref, viewer);
  const row = await rowFor(q, ref, id);
  if (row.owner_id !== viewer.personId) throw new ObjectMaterialError(403, "MATERIAL_FORBIDDEN", "只能删除自己上传的材料");
  await q("UPDATE object_materials SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL", [id]);
}

export type MaterialEdit = { find: string; replace: string } | { append: string };
export async function editObjectMaterial(pool: Pool, ref: ThreadRef, id: string, viewer: MaterialViewer,
  baseVersion: number, edits: MaterialEdit[], summary: string, runId: string | null,
  transaction?: { query: Query; annotationId?: string }): Promise<{ version: number; changed: number }> {
  const client = transaction ? null : await pool.connect();
  const q = transaction?.query ?? client!.query.bind(client!) as Query;
  try {
    if (client) await client.query("BEGIN");
    await requireMaterialAccess(q, ref, viewer);
    const row = await rowFor(q, ref, id);
    await q("SELECT id FROM object_materials WHERE id=$1 FOR UPDATE", [id]);
    const current = await rowFor(q, ref, id);
    const fail = (code: string, message: string) => { throw new ObjectMaterialError(409, code, message, current.current_version); };
    if (!(await materialEditor(q, ref, viewer))(current.owner_id))
      throw new ObjectMaterialError(403, "MATERIAL_FORBIDDEN", "只有上传者和负责人能改这份材料");
    if (baseVersion !== current.current_version) fail("MATERIAL_VERSION_CONFLICT", "版本已变化，请重新读取材料");
    if (current.format !== "markdown" && current.format !== "html") fail("MATERIAL_READ_ONLY", "只有 Markdown 和 HTML 材料能修改");
    if (!summary.trim() || summary.length > 200 || edits.length < 1 || edits.length > 20) fail("INVALID_MATERIAL_EDIT", "修改说明或修改条数不合法");
    const result = await q("SELECT body FROM material_revisions WHERE material_id=$1 AND version=$2", [id, current.current_version]);
    let body = result.rows[0].body as string;
    for (const edit of edits) {
      if ("append" in edit ? edit.append.includes("\u0000") : edit.find.includes("\u0000") || edit.replace.includes("\u0000"))
        fail("INVALID_MATERIAL_EDIT", "文件里有无法保存的空字符");
      // 追加的内容另起一段，不粘在原文最后一行上。
      if ("append" in edit) {
        if (current.format === "html") {
          const closing = /<\/body\s*>/ig;
          let match: RegExpExecArray | null, position = -1;
          while ((match = closing.exec(body))) position = match.index;
          body = position < 0 ? `${body}\n${edit.append}` : `${body.slice(0, position)}${edit.append}\n${body.slice(position)}`;
        } else body = `${body.replace(/\s+$/u, "")}\n\n${edit.append.replace(/^\s+/u, "")}`;
      }
      else {
        if (!edit.find || body.indexOf(edit.find) < 0 || body.indexOf(edit.find) !== body.lastIndexOf(edit.find))
          fail("MATERIAL_FIND_NOT_UNIQUE", "要替换的文字必须恰好出现一次，请重新读取材料");
        body = body.replace(edit.find, () => edit.replace);
      }
      if (current.format === "html" && body.length > MAX_MATERIAL_HTML_CHARS) fail("MATERIAL_HTML_TOO_LARGE", "HTML 太大");
      if (current.format === "markdown" && body.length > MAX_MATERIAL_TEXT_CHARS) fail("MATERIAL_TEXT_TOO_LARGE", "修改后超过 100,000 字");
    }
    const version = current.current_version + 1;
    const now = new Date();
    await q("INSERT INTO material_revisions(material_id,version,body,requested_by,summary,agent_run_id,created_at,annotation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, version, body, viewer.personId, summary.trim(), runId, now, transaction?.annotationId ?? null]);
    await q("UPDATE object_materials SET current_version=$2,updated_at=$3 WHERE id=$1", [id, version, now]);
    await postCoAgentMessage(q, ref, `按${viewer.displayName}的要求改了《${row.file_name}》：${summary.trim()}`, [viewer.personId]);
    if (client) await client.query("COMMIT");
    return { version, changed: edits.length };
  } catch (error) { if (client) await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client?.release(); }
}
export async function createObjectMaterial(pool: Pool, ref: ThreadRef, viewer: MaterialViewer,
  title: string, body: string, summary: string, runId: string | null): Promise<{ id: string; version: number }> {
  const client = await pool.connect();
  const q = client.query.bind(client) as Query;
  try {
    await client.query("BEGIN");
    await requireMaterialAccess(q, ref, viewer);
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`material:${ref.objectType}:${ref.objectId}`]);
    const count = await q("SELECT count(*)::int AS n FROM object_materials WHERE object_type=$1 AND object_id=$2 AND deleted_at IS NULL", [ref.objectType, ref.objectId]);
    if (count.rows[0].n >= 30) throw new ObjectMaterialError(409, "MATERIAL_LIMIT", "这件事最多保存 30 份材料");
    const fileName = `${title.trim().replace(/\.md$/i, "")}.md`;
    if (fileName.length < 4 || fileName.length > 240 || /[\\/\u0000-\u001f]/.test(fileName) || !body.trim()
      || body.length > MAX_MATERIAL_TEXT_CHARS || !summary.trim() || summary.length > 200)
      throw new ObjectMaterialError(400, "INVALID_MATERIAL", "材料标题、正文或说明不合法");
    const id = randomUUID(), now = new Date();
    await q(`INSERT INTO object_materials(id,object_type,object_id,file_name,format,size_bytes,origin,owner_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'markdown',$5,'agent',$6,$7,$7)`, [id, ref.objectType, ref.objectId, fileName, Buffer.byteLength(body), viewer.personId, now]);
    await q("INSERT INTO material_revisions(material_id,version,body,requested_by,summary,agent_run_id,created_at) VALUES($1,1,$2,$3,$4,$5,$6)",
      [id, body, viewer.personId, summary.trim(), runId, now]);
    await postCoAgentMessage(q, ref, `按${viewer.displayName}的要求新写了《${fileName}》：${summary.trim()}`, [viewer.personId]);
    await client.query("COMMIT");
    return { id, version: 1 };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
