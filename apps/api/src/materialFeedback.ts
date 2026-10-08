import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCreateMaterialAnnotationRequest, TDecideMaterialAnnotationRequest, TMaterialAnnotationRef, TMaterialAnnotationStatus,
  TMaterialAnnotationView, TMaterialEditProposalView, TRestoreMaterialRemovedRequest } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import type { ThreadRef } from "./threads.js";
import { ObjectMaterialError, editObjectMaterial, materialEditor, materialRevisionHistory, readObjectMaterial, type MaterialViewer } from "./objectMaterials.js";
import { materialHistory, restoreMaterialBlock } from "./materialHistory.js";

export type AnnotationRow = { id: string; material_id: string; object_type: ThreadRef["objectType"]; object_id: string;
  version: number; quote: string; prefix: string; suffix: string; body: string; author_id: string; client_id: string;
  status: TMaterialAnnotationStatus; applied_version: number | null; note: string | null; attempts: number;
  decided_by: string | null; created_at: Date; updated_at: Date };
export type Replacement = { find: string; replace: string };
type ProposalRow = { id: string; material_id: string; version: number; summary: string; edits: Replacement[];
  proposed_by: string; proposed_for: string; status: TMaterialEditProposalView["status"]; created_at: Date };
const person = (id: string, names: Map<string, string>) => ({ personId: id, displayName: names.get(id) ?? id });

/**
 * 选中的是渲染后的文字，源码里还有 HTML 标签与实体、Markdown 链接地址和有序列表序号：去掉这些后只比字母和数字。
 * 每一段匹配都在下一个分隔符处停下，整篇只扫一遍（材料最长 10 万字，每次读详情都算）。
 */
