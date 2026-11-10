import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import type { TCreateRoleRequest, TPatchRoleRequest, TRoleBrief, TRoleFamily, TRoleKind, TRoleListResponse, TRoleModelTier, TRoleProposalView, TRoleRef,
  TRoleRevisionField, TRoleRevisionView, TRoleTool, TRoleView } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";

/**
 * 岗位与团队（V2 设计第 19 节）的数据和接口：本人的岗位、组织预设、修改记录、伙伴提的岗位修改。
 * 预设写在仓库里 roles/presets/<family>/<key>.md（frontmatter 写 name、kind、tools、model_tier，正文三段「## 职责」「## 做法」「## 验收口径」），
 * 启动时同步进 roles（owner_id 空）：文件名就是 preset_key，内容变了版本 +1；文件删了预设归档。本人加预设是复制一份。
 */

export class RoleError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string, message: string) { super(message); }
}

export const PRESETS_DIR = new URL("./roles/presets/", import.meta.url);
const FAMILIES = new Set<TRoleFamily>(["general", "dev", "strategy_content"]);
const KINDS = new Set<TRoleKind>(["worker", "reviewer", "critic"]);
const TOOLS = new Set<TRoleTool>(["tianshu", "web_search", "feishu", "github", "browser"]);
const TIERS = new Set<TRoleModelTier>(["strong", "normal", "light"]);
const SECTIONS = [["职责", "dutiesMd"], ["做法", "practiceMd"], ["验收口径", "acceptanceMd"]] as const;
const TEXT_MAX = 8000;

export type PresetFile = { key: string; family: TRoleFamily; name: string; kind: TRoleKind; tools: TRoleTool[]; modelTier: TRoleModelTier;
  dutiesMd: string; practiceMd: string; acceptanceMd: string };

/** 读一个预设文件；格式不对时抛错，说清哪里不对。 */
export function parsePreset(text: string, family: string, key: string): PresetFile {
  const where = `${family}/${key}.md`;
  if (!FAMILIES.has(family as TRoleFamily)) throw new Error(`${where}：分组只能是 ${[...FAMILIES].join("、")}`);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key)) throw new Error(`${where}：文件名只能用小写字母、数字、- 和 _`);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!match) throw new Error(`${where}：开头要有 --- 包起来的 frontmatter`);
  const meta = new Map(match[1].split(/\r?\n/).flatMap((line) => {
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    return pair ? [[pair[1], pair[2].trim()] as const] : [];
  }));
  const name = meta.get("name") ?? "";
  if (!name || name.length > 20) throw new Error(`${where}：name 要有，不超过 20 字`);
  const kind = meta.get("kind") as TRoleKind;
  if (!KINDS.has(kind)) throw new Error(`${where}：kind 只能是 worker、reviewer、critic`);
  const tools = (meta.get("tools") ?? "").replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter(Boolean) as TRoleTool[];
  if (tools.some((tool) => !TOOLS.has(tool))) throw new Error(`${where}：tools 只能是 ${[...TOOLS].join("、")}`);
  const modelTier = (meta.get("model_tier") ?? "normal") as TRoleModelTier;
  if (!TIERS.has(modelTier)) throw new Error(`${where}：model_tier 只能是 strong、normal、light`);
  const parts = match[2].split(/^##\s+(.+?)\s*$/m);
  const sections = new Map<string, string>();
  for (let index = 1; index < parts.length; index += 2) sections.set(parts[index], parts[index + 1].trim());
  const body = Object.fromEntries(SECTIONS.map(([title, field]) => {
    const value = sections.get(title);
    if (value === undefined) throw new Error(`${where}：正文要有「## ${title}」一段`);
    if (value.length > TEXT_MAX) throw new Error(`${where}：「${title}」超过 ${TEXT_MAX} 字`);
    return [field, value];
  })) as Pick<PresetFile, "dutiesMd" | "practiceMd" | "acceptanceMd">;
  return { key, family: family as TRoleFamily, name, kind, tools: [...new Set(tools)], modelTier, ...body };
}

