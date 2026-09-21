import { randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import type { TCapabilityCardPayload, TCard } from "@warmap/contracts";
import { slugId } from "./slug.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** 能力注册表 Card：首页能力面板用它补齐尚未有 Issue 的注册分组。 */
export async function listCapabilityCards(q: Query): Promise<TCard[]> {
  const result = await q(`SELECT id, version, name, "group", description FROM capability_config ORDER BY created_at, id`);
  return result.rows.map((raw) => {
    const row = raw as { id: string; version: number; name: string; group: string; description: string };
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