export const plainLetters = (text: string) => text
  .replace(/<[^<>]*>|&#?\w+;|\]\([^()\s]*\)|^[ \t]*\d+[.)][ \t]/gm, " ").replace(/[^\p{L}\p{N}]/gu, "");

export function annotationRef(row: { annotation_id: string | null; quote: string; annotation_body: string; author_id: string },
  names: Map<string, string>): TMaterialAnnotationRef {
  return row.annotation_id ? { id: row.annotation_id, quote: row.quote, body: row.annotation_body, author: person(row.author_id, names) } : null;
}
/** canEdit：看的人能改这份材料（上传者或对象负责人，且是 Markdown / HTML）。stale 由详情按最新版算。 */
export function annotationView(row: AnnotationRow, names: Map<string, string>, viewerId: string, canEdit: boolean, stale = false): TMaterialAnnotationView {
  const decidable = canEdit && row.status === "noted";
  return { id: row.id, materialId: row.material_id, version: row.version, quote: row.quote, body: row.body,
    author: person(row.author_id, names), status: row.status, appliedVersion: row.applied_version, note: row.note,
    decidedBy: row.decided_by ? person(row.decided_by, names) : null, stale,
    canDecide: decidable && row.author_id !== viewerId, canApply: decidable && row.author_id === viewerId,
    createdAt: row.created_at.toISOString() };
}
/** 默认只保存（noted）；「立即修改」只给能改的人，和采用一样进原队列。 */
export async function createMaterialAnnotation(q: Query, ref: ThreadRef, id: string, viewer: MaterialViewer,
  input: TCreateMaterialAnnotationRequest, names: Map<string, string>) {
  const material = await readObjectMaterial(q, ref, id, viewer, input.version);
  const editable = material.format === "markdown" || material.format === "html";
  const canEdit = editable && (await materialEditor(q, ref, viewer))(material.ownerId);
  const existing = (await q("SELECT * FROM material_annotations WHERE author_id=$1 AND client_id=$2",
    [viewer.personId, input.clientId])).rows[0] as AnnotationRow | undefined;
  if (existing) {
    if (existing.material_id !== id) throw new ObjectMaterialError(409, "ANNOTATION_CLIENT_ID_CONFLICT", "这个批注编号已经用于另一份材料");
    return annotationView(existing, names, viewer.personId, canEdit);
  }
  if ([input.quote, input.prefix, input.suffix, input.body].some((text) => text.includes("\u0000")))
    throw new ObjectMaterialError(400, "INVALID_MATERIAL_ANNOTATION", "批注里有无法保存的空字符");
  const edit = input.intent === "edit";
  if (edit && !canEdit) throw editable ? new ObjectMaterialError(403, "MATERIAL_FORBIDDEN", "只有上传者和负责人能立即修改")
    : new ObjectMaterialError(400, "MATERIAL_READ_ONLY", "PDF、Word 只能保存批注");
  const inserted = await q(`INSERT INTO material_annotations(id,material_id,object_type,object_id,version,quote,prefix,suffix,body,author_id,client_id,status,decided_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(author_id,client_id) DO NOTHING RETURNING *`,
    [randomUUID(), id, ref.objectType, ref.objectId, input.version, input.quote, input.prefix, input.suffix, input.body,
      viewer.personId, input.clientId, edit ? "queued" : "noted", edit ? viewer.personId : null]);
  const row = (inserted.rows[0] ?? (await q("SELECT * FROM material_annotations WHERE author_id=$1 AND client_id=$2",
    [viewer.personId, input.clientId])).rows[0]) as AnnotationRow;
  if (row.material_id !== id) throw new ObjectMaterialError(409, "ANNOTATION_CLIENT_ID_CONFLICT", "这个批注编号已经用于另一份材料");
  return annotationView(row, names, viewer.personId, canEdit);
}
/** 能改的人处理一条保存着的批注：采用进原队列、记下采用人；不采用收起，原因可不填。已经处理过 409。 */
export async function decideMaterialAnnotation(q: Query, ref: ThreadRef, id: string, annotationId: string, viewer: MaterialViewer,
  input: TDecideMaterialAnnotationRequest, names: Map<string, string>) {
  const material = await readObjectMaterial(q, ref, id, viewer);
  if (material.format !== "markdown" && material.format !== "html") throw new ObjectMaterialError(400, "MATERIAL_READ_ONLY", "PDF、Word 只能保存批注");
  if (!(await materialEditor(q, ref, viewer))(material.ownerId)) throw new ObjectMaterialError(403, "MATERIAL_FORBIDDEN", "只有上传者和负责人能处理批注");
  const adopt = input.decision === "adopt";
  const row = (await q(`UPDATE material_annotations SET status=$3,decided_by=$4,note=$5,updated_at=now()
    WHERE id=$1 AND material_id=$2 AND status='noted' RETURNING *`,
  [annotationId, id, adopt ? "queued" : "declined", viewer.personId, adopt ? null : input.reason?.trim() || null])).rows[0] as AnnotationRow | undefined;
  if (row) return annotationView(row, names, viewer.personId, true);
  const exists = await q("SELECT 1 FROM material_annotations WHERE id=$1 AND material_id=$2", [annotationId, id]);
  throw exists.rowCount ? new ObjectMaterialError(409, "MATERIAL_ANNOTATION_DECIDED", "这条批注已经有人处理过了")
    : new ObjectMaterialError(404, "MATERIAL_ANNOTATION_NOT_FOUND", "批注不存在");
}

/** Share the same material lock with direct edits and annotation workers. */
export async function withMaterialLock<T>(pool: Pool, id: string, work: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const q = client.query.bind(client) as Query;
  try {
    await q("BEGIN");
    await q("SELECT id FROM object_materials WHERE id=$1 FOR NO KEY UPDATE", [id]);
    const result = await work(q);
    await q("COMMIT");
    return result;
  } catch (cause) { await q("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export function validateMaterialReplacements(body: string, edits: Replacement[]): void {
  if (!edits.length || edits.length > 20) throw new ObjectMaterialError(400, "INVALID_MATERIAL_EDIT", "修改条数不合法");
  for (const edit of edits) {
    // Validate both the current source and sequential application, as edit_material does.
    if (!edit.find || body.indexOf(edit.find) < 0 || body.indexOf(edit.find) !== body.lastIndexOf(edit.find))
      throw new ObjectMaterialError(409, "MATERIAL_FIND_NOT_UNIQUE", "要替换的文字必须恰好出现一次，请重新读取材料");
  }
  for (const edit of edits) {
    if (body.indexOf(edit.find) < 0 || body.indexOf(edit.find) !== body.lastIndexOf(edit.find))
      throw new ObjectMaterialError(409, "MATERIAL_FIND_NOT_UNIQUE", "多处修改互相重叠，请重新读取材料");
    if (edit.find.includes("\u0000") || edit.replace.includes("\u0000"))
      throw new ObjectMaterialError(400, "INVALID_MATERIAL_EDIT", "文件里有无法保存的空字符");
    body = body.replace(edit.find, () => edit.replace);
  }
}
function proposalView(row: ProposalRow, names: Map<string, string>): TMaterialEditProposalView {
  return { id: row.id, materialId: row.material_id, version: row.version, summary: row.summary,
    changes: row.edits.slice(0, 10).map((edit) => ({ before: edit.find, after: edit.replace })),
    proposedBy: person(row.proposed_by, names), proposedFor: person(row.proposed_for, names), status: row.status,
    createdAt: row.created_at.toISOString() };
}
/** 能改这份材料的人提给自己；不能改的人提的交给上传者（对话守同一道门），对象负责人也能处理。 */
export async function proposeMaterialEdit(pool: Pool, ref: ThreadRef, id: string, viewer: MaterialViewer,
  summary: string, edits: Replacement[], names: Map<string, string>, conversationId: string | null = null) {
  return withMaterialLock(pool, id, async (q) => {
    const material = await readObjectMaterial(q, ref, id, viewer);
    if (material.format !== "markdown" && material.format !== "html") throw new ObjectMaterialError(400, "MATERIAL_READ_ONLY", "只读材料不能修改");
    if (!summary.trim() || summary.length > 200) throw new ObjectMaterialError(400, "INVALID_MATERIAL_EDIT", "修改说明不合法");
    validateMaterialReplacements(material.body, edits);
    const proposedFor = (await materialEditor(q, ref, viewer))(material.ownerId) ? viewer.personId : material.ownerId;
    const proposalId = randomUUID();
    await q(`INSERT INTO material_edit_proposals(id,material_id,object_type,object_id,version,summary,edits,proposed_by,proposed_for,conversation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [proposalId, id, ref.objectType, ref.objectId, material.version, summary.trim(), JSON.stringify(edits), viewer.personId, proposedFor, conversationId]);
    const name = names.get(proposedFor) ?? proposedFor;
    return { id: proposalId, message: proposedFor === viewer.personId ? "已在左侧材料上方提议，点『按这个改』生效"
      : `已交给${name}，${name}在材料上方点『按这个改』才生效` };
  });
}
/** 给看的人的提议；不能改的人提的建议，能改这份材料的人（canEdit）都看得到。 */
export async function listMaterialProposals(q: Query, id: string, viewerId: string, canEdit: boolean, names: Map<string, string>) {
  const rows = await q(`SELECT p.*, r.body FROM material_edit_proposals p JOIN object_materials m ON m.id=p.material_id
    JOIN material_revisions r ON r.material_id=m.id AND r.version=m.current_version
    WHERE p.material_id=$1 AND p.status='pending' ORDER BY p.created_at DESC,p.id DESC`, [id]);
  const proposals: TMaterialEditProposalView[] = [];
  for (const row of rows.rows as (ProposalRow & { body: string })[]) {
    try { validateMaterialReplacements(row.body, row.edits); }
    catch {
      // Recheck against the DB's current version to avoid marking stale from an obsolete detail snapshot.
      await q(`UPDATE material_edit_proposals p SET status='stale',decided_at=now() WHERE id=$1 AND status='pending'
        AND EXISTS (SELECT 1 FROM object_materials m JOIN material_revisions r ON r.material_id=m.id AND r.version=m.current_version
          WHERE m.id=p.material_id AND r.body=$2)`, [row.id, row.body]);
      continue;
    }
    if (row.proposed_for === viewerId || (canEdit && row.proposed_by !== row.proposed_for)) proposals.push(proposalView(row, names));
  }
  return proposals;
}
export async function decideMaterialProposal(pool: Pool, ref: ThreadRef, id: string, proposalId: string,
  viewer: MaterialViewer, decision: "apply" | "dismiss") {
  const result = await withMaterialLock(pool, id, async (q) => {
    const material = await readObjectMaterial(q, ref, id, viewer);
    const row = (await q("SELECT * FROM material_edit_proposals WHERE id=$1 AND material_id=$2 FOR UPDATE", [proposalId, id])).rows[0] as ProposalRow | undefined;
    if (!row) throw new ObjectMaterialError(404, "MATERIAL_PROPOSAL_NOT_FOUND", "修改提议不存在");
    if (!(await materialEditor(q, ref, viewer))(material.ownerId) || (row.proposed_for !== viewer.personId && row.proposed_by === row.proposed_for))
      throw new ObjectMaterialError(403, "MATERIAL_FORBIDDEN", "只能处理给本人的修改提议");
    if (row.status !== "pending") throw new ObjectMaterialError(409, "MATERIAL_PROPOSAL_STALE", "修改提议已处理或失效");
    if (decision === "apply") {
      try { validateMaterialReplacements(material.body, row.edits); }
      catch {
        await q("UPDATE material_edit_proposals SET status='stale',decided_at=now() WHERE id=$1", [proposalId]);
        return new ObjectMaterialError(409, "MATERIAL_PROPOSAL_STALE", "原文已经变化，请重新提议");
      }
      await editObjectMaterial(pool, ref, id, viewer, material.version, row.edits, row.summary, null, { query: q });
    }
    await q("UPDATE material_edit_proposals SET status=$2,decided_at=now() WHERE id=$1", [proposalId, decision === "apply" ? "applied" : "dismissed"]);
  });
  if (result instanceof ObjectMaterialError) throw result;
}
export async function restoreMaterialRemoved(pool: Pool, ref: ThreadRef, id: string, viewer: MaterialViewer,
  input: TRestoreMaterialRemovedRequest, names: Map<string, string>) {
  await withMaterialLock(pool, id, async (q) => {
    const material = await readObjectMaterial(q, ref, id, viewer);
    if (material.format !== "markdown" && material.format !== "html") throw new ObjectMaterialError(400, "MATERIAL_READ_ONLY", "只读材料不能恢复");
    if (material.version !== input.version) throw new ObjectMaterialError(409, "VERSION_CONFLICT", "版本已变化，请重新读取材料");
    const history = materialHistory(await materialRevisionHistory(q, id, names), material.format);
    const removed = history.removed.find((item) => item.id === input.removedId);
    if (!removed) throw new ObjectMaterialError(404, "MATERIAL_REMOVED_NOT_FOUND", "这段内容已经恢复或不存在");
    const body = restoreMaterialBlock(material.body, removed, material.format);
    await editObjectMaterial(pool, ref, id, viewer, material.version,
      material.body ? [{ find: material.body, replace: body }] : [{ append: body }], "从垃圾篓恢复", null, { query: q });
  });
}