/** 读预设目录下的全部预设；坏文件不拦启动，记进 errors。preset_key 在各包之间也不能重。 */
export async function readPresets(dir: string = fileURLToPath(PRESETS_DIR)): Promise<{ presets: PresetFile[]; errors: string[] }> {
  const presets: PresetFile[] = [], errors: string[] = [];
  const families = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const family of families.filter((entry) => entry.isDirectory())) {
    for (const file of (await readdir(join(dir, family.name))).filter((name) => name.endsWith(".md")).sort()) {
      const key = basename(file, ".md");
      try {
        const preset = parsePreset(await readFile(join(dir, family.name, file), "utf8"), family.name, key);
        if (presets.some((item) => item.key === key)) throw new Error(`${family.name}/${file}：文件名 ${key} 和别的包里的重了`);
        presets.push(preset);
      } catch (cause) { errors.push((cause as Error).message); }
    }
  }
  return { presets, errors };
}

/** 启动时把预设同步进 roles：新的插入，内容变了的版本 +1，文件没了的归档、回来了取消归档。 */
export async function syncRolePresets(pool: Pool, presets: PresetFile[], now: Date): Promise<{ inserted: number; updated: number; archived: number }> {
  const client = await pool.connect();
  const counts = { inserted: 0, updated: 0, archived: 0 };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('role-presets'))");
    const existing = new Map(((await client.query("SELECT * FROM roles WHERE owner_id IS NULL")).rows as RoleRow[]).map((row) => [row.preset_key!, row]));
    for (const preset of presets) {
      const row = existing.get(preset.key);
      const values = [preset.name, preset.family, preset.kind, preset.dutiesMd, preset.practiceMd, preset.acceptanceMd, preset.tools, preset.modelTier];
      if (!row) {
        await client.query(`INSERT INTO roles(id,owner_id,preset_key,preset_version,name,family,kind,duties_md,practice_md,acceptance_md,tools,model_tier,version,created_at,updated_at)
          VALUES($1,NULL,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)`, [randomUUID(), preset.key, ...values, now]);
        counts.inserted++;
        continue;
      }
      const same = row.name === preset.name && row.family === preset.family && row.kind === preset.kind && row.duties_md === preset.dutiesMd
        && row.practice_md === preset.practiceMd && row.acceptance_md === preset.acceptanceMd && row.tools.join() === preset.tools.join() && row.model_tier === preset.modelTier;
      if (same && !row.archived_at) continue;
      await client.query(`UPDATE roles SET name=$2,family=$3,kind=$4,duties_md=$5,practice_md=$6,acceptance_md=$7,tools=$8,model_tier=$9,
        version=version+$11,preset_version=version+$11,archived_at=NULL,updated_at=$10 WHERE id=$1`, [row.id, ...values, now, same ? 0 : 1]);
      counts.updated++;
    }
    const gone = [...existing.values()].filter((row) => !row.archived_at && !presets.some((preset) => preset.key === row.preset_key)).map((row) => row.id);
    if (gone.length) counts.archived = (await client.query("UPDATE roles SET archived_at=$2 WHERE id=ANY($1::uuid[])", [gone, now])).rowCount ?? 0;
    await client.query("COMMIT");
    return counts;
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export type RoleRow = { id: string; owner_id: string | null; preset_key: string | null; preset_version: number | null; name: string; family: TRoleFamily; kind: TRoleKind;
  duties_md: string; practice_md: string; acceptance_md: string; tools: TRoleTool[]; model_tier: TRoleModelTier; version: number; archived_at: Date | null;
  updated_at: Date; updated_by: string | null };

export const roleRef = (row: Pick<RoleRow, "id" | "name" | "kind">): TRoleRef => ({ id: row.id, name: row.name, kind: row.kind });
export const roleBrief = (row: RoleRow): TRoleBrief => ({ id: row.id, name: row.name, kind: row.kind, dutiesMd: row.duties_md, practiceMd: row.practice_md,
  acceptanceMd: row.acceptance_md, tools: row.tools, modelTier: row.model_tier, version: row.version });
