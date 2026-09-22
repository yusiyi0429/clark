import { randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import type { TCapabilityCardPayload, TCard } from "@warmap/contracts";
import { hasNameSlugConflict, slugId } from "./slug.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type CapabilityRow = { id: string; version: number; name: string; group: string; description: string };

/** 能力注册表行：首页 Card 投影与能力管理页列表共用同一份读取。 */
export async function listCapabilityRows(q: Query): Promise<CapabilityRow[]> {
  const result = await q(`SELECT id, version, name, "group", description FROM capability_config ORDER BY created_at, id`);
  return result.rows as CapabilityRow[];
}

/** 能力注册表 Card：首页能力面板用它补齐尚未有 Issue 的注册分组。 */
export async function listCapabilityCards(q: Query): Promise<TCard[]> {
  return (await listCapabilityRows(q)).map((row) => {
    const payload: TCapabilityCardPayload = {
      capabilityId: row.id,
      name: row.name,
      group: row.group,
      description: row.description,
    };
    return {
      schemaVersion: 1,
      id: `capability:${row.id}`,
      version: row.version,
      kind: "capability",
      objectRef: { type: "capability", id: row.id, version: row.version },
      title: row.name,
      badge: "Capability",
      urgency: "normal",
      payload,
      // 能力没有独立页面：正面就在首页，导航回首页避免死链。
      navigation: [{ href: "/", label: "Capability" }],
      actions: [],
    };
  });
}

export type RegisterCapabilityResult =
  | { ok: true; id: string }
  | { ok: false; code: "CAPABILITY_EXISTS"; message: string };

/** CEO 注册公司能力：slug id；重复名称返回 409，不静默覆盖已有事实。 */
export async function registerCapability(
  q: Query,
  input: { name: string; group: string; description: string },
): Promise<RegisterCapabilityResult> {
  const id = slugId(input.name) || randomUUID();
  const result = await q(
    `INSERT INTO capability_config (id, version, name, "group", description)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, input.name, input.group, input.description],
  );
  if (result.rowCount !== 1) return { ok: false, code: "CAPABILITY_EXISTS", message: `能力 ${id} 已注册` };
  return { ok: true, id };
}

export type UpdateCapabilityResult =
  | { ok: true; id: string }
  | { ok: false; status: 404; code: "CAPABILITY_NOT_FOUND"; message: string }
  | { ok: false; status: 409; code: "CAPABILITY_NAME_CONFLICT"; message: string };

/** CEO 编辑能力：id 稳定，只改显示字段并 version+1；新名 slug 撞到其他行时 409。 */
export async function updateCapability(
  q: Query,
  id: string,
  input: { name?: string; group?: string; description?: string },
): Promise<UpdateCapabilityResult> {
  const nextSlug = input.name !== undefined ? slugId(input.name) || null : null;
  if (nextSlug) {
    const rows = await q("SELECT id, name FROM capability_config");
    if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
      return { ok: false, status: 409, code: "CAPABILITY_NAME_CONFLICT", message: `能力名称与已有能力冲突（${nextSlug}）` };
    }
  }
  const updated = await q(
    `UPDATE capability_config
        SET name = COALESCE($2, name), "group" = COALESCE($3, "group"), description = COALESCE($4, description),
            version = version + 1
      WHERE id = $1
        AND ($5::text IS NULL OR $5 = id OR NOT EXISTS (SELECT 1 FROM capability_config WHERE id = $5))
      RETURNING id`,
    [id, input.name ?? null, input.group ?? null, input.description ?? null, nextSlug],
  );
  if (updated.rowCount === 1) return { ok: true, id };
  const exists = await q("SELECT id FROM capability_config WHERE id = $1", [id]);
  if (exists.rowCount !== 1) return { ok: false, status: 404, code: "CAPABILITY_NOT_FOUND", message: "能力不存在" };
  return { ok: false, status: 409, code: "CAPABILITY_NAME_CONFLICT", message: `能力名称与已有能力冲突（${nextSlug}）` };
}
