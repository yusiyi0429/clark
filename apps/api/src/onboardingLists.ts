import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TScheduleMigrationCandidate, TWorkBasisCandidate } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { inTransaction } from "./collector.js";
import type { FeishuClient, FeishuDocType } from "./feishu/client.js";
import type { FeishuEnv } from "./feishu/config.js";
import { readUserAccessToken } from "./feishu/tokens.js";

/**
 * 上手最后一页的两个清单（前端交互说明 10a、第 7 节 ③ 搬家、第 8 节工作依据清单）。
 * 候选每次按本人的数据现算：工作依据来自本人参与的执行事项里的材料与链接、采集器盘点到的近 30 天读过的飞书文档（读不到标题的不列）；
 * 搬家来自每台设备最近一次盘点里的本机定时任务，只留工作用的（isWorkSchedule）。已经确认入库的始终列在里面（confirmed / imported）。
 * 提交时只收勾选的 key：候选里勾了的入库，候选里没勾的移出；不在候选里的 key 一律拒绝。
 */

export type ListResult<T> = { ok: true; candidates: T[] } | { ok: false; message: string };

export const FEISHU = /^https:\/\/[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com)\/(docx|docs|wiki|sheets|base)\/([A-Za-z0-9_-]+)/;

/** 文档身份：飞书文档按 token 认（换了域名、带了参数也是同一份），其他按类型加引用。文档变更里的候选 key 也用它。 */
export function docKey(kind: string, ref: string): string {
  const match = kind === "feishu_doc" ? FEISHU.exec(ref) : null;
  return match ? `feishu:${match[2]}` : `${kind}:${ref}`;
}
const FEISHU_KIND: Record<string, string> = { docx: "文档", docs: "文档", wiki: "知识库", sheets: "表格", base: "多维表格" };