const roleView = (row: RoleRow, names: Map<string, string>): TRoleView => ({ ...roleBrief(row), family: row.family, presetKey: row.preset_key,
  presetVersion: row.preset_version, updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by ? { personId: row.updated_by, name: names.get(row.updated_by) ?? row.updated_by } : null });

/** GET /api/me/roles：本人没归档的岗位，加没归档的预设（标明本人已经加过没有）。 */
export async function listRoles(q: Query, ownerId: string, names: Map<string, string>): Promise<TRoleListResponse> {
  const own = (await q("SELECT * FROM roles WHERE owner_id=$1 AND archived_at IS NULL ORDER BY created_at,id", [ownerId])).rows as RoleRow[];
  const presets = (await q("SELECT * FROM roles WHERE owner_id IS NULL AND archived_at IS NULL ORDER BY family,preset_key")).rows as RoleRow[];
  const added = new Set(own.flatMap((row) => row.preset_key ? [row.preset_key] : []));
  return { roles: own.map((row) => roleView(row, names)),
    presets: presets.map((row) => ({ presetKey: row.preset_key!, name: row.name, family: row.family, kind: row.kind, dutiesMd: row.duties_md, tools: row.tools,
      modelTier: row.model_tier, version: row.version, added: added.has(row.preset_key!) })) };
}

/** 本人没归档的岗位；不是本人的、归档了的当找不到。 */
export async function ownRole(q: Query, ownerId: string, id: string): Promise<RoleRow> {
  const row = UUID_PATTERN.test(id) ? (await q("SELECT * FROM roles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL", [id, ownerId])).rows[0] as RoleRow | undefined : undefined;
  if (!row) throw new RoleError(404, "ROLE_NOT_FOUND", "找不到这个技能");
  return row;
}

/** POST /api/me/roles：从预设复制（本人已经加过同一个预设 409），或自己新建。 */
export async function createRole(pool: Pool, ownerId: string, input: TCreateRoleRequest, names: Map<string, string>, now: Date): Promise<TRoleView> {
  const id = randomUUID();
  if ("presetKey" in input) {
    const preset = (await pool.query("SELECT * FROM roles WHERE owner_id IS NULL AND preset_key=$1 AND archived_at IS NULL", [input.presetKey])).rows[0] as RoleRow | undefined;
    if (!preset) throw new RoleError(404, "PRESET_NOT_FOUND", "没有这个预设技能");
    const inserted = await pool.query(`INSERT INTO roles(id,owner_id,preset_key,preset_version,name,family,kind,duties_md,practice_md,acceptance_md,tools,model_tier,created_at,updated_at,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$2) ON CONFLICT (owner_id,preset_key) WHERE owner_id IS NOT NULL AND preset_key IS NOT NULL AND archived_at IS NULL DO NOTHING`,
    [id, ownerId, preset.preset_key, preset.version, preset.name, preset.family, preset.kind, preset.duties_md, preset.practice_md, preset.acceptance_md, preset.tools, preset.model_tier, now]);
    if (!inserted.rowCount) throw new RoleError(409, "PRESET_ADDED", "这个技能已经加过了");
  } else {
    await pool.query(`INSERT INTO roles(id,owner_id,name,family,kind,duties_md,practice_md,acceptance_md,tools,model_tier,created_at,updated_at,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$2)`, [id, ownerId, input.name.trim(), input.family, input.kind, input.dutiesMd ?? "", input.practiceMd ?? "",
      input.acceptanceMd ?? "", [...new Set(input.tools ?? [])], input.modelTier ?? "normal", now]);
  }
  return roleView((await pool.query("SELECT * FROM roles WHERE id=$1", [id])).rows[0] as RoleRow, names);
}

const FIELD_COLUMNS: Record<TRoleRevisionField, keyof RoleRow> = { name: "name", dutiesMd: "duties_md", practiceMd: "practice_md", acceptanceMd: "acceptance_md",
  tools: "tools", modelTier: "model_tier" };
const display = (value: unknown) => Array.isArray(value) ? value.join(", ") : String(value ?? "");

