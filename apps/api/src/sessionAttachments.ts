import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ATTACHMENT_MAX_BYTES, attachmentKind, type TSessionAttachment } from "@warmap/contracts";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { CardError } from "./taskCards.js";
import { CARD_PROJECT } from "./projects.js";

/**
 * 子会话（卡、专题）的附件（新首页 14.5，契约 attachments.ts）：存在云端，网页给本机程序说那一句时带上 id，本机按 id 取回存进 Task 的工作区。
 * 文件在材料卷的 session-attachments/<owner>/<id>（和本机交上来的产出同一个卷）；谁能读：本人和本人配对的电脑。
 */
type Row = { id: string; owner_id: string; card_id: string | null; topic_id: string | null; file_name: string; mime_type: string; size: number; sha256: string;
  kind: TSessionAttachment["kind"]; storage_key: string; created_at: Date };

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", csv: "text/csv", txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", html: "text/html", htm: "text/html", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml" };
/** 类型按扩展名定（不信上传带的）；代码和日志都是纯文本。 */
export const attachmentMimeType = (fileName: string, kind: TSessionAttachment["kind"]) =>
  MIME[fileName.toLowerCase().split(".").pop() ?? ""] ?? (kind === "code" ? "text/plain" : "application/octet-stream");

const view = (row: Row): TSessionAttachment => ({ id: row.id, subject: row.card_id ? { kind: "card", id: row.card_id } : { kind: "topic", id: row.topic_id! },
  fileName: row.file_name, mimeType: row.mime_type, size: row.size, sha256: row.sha256, kind: row.kind, createdAt: row.created_at.toISOString() });

/** 存一批：子会话是本人的（卡是本人的执行事项、专题是本人的），每个认得出类型、不超过 30 MB；有一个不行整批不存。 */
export async function storeSessionAttachments(q: Query, storageDir: string, ownerId: string, subject: TSessionAttachment["subject"],
  files: { filename: string; buffer: Buffer }[], now: Date): Promise<TSessionAttachment[]> {
  const own = UUID_PATTERN.test(subject.id) && (await q(subject.kind === "card" ? "SELECT 1 FROM tasks WHERE id=$1 AND owner_id=$2"
    : "SELECT 1 FROM research_topics WHERE id=$1 AND owner_id=$2", [subject.id, ownerId])).rowCount;
  if (!own) throw new CardError(404, "NOT_FOUND", "找不到这个子会话");
  const prepared = files.map((file) => {
    const fileName = file.filename.split(/[\\/]/).pop()!.trim().slice(0, 255);
    const kind = fileName ? attachmentKind(fileName) : null;
    if (!kind) throw new CardError(400, "UNSUPPORTED_ATTACHMENT", `${fileName || "文件"}：格式不支持`);
    if (!file.buffer.length) throw new CardError(400, "EMPTY_ATTACHMENT", `${fileName}：是空文件`);
    if (file.buffer.length > ATTACHMENT_MAX_BYTES) throw new CardError(413, "ATTACHMENT_TOO_LARGE", `${fileName}：超过 30 MB`);
    const id = randomUUID();
    return { id, fileName, kind, buffer: file.buffer, storageKey: `session-attachments/${encodeURIComponent(ownerId)}/${id}`,
      sha256: createHash("sha256").update(file.buffer).digest("hex") };
  });
  const written: string[] = [];
  try {
    for (const item of prepared) {
      const path = join(storageDir, item.storageKey);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, item.buffer);
      written.push(path);
    }
    const rows: Row[] = [];
    for (const item of prepared) rows.push((await q(`INSERT INTO session_attachments(id,owner_id,card_id,topic_id,file_name,mime_type,size,sha256,kind,storage_key,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [item.id, ownerId, subject.kind === "card" ? subject.id : null, subject.kind === "topic" ? subject.id : null,
      item.fileName, attachmentMimeType(item.fileName, item.kind), item.buffer.length, item.sha256, item.kind, item.storageKey, now])).rows[0] as Row);
    return rows.map(view);
  } catch (cause) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw cause;
  }
}

// 选分享来源和打开原件必须使用相同的子会话读取权限。
const visibleAttachment = `(a.owner_id=$1 OR EXISTS (SELECT 1 FROM projects p WHERE p.id=COALESCE(
  (SELECT ${CARD_PROJECT("t")} FROM tasks t WHERE t.id=a.card_id),(SELECT ${CARD_PROJECT("r")} FROM research_topics r WHERE r.id=a.topic_id))
  AND (p.owner_id=$1 OR EXISTS (SELECT 1 FROM project_transfers x WHERE x.project_id=p.id AND x.status='accepted' AND (x.from_id=$1 OR x.to_id=$1)))))`;

export async function listShareableSessionAttachments(q: Query, personId: string) {
  const rows = (await q(`SELECT a.id,a.file_name,a.size,a.sha256,a.created_at FROM session_attachments a
    WHERE ${visibleAttachment} ORDER BY a.created_at DESC, a.id`, [personId])).rows as Pick<Row, "id" | "file_name" | "size" | "sha256" | "created_at">[];
  return rows.map((row) => ({ id: row.id, fileName: row.file_name, size: row.size, sha256: row.sha256, createdAt: row.created_at.toISOString() }));
}

/**
 * 读一份：本人的（本人的网页、本人配对的电脑），或附件所在的子会话在一个项目里、本人是这个项目现在或以前的负责人（16.7：附件跟着项目走）。
 * 没有、看不了、文件不在了为 null。
 */
export async function readSessionAttachment(q: Query, storageDir: string, ownerId: string, id: string): Promise<{ attachment: TSessionAttachment; data: Buffer } | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const row = (await q(`SELECT a.* FROM session_attachments a WHERE a.id=$2 AND ${visibleAttachment}`, [ownerId, id])).rows[0] as Row | undefined;
  const data = row ? await readFile(join(storageDir, row.storage_key)).catch(() => null) : null;
  return row && data ? { attachment: view(row), data } : null;
}
