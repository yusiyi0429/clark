import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import type { ActionScope } from "./actionToken.js";
import { MAX_MATERIAL_FILES, MAX_PREFLIGHT_MATERIAL_CHARS, type ParsedMaterial } from "./materialParser.js";
import {
  appendFingerprint,
  commit,
  emptyPreflight,
  meetingColumns,
  projectMeetingCard,
  resetPreflightDraft,
  updateMeeting,
  withMeetingLock,
  type MeetingActionOutcome,
  type MeetingRow,
  type StoredMeetingMaterial,
} from "./meetingStore.js";

export async function executeEditMaterials(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled" || row.preflight.status !== "ready") {
      return { error: { status: 409, code: "MEETING_MATERIALS_NOT_LOCKED", message: "只有 ready 的 scheduled Meeting 可以返回编辑材料" } };
    }
    const updated = await updateMeeting(
      client,
      row.id,
      "preflight = $2::jsonb, draft = $3::jsonb, version = version + 1, action_fingerprints = $4::jsonb",
      [JSON.stringify(emptyPreflight()), JSON.stringify(resetPreflightDraft(row.draft)), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}
/**
 * 暂存文件落盘。TMPDIR 与材料卷在 compose 部署中分属不同文件系统（overlay vs 命名卷），
 * rename 必然 EXDEV；此时退化为独占复制（目标已存在则失败，不覆盖）+ 删除源文件。
 * 其他错误（含权限、磁盘满）原样抛出，由调用方回滚。
 */
export async function moveStagedFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    // EEXIST：目标已存在且非本次创建，不得删除；其他错误可能留下半个副本，清掉
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(destination, { force: true });
    throw error;
  }
  await rm(source, { force: true });
}

/** 解析成功的全批材料：DB 更新和原件替换在同一临界区完成；失败时不留下新元数据或新文件。 */
export async function replaceMeetingMaterials(
  pool: Pool,
  secret: string,
  meetingId: string,
  materials: ParsedMaterial[],
  storageDir: string,
): Promise<MeetingActionOutcome> {
  const client = await pool.connect();
  const staged: { source: string; destination: string }[] = [];
  try {
    await client.query("BEGIN");
    const locked = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
    }
    const row = locked.rows[0];
    if (row.status !== "scheduled") {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MEETING_MATERIALS_READ_ONLY", message: "只有 scheduled Meeting 可以替换材料" } };
    }
    if (row.preflight.status === "ready") {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MEETING_MATERIALS_LOCKED", message: "请先确认返回编辑材料" } };
    }
    const next: StoredMeetingMaterial[] = materials.map((material) => {
      const id = randomUUID();
      const storageKey = `${meetingId}/${id}`;
      staged.push({ source: material.tempPath, destination: join(storageDir, storageKey) });
      return { id, fileName: material.fileName, mimeType: material.mimeType, sizeBytes: material.sizeBytes, receivedBy: row.ceo_participant_id, providedBy: null, uploadedAt: new Date().toISOString(), storageKey, sha256: material.sha256, extractedText: material.extractedText, ...(material.pageCount ? { pageCount: material.pageCount } : {}) };
    });
    for (const item of staged) await mkdir(dirname(item.destination), { recursive: true, mode: 0o700 });
    for (const item of staged) await moveStagedFile(item.source, item.destination);
    const updated = await updateMeeting(client, row.id, "materials = $2::jsonb, preflight = $3::jsonb, draft = $4::jsonb, version = version + 1", [JSON.stringify(next), JSON.stringify(emptyPreflight()), JSON.stringify(resetPreflightDraft(row.draft))]);
    await client.query("COMMIT");
    await Promise.all(row.materials.map((material) => rm(join(storageDir, material.storageKey), { force: true })));
    return { card: projectMeetingCard(updated, secret) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await Promise.all(staged.map((item) => rm(item.destination, { force: true })));
    throw error;
  } finally {
    client.release();
  }
}

/** 补充材料增量追加：scheduled-only；不重置/不触发预审；sha256+request 幂等；staged 文件与 DB 同事务原子落盘。 */
export async function appendSupplementMaterial(
  pool: Pool,
  secret: string,
  meetingId: string,
  requestId: string,
  material: ParsedMaterial,
  storageDir: string,
): Promise<MeetingActionOutcome> {
  const client = await pool.connect();
  let staged: { destination: string } | null = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
    }
    const row = locked.rows[0];
    if (row.status !== "scheduled") {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MEETING_MATERIALS_READ_ONLY", message: "只有 scheduled Meeting 可以追加补充材料" } };
    }
    if (!row.draft.supplementRequests.some((request) => request.id === requestId)) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "SUPPLEMENT_REQUEST_NOT_FOUND", message: "补充请求不存在" } };
    }
    // sha256 + request 幂等：重复提交返回当前 Card，不重复落盘、不升版本
    if (row.materials.some((item) => item.kind === "supplement" && item.supplementFor === requestId && item.sha256 === material.sha256)) {
      await client.query("COMMIT");
      return { card: projectMeetingCard(row, secret) };
    }
    if (row.materials.length >= MAX_MATERIAL_FILES) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MATERIAL_BATCH_TOO_LARGE", message: `材料总数已达上限 ${MAX_MATERIAL_FILES} 份` } };
    }
    const textBudget = row.materials.reduce((sum, item) => sum + item.extractedText.length, 0) + material.extractedText.length;
    if (textBudget > MAX_PREFLIGHT_MATERIAL_CHARS) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MATERIAL_TEXT_TOO_LARGE", message: "材料预审文本总量超过 300,000 字符" } };
    }
    const materialId = randomUUID();
    const storageKey = `${meetingId}/${materialId}`;
    const destination = join(storageDir, storageKey);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await moveStagedFile(material.tempPath, destination);
    staged = { destination };
    const entry: StoredMeetingMaterial = {
      id: materialId,
      fileName: material.fileName,
      mimeType: material.mimeType,
      sizeBytes: material.sizeBytes,
      receivedBy: row.ceo_participant_id,
      providedBy: null,
      uploadedAt: new Date().toISOString(),
      storageKey,
      sha256: material.sha256,
      extractedText: material.extractedText,
      ...(material.pageCount ? { pageCount: material.pageCount } : {}),
      kind: "supplement",
      supplementFor: requestId,
    };
    const updated = await updateMeeting(client, row.id, "materials = $2::jsonb, version = version + 1", [JSON.stringify([...row.materials, entry])]);
    await client.query("COMMIT");
    return { card: projectMeetingCard(updated, secret) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (staged) await rm(staged.destination, { force: true });
    throw error;
  } finally {
    client.release();
  }
}