/** 在事务里改岗位的几段：版本 +1，留一条修改记录。fields 里和现在一样的不算改。没有真改动时不动。 */
export async function reviseRole(client: PoolClient, row: RoleRow, fields: Partial<Record<TRoleRevisionField, unknown>>, by: string,
  meta: { reason: string | null; source: "manual" | "proposal"; proposalId: string | null }, now: Date): Promise<boolean> {
  const changes = (Object.keys(fields) as TRoleRevisionField[]).filter((field) => fields[field] !== undefined && display(fields[field]) !== display(row[FIELD_COLUMNS[field]]))
    .map((field) => ({ field, before: display(row[FIELD_COLUMNS[field]]), after: display(fields[field]) }));
  if (!changes.length) return false;
  const next = { ...row, ...Object.fromEntries(changes.map(({ field }) => [FIELD_COLUMNS[field], fields[field]])) } as RoleRow;
  await client.query(`UPDATE roles SET name=$2,duties_md=$3,practice_md=$4,acceptance_md=$5,tools=$6,model_tier=$7,version=version+1,updated_at=$8,updated_by=$9 WHERE id=$1`,
    [row.id, next.name, next.duties_md, next.practice_md, next.acceptance_md, [...new Set(next.tools)], next.model_tier, now, by]);
  await client.query(`INSERT INTO role_revisions(id,role_id,version,changes,reason,source,proposal_id,created_by,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
    [randomUUID(), row.id, row.version + 1, JSON.stringify(changes), meta.reason, meta.source, meta.proposalId, by, now]);
  return true;
}

/** PATCH /api/me/roles/:id：版本不一致 409；保存后版本 +1、留记录。 */
export async function patchRole(pool: Pool, ownerId: string, id: string, input: TPatchRoleRequest, names: Map<string, string>, now: Date): Promise<TRoleView> {
  const { version, reason, ...fields } = input;
  if (!Object.keys(fields).length) throw new RoleError(400, "INVALID_INPUT", "至少改一样");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = UUID_PATTERN.test(id) ? (await client.query("SELECT * FROM roles WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE",
      [id, ownerId])).rows[0] as RoleRow | undefined : undefined;
    if (!row) throw new RoleError(404, "ROLE_NOT_FOUND", "找不到这个技能");
    if (row.version !== version) throw new RoleError(409, "ROLE_VERSION_CONFLICT", "技能已经被改过，请基于最新内容再改");
    await reviseRole(client, row, { ...fields, ...(fields.name ? { name: fields.name.trim() } : {}) }, ownerId,
      { reason: reason?.trim() || null, source: "manual", proposalId: null }, now);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return roleView((await pool.query("SELECT * FROM roles WHERE id=$1", [id])).rows[0] as RoleRow, names);
}

/** DELETE /api/me/roles/:id：归档，卡上的快照不受影响。 */
export async function archiveRole(q: Query, ownerId: string, id: string, now: Date): Promise<void> {
  await ownRole(q, ownerId, id);
  await q("UPDATE roles SET archived_at=$3,updated_at=$3 WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL", [id, ownerId, now]);
}

/** GET /api/me/roles/:id/revisions：本人的岗位（归档了的也能看）的修改记录，新的在前。 */
export async function listRevisions(q: Query, ownerId: string, id: string, names: Map<string, string>): Promise<TRoleRevisionView[]> {
  const owned = UUID_PATTERN.test(id) && (await q("SELECT 1 FROM roles WHERE id=$1 AND owner_id=$2", [id, ownerId])).rowCount;
  if (!owned) throw new RoleError(404, "ROLE_NOT_FOUND", "找不到这个技能");
  const rows = (await q("SELECT * FROM role_revisions WHERE role_id=$1 ORDER BY version DESC", [id])).rows as { id: string; version: number;
    changes: TRoleRevisionView["changes"]; reason: string | null; source: "manual" | "proposal"; proposal_id: string | null; created_by: string; created_at: Date }[];
  return rows.map((row) => ({ id: row.id, version: row.version, changes: row.changes, reason: row.reason, source: row.source, proposalId: row.proposal_id,
    createdBy: { personId: row.created_by, name: names.get(row.created_by) ?? row.created_by }, createdAt: row.created_at.toISOString() }));
}

/** 一批岗位（卡、草稿、专题上显示用），归档了的也给。 */
export async function rolesById(q: Query, ids: (string | null)[]): Promise<Map<string, RoleRow>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  return new Map(((await q("SELECT * FROM roles WHERE id=ANY($1::uuid[])", [unique])).rows as RoleRow[]).map((row) => [row.id, row]));
}

/** 验收员：本人团队里没归档的验收员岗位（最早加的那个），没有时用预设的验收员。 */
export async function reviewerRole(q: Query, ownerId: string): Promise<RoleRow | null> {
  return (await q(`SELECT * FROM roles WHERE kind='reviewer' AND archived_at IS NULL AND (owner_id=$1 OR owner_id IS NULL)
    ORDER BY (owner_id IS NULL), created_at, preset_key LIMIT 1`, [ownerId])).rows[0] as RoleRow | undefined ?? null;
}

/** 是不是规划员（从预设 planner 加的，或名字就叫「规划员」）：派活单不派给它。 */
export const isPlannerRole = (row: Pick<RoleRow, "preset_key" | "name">) => row.preset_key === "planner" || row.name === "规划员";

/** 规划员（第 21 节）：本人团队里没归档的规划员（从预设 planner 加的，或名字就叫「规划员」），没有时用预设的。 */
export async function plannerRole(q: Query, ownerId: string): Promise<RoleRow | null> {
  return (await q(`SELECT * FROM roles WHERE archived_at IS NULL AND ((owner_id=$1 AND (preset_key='planner' OR name='规划员')) OR (owner_id IS NULL AND preset_key='planner'))
    ORDER BY (owner_id IS NULL), created_at LIMIT 1`, [ownerId])).rows[0] as RoleRow | undefined ?? null;
}

/**
 * 本人从某个预设加的岗位（没归档的）；还没加过就照预设复制一份给本人（同 POST /api/me/roles 的从预设加）。预设不在了为 null。
 * 在调用方的事务里跑。派活单放进看板时给没配岗位的卡兜底用。
 */
export async function ensurePresetRole(client: PoolClient, ownerId: string, presetKey: string, now: Date): Promise<RoleRow | null> {
  await client.query(`INSERT INTO roles(id,owner_id,preset_key,preset_version,name,family,kind,duties_md,practice_md,acceptance_md,tools,model_tier,created_at,updated_at,updated_by)
    SELECT $1,$2,preset_key,version,name,family,kind,duties_md,practice_md,acceptance_md,tools,model_tier,$4,$4,$2 FROM roles
    WHERE owner_id IS NULL AND preset_key=$3 AND archived_at IS NULL
    ON CONFLICT (owner_id,preset_key) WHERE owner_id IS NOT NULL AND preset_key IS NOT NULL AND archived_at IS NULL DO NOTHING`, [randomUUID(), ownerId, presetKey, now]);
  return (await client.query("SELECT * FROM roles WHERE owner_id=$1 AND preset_key=$2 AND archived_at IS NULL", [ownerId, presetKey])).rows[0] as RoleRow | undefined ?? null;
}

/** 评审会的挑刺岗位：本人点了的（要是本人没归档的挑刺岗位），没点时取本人的前 3 个。 */
export async function criticRoles(q: Query, ownerId: string, picked?: string[]): Promise<RoleRow[]> {
  const rows = (await q("SELECT * FROM roles WHERE owner_id=$1 AND kind='critic' AND archived_at IS NULL ORDER BY created_at,id", [ownerId])).rows as RoleRow[];
  if (!picked) return rows.slice(0, 3);
  const chosen = picked.map((id) => rows.find((row) => row.id === id));
  if (chosen.some((row) => !row) || picked.length > 3) throw new RoleError(400, "INVALID_CRITICS", "评审会最多点 3 个本人的挑刺技能");
  return chosen as RoleRow[];
}

type ProposalRow = { id: string; role_id: string; owner_id: string; task_id: string; source_kind: "overrule" | "second_fail"; source_id: string; base_version: number;
  field: "duties_md" | "practice_md" | "acceptance_md" | null; proposed_text: string | null; why: string | null; status: string; created_at: Date; decided_at: Date | null };
const FIELD_OF = { duties_md: "dutiesMd", practice_md: "practiceMd", acceptance_md: "acceptanceMd" } as const;

/** GET /api/me/role-proposals：本人看得到的是待确认、采纳、不要了的（作业还在写、没写成的不给）。 */
export async function listProposals(q: Query, ownerId: string, status: "open" | "all"): Promise<TRoleProposalView[]> {
  const rows = (await q(`SELECT p.*,r.name AS role_name,r.kind AS role_kind,r.duties_md,r.practice_md,r.acceptance_md,t.title AS card_title
    FROM role_proposals p JOIN roles r ON r.id=p.role_id JOIN tasks t ON t.id=p.task_id
    WHERE p.owner_id=$1 AND p.status=ANY($2::text[]) ORDER BY p.created_at DESC,p.id`,
  [ownerId, status === "open" ? ["open"] : ["open", "accepted", "dismissed"]])).rows as (ProposalRow & RoleRow & { role_name: string; role_kind: TRoleKind; card_title: string })[];
  return rows.map((row) => ({ id: row.id, role: { id: row.role_id, name: row.role_name, kind: row.role_kind }, baseVersion: row.base_version, sourceKind: row.source_kind,
    handbackId: row.source_id, card: { id: row.task_id, title: row.card_title }, field: FIELD_OF[row.field!], currentText: row[row.field!], proposedText: row.proposed_text!,
    why: row.why!, status: row.status as TRoleProposalView["status"], createdAt: row.created_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null }));
}

async function lockedProposal(client: PoolClient, ownerId: string, id: string): Promise<ProposalRow> {
  const row = UUID_PATTERN.test(id) ? (await client.query("SELECT * FROM role_proposals WHERE id=$1 AND owner_id=$2 FOR UPDATE", [id, ownerId])).rows[0] as ProposalRow | undefined : undefined;
  if (!row || row.status === "drafting" || row.status === "failed") throw new RoleError(404, "PROPOSAL_NOT_FOUND", "找不到这条技能修改");
  if (row.status !== "open") throw new RoleError(409, "PROPOSAL_DECIDED", "这条技能修改已经处理过了");
  return row;
}

/** 采纳：改后的整段写回岗位，版本 +1、留记录（来源是这条修改）；岗位在提了以后又改过时 409 ROLE_CHANGED。返回改好的岗位。 */
export async function acceptProposal(pool: Pool, ownerId: string, id: string, names: Map<string, string>, now: Date): Promise<TRoleView> {
  const client = await pool.connect();
  let roleId: string;
  try {
    await client.query("BEGIN");
    const proposal = await lockedProposal(client, ownerId, id);
    const role = (await client.query("SELECT * FROM roles WHERE id=$1 AND owner_id=$2 FOR UPDATE", [proposal.role_id, ownerId])).rows[0] as RoleRow | undefined;
    if (!role || role.archived_at) throw new RoleError(409, "ROLE_ARCHIVED", "这个技能已经归档了");
    if (role.version !== proposal.base_version) throw new RoleError(409, "ROLE_CHANGED", "技能在这之后改过了，这条修改对不上了");
    await reviseRole(client, role, { [FIELD_OF[proposal.field!]]: proposal.proposed_text }, ownerId,
      { reason: proposal.why, source: "proposal", proposalId: proposal.id }, now);
    await client.query("UPDATE role_proposals SET status='accepted',decided_at=$2 WHERE id=$1", [id, now]);
    await client.query("COMMIT");
    roleId = role.id;
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return roleView((await pool.query("SELECT * FROM roles WHERE id=$1", [roleId])).rows[0] as RoleRow, names);
}

/** 不要这条岗位修改。 */
export async function dismissProposal(pool: Pool, ownerId: string, id: string, now: Date): Promise<TRoleProposalView> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockedProposal(client, ownerId, id);
    await client.query("UPDATE role_proposals SET status='dismissed',decided_at=$2 WHERE id=$1", [id, now]);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  return (await listProposals(pool.query.bind(pool), ownerId, "all")).find((item) => item.id === id)!;
}