/** 飞书文档没有读文档的权限时拿不到标题：用类型加 token 前几位，点开能核对。 */
export function feishuFallbackTitle(url: string): string {
  const match = FEISHU.exec(url);
  return match ? `飞书${FEISHU_KIND[match[1]]} · ${match[2].slice(0, 8)}` : url.replace(/^https?:\/\//, "").slice(0, 80);
}

type BasisRow = {
  doc_kind: TWorkBasisCandidate["kind"]; doc_ref: string; title: string; url: string | null; revision: string | null; origin: TWorkBasisCandidate["origin"];
  revised_at: Date | null; revised_by: string | null;
  /** 会话里读过的飞书文档，标题还是 feishuFallbackTitle 兜底的：读到元数据才算有标题，没有的不列。 */
  untitled?: boolean;
};
const basisKey = (kind: string, ref: string) => `${kind}:${ref}`;

/** 读飞书文档元数据要的：开放接口和解密本人 user token 的密钥。没配飞书时为空，飞书文档只有兜底标题。 */
export type FeishuDocReader = { client: Pick<FeishuClient, "getDocMetas">; env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion"> };
const DOC_TYPE: Record<string, FeishuDocType> = { docx: "docx", docs: "doc", wiki: "wiki", sheets: "sheet", base: "bitable" };

/**
 * 以本人身份读飞书文档的标题、最近修订时间和修订人（drive:drive.metadata:readonly，不读正文），
 * 修订人按 feishu_identities 换成名字。本人没授权、令牌过期或接口失败时什么都不补，清单照常列出。
 */
async function enrichFeishuDocs(q: Query, personId: string, rows: BasisRow[], feishu: FeishuDocReader | undefined, now: Date): Promise<void> {
  const docs = rows.flatMap((row) => {
    const match = row.doc_kind === "feishu_doc" && !row.revised_at ? FEISHU.exec(row.doc_ref) : null;
    return match ? [{ row, token: match[2], type: DOC_TYPE[match[1]] }] : [];
  });
  if (!feishu || !docs.length) return;
  try {
    const token = await readUserAccessToken(q, feishu.env, personId, now);
    if (!token) return;
    const metas = new Map((await feishu.client.getDocMetas(token, docs.slice(0, 200).map(({ token: doc, type }) => ({ token: doc, type })))).map((meta) => [meta.token, meta]));
    const openIds = [...new Set([...metas.values()].flatMap((meta) => meta.modifiedBy ? [meta.modifiedBy] : []))];
    const names = new Map(openIds.length ? ((await q("SELECT open_id, name FROM feishu_identities WHERE open_id = ANY($1)", [openIds])).rows as { open_id: string; name: string | null }[])
      .map((row) => [row.open_id, row.name]) : []);
    for (const { row, token: docToken } of docs) {
      const meta = metas.get(docToken);
      if (!meta) continue;
      row.title = meta.title || row.title;
      if (meta.title) row.untitled = false;
      row.revised_at = meta.modifiedAt;
      row.revised_by = meta.modifiedBy ? names.get(meta.modifiedBy) ?? null : null;
    }
  } catch (cause) {
    console.warn(`feishu doc metas failed: ${(cause as Error).message}`);
  }
}

async function basisCandidates(q: Query, personId: string, feishu: FeishuDocReader | undefined, now: Date): Promise<BasisRow[]> {
  const [materials, docs, confirmed] = await Promise.all([
    q(`SELECT DISTINCT ON (m.id) m.id, m.file_name, m.format, m.url, m.current_version, tm.task_id, m.updated_at
      FROM object_materials m
      JOIN task_members tm ON m.object_type='task' AND tm.task_id::text=m.object_id
      JOIN tasks t ON t.id=tm.task_id
      WHERE tm.person_id=$1 AND tm.left_at IS NULL AND t.status<>'returned' AND m.deleted_at IS NULL AND m.nature='real'
      ORDER BY m.id`, [personId]),
    q(`SELECT item_key AS url, max(detail->>'title') AS title, max(read_at) AS read_at FROM local_inventory
      WHERE person_id=$1 AND kind='feishu_doc' GROUP BY item_key ORDER BY max(read_at) DESC NULLS LAST LIMIT 200`, [personId]),
    q("SELECT doc_kind, doc_ref, title, url, revision, revised_at, revised_by FROM work_basis WHERE person_id=$1 ORDER BY confirmed_at", [personId]),
  ]);
  const rows = new Map<string, BasisRow>();
  // 已确认的保留确认时的标题和修订号；来源按现在还能找到的地方标。
  const add = (row: BasisRow) => {
    const key = basisKey(row.doc_kind, row.doc_ref), existing = rows.get(key);
    if (!existing) rows.set(key, row);
    else if (!existing.origin) existing.origin = row.origin;
  };
  for (const row of confirmed.rows as Omit<BasisRow, "origin">[]) add({ ...row, origin: null });
  const sorted = (materials.rows as { id: string; file_name: string; format: string; url: string | null; current_version: number; task_id: string; updated_at: Date }[])
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  for (const m of sorted) {
    if (m.format === "link" && m.url) add({ doc_kind: FEISHU.test(m.url) ? "feishu_doc" : "link", doc_ref: m.url, title: m.file_name, url: m.url, revision: null, origin: "task", revised_at: null, revised_by: null });
    else add({ doc_kind: "material", doc_ref: m.id, title: m.file_name, url: `/me/tasks/${m.task_id}`, revision: `v${m.current_version}`, origin: "task", revised_at: null, revised_by: null });
  }
  for (const doc of docs.rows as { url: string; title: string | null }[])
    add({ doc_kind: "feishu_doc", doc_ref: doc.url, title: doc.title || feishuFallbackTitle(doc.url), url: doc.url, revision: null, origin: "session", revised_at: null, revised_by: null, untitled: !doc.title });
  const list = [...rows.values()];
  await enrichFeishuDocs(q, personId, list, feishu, now);
  return list.filter((row) => !row.untitled);
}

export async function readWorkBasis(q: Query, personId: string, feishu: FeishuDocReader | undefined, now: Date): Promise<TWorkBasisCandidate[]> {
  const [rows, confirmed, superseded] = await Promise.all([basisCandidates(q, personId, feishu, now),
    q("SELECT doc_kind, doc_ref, to_char(keep_until, 'YYYY-MM-DD') AS keep_until FROM work_basis WHERE person_id=$1", [personId]),
    // 文档变更里确认取代了的旧文档：在清单里标出来，带上新文档。
    q(`SELECT DISTINCT ON (c.key) c.key, d.title, d.doc_ref FROM doc_change_candidates c JOIN doc_changes d ON d.id = c.doc_change_id
      WHERE c.relation = 'supersede' ORDER BY c.key, d.decided_at DESC NULLS LAST`)]);
  const saved = new Map((confirmed.rows as { doc_kind: string; doc_ref: string; keep_until: string | null }[]).map((row) => [basisKey(row.doc_kind, row.doc_ref), row.keep_until]));
  // 同一个链接被整篇改写成另一份（例如 M1-B L3 v6 → M2 战略解码）时不标「被自己取代」。
  const replaced = new Map((superseded.rows as { key: string; title: string; doc_ref: string }[])
    .filter((row) => docKey("feishu_doc", row.doc_ref) !== row.key).map((row) => [row.key, { title: row.title, url: row.doc_ref }]));
  return rows.map((row) => ({ key: basisKey(row.doc_kind, row.doc_ref), kind: row.doc_kind, title: row.title, url: row.url, revision: row.revision,
    origin: row.origin, revisedAt: row.revised_at?.toISOString() ?? null, revisedBy: row.revised_by, confirmed: saved.has(basisKey(row.doc_kind, row.doc_ref)),
    supersededBy: replaced.get(docKey(row.doc_kind, row.doc_ref)) ?? null, keepUntil: saved.get(basisKey(row.doc_kind, row.doc_ref)) ?? null }));
}

/** 勾选的入库并记下确认时的修订号；已经入库的保留原来的修订号和确认时间。 */
export async function saveWorkBasis(pool: Pool, personId: string, keys: string[], feishu: FeishuDocReader | undefined, now: Date): Promise<ListResult<TWorkBasisCandidate>> {
  const candidates = await basisCandidates(pool.query.bind(pool), personId, feishu, now);
  const byKey = new Map(candidates.map((row) => [basisKey(row.doc_kind, row.doc_ref), row]));
  const unknown = keys.find((key) => !byKey.has(key));
  if (unknown) return { ok: false, message: "清单已经变了，请刷新后再确认" };
  const chosen = new Set(keys);
  await inTransaction(pool, async (q) => {
    for (const [key, row] of byKey) {
      if (chosen.has(key)) {
        await q(`INSERT INTO work_basis(id,person_id,doc_kind,doc_ref,title,url,revision,revised_at,revised_by,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (person_id,doc_kind,doc_ref) DO NOTHING`, [randomUUID(), personId, row.doc_kind, row.doc_ref, row.title.slice(0, 240), row.url, row.revision,
          row.revised_at, row.revised_by, now]);
      } else {
        await q("DELETE FROM work_basis WHERE person_id=$1 AND doc_kind=$2 AND doc_ref=$3", [personId, row.doc_kind, row.doc_ref]);
      }
    }
  });
  return { ok: true, candidates: await readWorkBasis(pool.query.bind(pool), personId, feishu, now) };
}

/** 采集器自己的定时任务（Windows 计划任务、macOS launchd）不算要搬的旧任务。 */
const OWN_TASKS = new Set(["TkosCollector", "com.tokenkingos.tkos-collector"]);
type ScheduleRow = { device_id: string; name: string; cadence: string | null; command: string | null; device_name: string };
const scheduleKey = (deviceId: string, name: string) => `${deviceId}:${name}`;

/** 按时间跑的触发器：Windows 的 Daily/Weekly/Monthly/MonthlyDOW/Time，macOS 的「每 N 秒」/StartCalendarInterval，crontab 的五段时间。 */
const TIMED_TRIGGER = /^(?:Daily|Weekly|Monthly|MonthlyDOW|Time)$/i;
const CRON = /^[\d*/,A-Za-z-]+(?:\s+[\d*/,A-Za-z-]+){4}$/;
function timed(cadence: string | null): boolean {
  if (!cadence) return false;
  if (/^每 \d+ 秒$/.test(cadence) || cadence === "StartCalendarInterval") return true;
  if (CRON.test(cadence) && /[\d*]/.test(cadence)) return true;
  return cadence.split(/,\s*/).some((trigger) => TIMED_TRIGGER.test(trigger));
}
/** 命令里的路径：引号里的整段（可带空格），其余按空白切。 */
const TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;
const HOME = /^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]|\/Users\/[^/]+\/|\/home\/[^/]+\/|~[\\/])/i;
const SCRIPT = /\.(?:ps1|py|js|mjs|ts|sh|bat|cmd)$/i;
/** 系统和厂商的目录；npm 全局装的 claude、codex 在 AppData\Roaming\npm，不算厂商。 */
const VENDOR = /^(?:[A-Za-z]:[\\/](?:Program Files(?: \(x86\))?|Windows|ProgramData)[\\/]|[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]AppData[\\/](?:Local[\\/]Microsoft|Roaming[\\/](?!npm[\\/])[^\\/]+)[\\/])/i;
const AI_TOOL = /(?<![A-Za-z0-9])(?:claude|codex|tkos|tianshu|world)(?![A-Za-z0-9])/i;

/**
 * 搬家清单只列工作用的定时任务：按时间跑，且命令跑的是本人主目录下的脚本（不在厂商目录里），
 * 或者提到 AI 工具而本身不是系统、厂商目录里的程序。只在登录、开机、事件时触发的不算。
 */
export function isWorkSchedule(row: { cadence: string | null; command: string | null }): boolean {
  if (!timed(row.cadence) || !row.command) return false;
  const tokens = [...row.command.matchAll(TOKEN)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (tokens.some((token) => HOME.test(token) && SCRIPT.test(token) && !VENDOR.test(token))) return true;
  // 计划任务里的程序路径常不带引号（C:\Program Files\…），按命令开头判断。
  return AI_TOOL.test(row.command) && !VENDOR.test(row.command.replace(/^["']/, ""));
}

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
  // 搬过的照旧列出；本机盘点到的只留工作用的。
  for (const row of [...imported.rows, ...(found.rows as ScheduleRow[]).filter(isWorkSchedule)] as ScheduleRow[])
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
