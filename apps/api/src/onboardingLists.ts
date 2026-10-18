import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TScheduleMigrationCandidate, TWorkBasisCandidate } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { inTransaction } from "./collector.js";

/**
 * 上手最后一页的两个清单（前端交互说明 10a、第 7 节 ③ 搬家、第 8 节工作依据清单）。
 * 候选每次按本人的数据现算：工作依据来自本人参与的执行事项里的材料与链接、采集器盘点到的近 30 天读过的飞书文档；
 * 搬家来自每台设备最近一次盘点里的本机定时任务。已经确认入库的始终列在里面（confirmed / imported）。
 * 提交时只收勾选的 key：候选里勾了的入库，候选里没勾的移出；不在候选里的 key 一律拒绝。
 */

export type ListResult<T> = { ok: true; candidates: T[] } | { ok: false; message: string };

const FEISHU = /^https:\/\/[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com)\/(docx|docs|wiki|sheets|base)\/([A-Za-z0-9_-]+)/;
const FEISHU_KIND: Record<string, string> = { docx: "文档", docs: "文档", wiki: "知识库", sheets: "表格", base: "多维表格" };

/** 飞书文档没有读文档的权限时拿不到标题：用类型加 token 前几位，点开能核对。 */
export function feishuFallbackTitle(url: string): string {
  const match = FEISHU.exec(url);
  return match ? `飞书${FEISHU_KIND[match[1]]} · ${match[2].slice(0, 8)}` : url.replace(/^https?:\/\//, "").slice(0, 80);
}

type BasisRow = { doc_kind: TWorkBasisCandidate["kind"]; doc_ref: string; title: string; url: string | null; revision: string | null };
const basisKey = (kind: string, ref: string) => `${kind}:${ref}`;

async function basisCandidates(q: Query, personId: string): Promise<BasisRow[]> {
  const [materials, docs, confirmed] = await Promise.all([
    q(`SELECT DISTINCT ON (m.id) m.id, m.file_name, m.format, m.url, m.current_version, tm.task_id, m.updated_at
      FROM object_materials m
      JOIN task_members tm ON m.object_type='task' AND tm.task_id::text=m.object_id
      JOIN tasks t ON t.id=tm.task_id
      WHERE tm.person_id=$1 AND tm.left_at IS NULL AND t.status<>'returned' AND m.deleted_at IS NULL AND m.nature='real'
      ORDER BY m.id`, [personId]),
    q(`SELECT item_key AS url, max(detail->>'title') AS title, max(read_at) AS read_at FROM local_inventory
      WHERE person_id=$1 AND kind='feishu_doc' GROUP BY item_key ORDER BY max(read_at) DESC NULLS LAST LIMIT 200`, [personId]),
    q("SELECT doc_kind, doc_ref, title, url, revision FROM work_basis WHERE person_id=$1 ORDER BY confirmed_at", [personId]),
  ]);
  const rows = new Map<string, BasisRow>();
  const add = (row: BasisRow) => { if (!rows.has(basisKey(row.doc_kind, row.doc_ref))) rows.set(basisKey(row.doc_kind, row.doc_ref), row); };
  for (const row of confirmed.rows as BasisRow[]) add(row);
  const sorted = (materials.rows as { id: string; file_name: string; format: string; url: string | null; current_version: number; task_id: string; updated_at: Date }[])
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  for (const m of sorted) {
    if (m.format === "link" && m.url) add({ doc_kind: FEISHU.test(m.url) ? "feishu_doc" : "link", doc_ref: m.url, title: m.file_name, url: m.url, revision: null });
    else add({ doc_kind: "material", doc_ref: m.id, title: m.file_name, url: `/me/tasks/${m.task_id}`, revision: `v${m.current_version}` });
  }
  for (const doc of docs.rows as { url: string; title: string | null }[])
    add({ doc_kind: "feishu_doc", doc_ref: doc.url, title: doc.title || feishuFallbackTitle(doc.url), url: doc.url, revision: null });
  return [...rows.values()];
}

export async function readWorkBasis(q: Query, personId: string): Promise<TWorkBasisCandidate[]> {
  const [rows, confirmed] = await Promise.all([basisCandidates(q, personId),
    q("SELECT doc_kind, doc_ref FROM work_basis WHERE person_id=$1", [personId])]);
  const saved = new Set((confirmed.rows as { doc_kind: string; doc_ref: string }[]).map((row) => basisKey(row.doc_kind, row.doc_ref)));
  return rows.map((row) => ({ key: basisKey(row.doc_kind, row.doc_ref), kind: row.doc_kind, title: row.title, url: row.url, revision: row.revision,
    confirmed: saved.has(basisKey(row.doc_kind, row.doc_ref)) }));
}

/** 勾选的入库并记下确认时的修订号；已经入库的保留原来的修订号和确认时间。 */
export async function saveWorkBasis(pool: Pool, personId: string, keys: string[], now: Date): Promise<ListResult<TWorkBasisCandidate>> {
  const candidates = await basisCandidates(pool.query.bind(pool), personId);
  const byKey = new Map(candidates.map((row) => [basisKey(row.doc_kind, row.doc_ref), row]));
  const unknown = keys.find((key) => !byKey.has(key));
  if (unknown) return { ok: false, message: "清单已经变了，请刷新后再确认" };
  const chosen = new Set(keys);
  await inTransaction(pool, async (q) => {
    for (const [key, row] of byKey) {
      if (chosen.has(key)) {
        await q(`INSERT INTO work_basis(id,person_id,doc_kind,doc_ref,title,url,revision,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (person_id,doc_kind,doc_ref) DO NOTHING`, [randomUUID(), personId, row.doc_kind, row.doc_ref, row.title.slice(0, 240), row.url, row.revision, now]);
      } else {
        await q("DELETE FROM work_basis WHERE person_id=$1 AND doc_kind=$2 AND doc_ref=$3", [personId, row.doc_kind, row.doc_ref]);
      }
    }
  });
  return { ok: true, candidates: await readWorkBasis(pool.query.bind(pool), personId) };
}

/** 采集器自己的定时任务（Windows 计划任务、macOS launchd）不算要搬的旧任务。 */
const OWN_TASKS = new Set(["TkosCollector", "com.tokenkingos.tkos-collector"]);
type ScheduleRow = { device_id: string; name: string; cadence: string | null; command: string | null; device_name: string };
const scheduleKey = (deviceId: string, name: string) => `${deviceId}:${name}`;

async function scheduleCandidates(q: Query, personId: string): Promise<ScheduleRow[]> {
  const devices = `(SELECT device_id, max(device_name) AS device_name FROM collector_health WHERE person_id=$1 GROUP BY device_id)`;
  const [found, imported] = await Promise.all([
    q(`SELECT i.device_id, i.item_key AS name, i.detail->>'schedule' AS cadence, i.detail->>'command' AS command, COALESCE(d.device_name, i.device_id) AS device_name
      FROM local_inventory i JOIN collector_scans s ON s.person_id=i.person_id AND s.device_id=i.device_id
      LEFT JOIN ${devices} d ON d.device_id=i.device_id
      WHERE i.person_id=$1 AND i.kind='scheduled_task' AND i.last_seen_at >= s.scanned_at ORDER BY d.device_name, i.item_key`, [personId]),
    q(`SELECT c.source_device_id AS device_id, c.source_key AS name, c.cadence, c.command, COALESCE(d.device_name, c.source_device_id) AS device_name
      FROM schedules c LEFT JOIN ${devices} d ON d.device_id=c.source_device_id
      WHERE c.person_id=$1 AND c.source='local' ORDER BY c.created_at`, [personId]),
  ]);
  const rows = new Map<string, ScheduleRow>();
  for (const row of [...imported.rows, ...found.rows] as ScheduleRow[])
    if (!OWN_TASKS.has(row.name) && !rows.has(scheduleKey(row.device_id, row.name))) rows.set(scheduleKey(row.device_id, row.name), row);
  return [...rows.values()];
}

export async function readScheduleMigration(q: Query, personId: string): Promise<TScheduleMigrationCandidate[]> {
  const [rows, imported] = await Promise.all([scheduleCandidates(q, personId),
    q("SELECT source_device_id, source_key FROM schedules WHERE person_id=$1 AND source='local'", [personId])]);
  const saved = new Set((imported.rows as { source_device_id: string; source_key: string }[]).map((row) => scheduleKey(row.source_device_id, row.source_key)));
  return rows.map((row) => ({ key: scheduleKey(row.device_id, row.name), name: row.name, cadence: row.cadence, command: row.command,
    deviceName: row.device_name, imported: saved.has(scheduleKey(row.device_id, row.name)) }));
}

/** 勾选的写进定时任务区（schedules）；候选里没勾的移出。 */
export async function saveScheduleMigration(pool: Pool, personId: string, keys: string[], now: Date): Promise<ListResult<TScheduleMigrationCandidate>> {
  const candidates = await scheduleCandidates(pool.query.bind(pool), personId);
  const byKey = new Map(candidates.map((row) => [scheduleKey(row.device_id, row.name), row]));
  if (keys.some((key) => !byKey.has(key))) return { ok: false, message: "清单已经变了，请刷新后再确认" };
  const chosen = new Set(keys);
  await inTransaction(pool, async (q) => {
    for (const [key, row] of byKey) {
      if (chosen.has(key)) {
        await q(`INSERT INTO schedules(id,person_id,name,cadence,command,source,source_device_id,source_key,created_at) VALUES($1,$2,$3,$4,$5,'local',$6,$7,$8)
          ON CONFLICT (person_id,source,source_device_id,source_key) DO NOTHING`, [randomUUID(), personId, row.name.slice(0, 200), row.cadence, row.command, row.device_id, row.name, now]);
      } else {
        await q("DELETE FROM schedules WHERE person_id=$1 AND source='local' AND source_device_id=$2 AND source_key=$3", [personId, row.device_id, row.name]);
      }
    }
  });
  return { ok: true, candidates: await readScheduleMigration(pool.query.bind(pool), personId) };
}
