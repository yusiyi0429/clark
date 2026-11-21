import { randomUUID } from "node:crypto";
import type { TColleagueMaterials, TColleagueRead, TSecretFinding } from "@warmap/contracts";
import { cleanupMaterialTemp, MaterialParseError, parseMaterialBatch } from "./materialParser.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { secretLines } from "./secretPatterns.js";

/**
 * 对外资料（契约 colleagueMaterials.ts）：每人一份说明、最多 20 份文件（只存抽出的文字，不留原件），都是本人自己放、自己删。
 * 存之前照项目转交那套样式查疑似凭据，命中就不存，逐条说在哪、第几行。
 */

export const MATERIAL_FILES_MAX = 20;

export class MaterialError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 422, readonly code: string, message: string, readonly findings?: TSecretFinding[]) { super(message); }
}

/** where 是「说明」或文件名；有命中就抛 422。 */
function rejectSecrets(where: string, text: string): void {
  const findings = secretLines(text).map((finding) => ({ where, ...finding }));
  if (findings.length) throw new MaterialError(422, "SECRET_IN_MATERIAL", "里面有像密钥的值，去掉再放", findings);
}

export async function readMaterials(q: Query, ownerId: string): Promise<TColleagueMaterials> {
  const note = (await q("SELECT body,updated_at FROM colleague_notes WHERE owner_id=$1", [ownerId])).rows[0] as { body: string; updated_at: Date } | undefined;
  const files = (await q(`SELECT id,file_name,size,char_length(extracted_text) AS chars,created_at FROM colleague_files WHERE owner_id=$1 ORDER BY created_at,id`,
    [ownerId])).rows as { id: string; file_name: string; size: number; chars: number; created_at: Date }[];
  return { note: note?.body ?? "", noteUpdatedAt: note?.updated_at.toISOString() ?? null,
    files: files.map((file) => ({ id: file.id, fileName: file.file_name, size: file.size, chars: file.chars, createdAt: file.created_at.toISOString() })) };
}

/**
 * 同事的伙伴读了本人哪份全文（colleague_reads，读全文成功时记），最近 100 条。
 * titles 是本人现在的范围目录（itemId → 标题），不在里面的（收起的、删掉的）不列；names 是读的人的名字，找不到写 id。
 */
export async function listReads(q: Query, ownerId: string, names: ReadonlyMap<string, string>, titles: ReadonlyMap<string, string>): Promise<TColleagueRead[]> {
  const rows = (await q(`SELECT reader_id,item_id,read_on::text AS read_on FROM colleague_reads WHERE owner_id=$1 ORDER BY read_at DESC LIMIT 100`,
    [ownerId])).rows as { reader_id: string; item_id: string; read_on: string }[];
  return rows.filter((row) => titles.has(row.item_id))
    .map((row) => ({ itemId: row.item_id, title: titles.get(row.item_id)!, reader: names.get(row.reader_id) ?? row.reader_id, readOn: row.read_on }));
}

/** 存说明；去掉首尾空白后为空就删掉那一行。 */
export async function saveNote(q: Query, ownerId: string, note: string, now: Date): Promise<TColleagueMaterials> {
  if (!note.trim()) await q("DELETE FROM colleague_notes WHERE owner_id=$1", [ownerId]);
  else {
    rejectSecrets("说明", note);
    await q(`INSERT INTO colleague_notes(owner_id,body,updated_at) VALUES($1,$2,$3) ON CONFLICT (owner_id) DO UPDATE SET body=EXCLUDED.body,updated_at=EXCLUDED.updated_at`,
      [ownerId, note, now]);
  }
  return readMaterials(q, ownerId);
}

/** 传一份文件：只认 .md、.pdf、.docx，抽出文字查过凭据再存；原件不留。 */
export async function addFile(q: Query, ownerId: string, upload: { filename: string; mimetype: string; buffer: Buffer }, now: Date): Promise<TColleagueMaterials> {
  const count = Number((await q("SELECT count(*) AS n FROM colleague_files WHERE owner_id=$1", [ownerId])).rows[0].n);
  if (count >= MATERIAL_FILES_MAX) throw new MaterialError(409, "TOO_MANY_FILES", `最多放 ${MATERIAL_FILES_MAX} 份文件，先删掉一份`);
  let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
  try {
    parsed = await parseMaterialBatch([upload]);
    const material = parsed.materials[0];
    rejectSecrets(material.fileName, material.extractedText);
    await q(`INSERT INTO colleague_files(id,owner_id,file_name,size,sha256,extracted_text,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), ownerId, material.fileName, material.sizeBytes, material.sha256, material.extractedText, now]);
  } catch (cause) {
    if (cause instanceof MaterialParseError) {
      const status = cause.code === "UNSUPPORTED_MATERIAL_TYPE" ? 400 : cause.code === "MATERIAL_FILE_TOO_LARGE" ? 413 : 422;
      throw new MaterialError(status, cause.code, cause.message);
    }
    throw cause;
  } finally { if (parsed) await cleanupMaterialTemp(parsed.directory); }
  return readMaterials(q, ownerId);
}

/** 删本人的一份文件；不是本人的、没有的、id 不像样的都 404。 */
export async function removeFile(q: Query, ownerId: string, id: string): Promise<void> {
  const removed = UUID_PATTERN.test(id) ? (await q("DELETE FROM colleague_files WHERE id=$1 AND owner_id=$2", [id, ownerId])).rowCount : 0;
  if (!removed) throw new MaterialError(404, "NOT_FOUND", "找不到这份文件");
}
