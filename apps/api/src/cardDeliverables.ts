import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Pool } from "pg";
import type { TDeliverableVersion, TPendingDeliverableItem } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { CardError, pendingItems } from "./taskCards.js";
import { createDeliverableVersion, DeliverableError, MAX_DELIVERABLE_FILES, type DeliverableFile, type OwnTask } from "./taskDeliverables.js";

/**
 * 准备中的交付物和「出下一版」（V2 设计第 7.4 节）：Agent 验收通过的卡自动进准备中，专题的一版本人点了才进；
 * 出下一版时把准备中的各样连同上一版的全部材料交给现有的 createDeliverableVersion 建新一版，不改它，评审照常自动开始。
 */

const MAX_LINKS = 5;

/** 把挂在这个 Task 上的专题的一版放进下一版（Task 负责人，专题也要是本人的）。 */
export async function addPendingTopicVersion(q: Query, own: OwnTask, topicVersionId: string): Promise<TPendingDeliverableItem> {
  const version = UUID_PATTERN.test(topicVersionId) ? (await q(`SELECT v.id,t.plan_task_id FROM topic_versions v JOIN research_topics t ON t.id=v.topic_id
    WHERE v.id=$1 AND t.owner_id=$2`, [topicVersionId, own.viewerId])).rows[0] as { id: string; plan_task_id: string | null } | undefined : undefined;
  if (!version) throw new CardError(404, "NOT_FOUND", "找不到专题的这一版");
  if (version.plan_task_id !== own.task.taskId) throw new CardError(400, "TOPIC_NOT_ON_TASK", "这个专题没挂在这个 Task 上");
  const id = randomUUID();
  const inserted = await q(`INSERT INTO deliverable_pending_items(id,plan_task_id,topic_version_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT (topic_version_id) DO NOTHING`,
    [id, own.task.taskId, topicVersionId, own.viewerId]);
  if (!inserted.rowCount) throw new CardError(409, "ALREADY_PENDING", "这一版已经放进去过了");
  return (await pendingItems(q, own.task.taskId)).find((item) => item.id === id)!;
}

/** 从准备中拿出来（还没进某一版的）。 */
export async function removePending(q: Query, own: OwnTask, id: string): Promise<void> {
  const removed = UUID_PATTERN.test(id) ? await q("DELETE FROM deliverable_pending_items WHERE id=$1 AND plan_task_id=$2 AND version_id IS NULL", [id, own.task.taskId]) : null;
  if (!removed?.rowCount) throw new CardError(404, "NOT_FOUND", "准备中没有这一样");
}

type PendingRow = { id: string; handback_id: string | null; card_title: string | null; output_ids: string[] | null; topic_title: string | null; label: string | null;
  body: string | null };
type OutputRow = { id: string; kind: "artifact" | "evidence"; title: string; file_name: string | null; storage_key: string | null; url: string | null };

/** 交付物认的扩展名之外，本机的纯文本产出当 Markdown 交。 */
const deliverableName = (name: string) => [".txt", ".markdown"].includes(extname(name).toLowerCase()) ? `${name}.md` : name;
const safeName = (name: string) => name.replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_").slice(0, 120);

/**
 * 出下一版（Task 负责人）：准备中的卡的产出读成文件、证据里的链接当链接、专题的一版存成 .md，连同上一版的全部材料建成新一版；
 * 建完回写 version_id。statement 不填就用这几样的标题拼一句。超过一版的上限（10 份新文件、5 个链接）时报错，什么都不写。
 * 同一个 Task 同时只出一版（会话级咨询锁）。返回新版本，评审由调用方排队。
 */
export async function createVersionFromPending(pool: Pool, own: OwnTask, statement: string | undefined, storageDir: string): Promise<TDeliverableVersion> {
  const lock = await pool.connect();
  const key = `deliverable-pending:${own.task.taskId}`;
  await lock.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
  try {
    const q: Query = pool.query.bind(pool);
    const pending = (await q(`SELECT p.id,p.handback_id,t.title AS card_title,h.output_ids,rt.title AS topic_title,tv.label,tv.body
      FROM deliverable_pending_items p LEFT JOIN card_handbacks h ON h.id=p.handback_id LEFT JOIN tasks t ON t.id=h.task_id
      LEFT JOIN topic_versions tv ON tv.id=p.topic_version_id LEFT JOIN research_topics rt ON rt.id=tv.topic_id
      WHERE p.plan_task_id=$1 AND p.version_id IS NULL ORDER BY p.added_at,p.id`, [own.task.taskId])).rows as PendingRow[];
    if (!pending.length) throw new CardError(409, "NOTHING_PENDING", "准备中还没有东西");
    const latest = (await q("SELECT id FROM deliverable_versions WHERE task_id=$1 ORDER BY number DESC LIMIT 1", [own.task.taskId])).rows[0] as { id: string } | undefined;
    const kept = latest ? (await q("SELECT id,url FROM deliverable_items WHERE version_id=$1 ORDER BY position", [latest.id])).rows as { id: string; url: string | null }[] : [];
    const outputIds = pending.flatMap((row) => row.output_ids ?? []);
    const outputs = outputIds.length ? (await q("SELECT id,kind,title,file_name,storage_key,url FROM local_outputs WHERE id=ANY($1::uuid[]) ORDER BY created_at,id",
      [outputIds])).rows as OutputRow[] : [];
    const artifacts = outputs.filter((row) => row.kind === "artifact" && row.storage_key);
    const keptLinks = new Set(kept.flatMap((item) => item.url ? [item.url] : []));
    const links = [...new Set(outputs.flatMap((row) => row.url && !keptLinks.has(row.url) ? [row.url] : []))];
    const topics = pending.filter((row) => row.body !== null);
    if (artifacts.length + topics.length > MAX_DELIVERABLE_FILES || links.length > MAX_LINKS)
      throw new CardError(400, "DELIVERABLE_LIMIT", `准备中的东西放不进一版：一版最多 ${MAX_DELIVERABLE_FILES} 份文件、${MAX_LINKS} 个链接，先拿掉几样`);
    const files: DeliverableFile[] = [];
    for (const row of artifacts) {
      const buffer = await readFile(join(storageDir, row.storage_key!)).catch(() => null);
      if (!buffer) throw new CardError(409, "OUTPUT_MISSING", `产出「${row.title}」找不到了，先把这张卡拿出来`);
      files.push({ filename: deliverableName(row.file_name ?? row.title), buffer });
    }
    for (const row of topics) files.push({ filename: `${safeName(`${row.topic_title} · ${row.label}`)}.md`, buffer: Buffer.from(row.body!) });
    const titles = pending.map((row) => row.card_title ?? `${row.topic_title} · ${row.label}`);
    const text = statement?.trim() || `这一版纳入：${titles.join("、")}`.slice(0, 2000);
    const version = await createDeliverableVersion(pool, own, files, { links, statement: text, keep: kept.map((item) => item.id) }, storageDir).catch((cause) => {
      if (cause instanceof DeliverableError) throw new CardError(cause.status, cause.code, cause.message);
      throw cause;
    });
    await q("UPDATE deliverable_pending_items SET version_id=$2 WHERE id=ANY($1::uuid[]) AND version_id IS NULL", [pending.map((row) => row.id), version.id]);
    return version;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => undefined);
    lock.release();
  }
}
