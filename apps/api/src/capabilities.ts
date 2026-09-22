import { randomUUID } from "node:crypto";
import type { QueryResult } from "pg";
import type { TCapabilityCardPayload, TCapabilityManagementResponse, TCapabilitySupportRef, TCard, TMissionValue } from "@warmap/contracts";
import { hasNameSlugConflict, slugId } from "./slug.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type CapabilityRow = TCapabilityManagementResponse["capabilities"][number];

type CapabilityDbRow = {
  id: string;
  version: number;
  code: string;
  sort_order: number;
  name: string;
  group: string;
  six_month_outcome: string;
  support_refs: TCapabilitySupportRef[];
};

export type CapabilityWriteInput = {
  code: string;
  sortOrder: number;
  name: string;
  group?: string;
  sixMonthOutcome: string;
  supportRefs?: TCapabilitySupportRef[];
};

/** 能力注册表行：首页 Card 投影与能力管理页列表共用同一份读取。 */
export async function listCapabilityRows(q: Query): Promise<CapabilityRow[]> {
  const result = await q(
    `SELECT id, version, code, sort_order, name, "group", six_month_outcome, support_refs FROM capability_config ORDER BY sort_order, code, id`,
  );
  return (result.rows as CapabilityDbRow[]).map((row) => ({
    id: row.id,
    version: row.version,
    code: row.code,
    sortOrder: row.sort_order,
    name: row.name,
    group: row.group,
    sixMonthOutcome: row.six_month_outcome,
    supportRefs: row.support_refs ?? [],
  }));
}

/** 能力注册表 Card：首页能力面板用它补齐尚未有 Issue 的注册分组。 */
export async function listCapabilityCards(q: Query): Promise<TCard[]> {
  return (await listCapabilityRows(q)).map((row) => {
    const payload: TCapabilityCardPayload = {
      capabilityId: row.id,
      code: row.code,
      sortOrder: row.sortOrder,
      name: row.name,
      group: row.group,
      sixMonthOutcome: row.sixMonthOutcome,
      supportRefs: row.supportRefs,
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

export type SupportRefValidation = { ok: true } | { ok: false; code: "UNKNOWN_MISSION_CODE" | "UNKNOWN_BATTLEFIELD"; message: string };

/** 主要支撑必须命中已登记战场或该战场的 Mission code；不复制被引用对象的标题。 */
export async function validateSupportRefs(q: Query, refs: TCapabilitySupportRef[]): Promise<SupportRefValidation> {
  if (refs.length === 0) return { ok: true };
  const rows = await q("SELECT id, missions FROM battlefield_config");
  const battlefields = rows.rows as { id: string; missions: TMissionValue[] }[];
  const ids = new Set(battlefields.map((row) => row.id));
  const missionCodes = new Set(battlefields.flatMap((row) => (row.missions ?? []).map((mission) => mission.code)));
  for (const ref of refs) {
    if (ref.type === "mission" && !missionCodes.has(ref.missionCode)) {
      return { ok: false, code: "UNKNOWN_MISSION_CODE", message: `Mission ${ref.missionCode} 不存在` };
    }
    if (ref.type === "battlefield" && !ids.has(ref.battlefieldId)) {
      return { ok: false, code: "UNKNOWN_BATTLEFIELD", message: `战场 ${ref.battlefieldId} 不存在` };
    }
  }
  return { ok: true };
}

export type RegisterCapabilityResult =
  | { ok: true; id: string }
  | { ok: false; status: 409; code: "CAPABILITY_EXISTS" | "CAPABILITY_NAME_CONFLICT" | "CAPABILITY_CODE_CONFLICT"; message: string };

async function capabilityCodeTaken(q: Query, code: string, selfId: string): Promise<boolean> {
  const rows = await q("SELECT id FROM capability_config WHERE code = $1 AND id <> $2", [code, selfId]);
  return (rows.rowCount ?? 0) > 0;
}

/** CEO 注册公司能力：slug id；重复名称或重复编号返回 409，不静默覆盖已有事实。 */
export async function registerCapability(q: Query, input: CapabilityWriteInput): Promise<RegisterCapabilityResult> {
  const id = slugId(input.name) || randomUUID();
  const nextSlug = slugId(input.name) || null;
  if (nextSlug) {
    const rows = await q("SELECT id, name FROM capability_config");
    if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
      return { ok: false, status: 409, code: "CAPABILITY_NAME_CONFLICT", message: `能力名称与已有能力冲突（${nextSlug}）` };
    }
  }
  if (await capabilityCodeTaken(q, input.code, id)) {
    return { ok: false, status: 409, code: "CAPABILITY_CODE_CONFLICT", message: `能力编号 ${input.code} 已被占用` };
  }
  const result = await q(
    `INSERT INTO capability_config (id, version, code, sort_order, name, "group", six_month_outcome, support_refs)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, input.code, input.sortOrder, input.name, input.group ?? "", input.sixMonthOutcome, JSON.stringify(input.supportRefs ?? [])],
  );
  if (result.rowCount !== 1) return { ok: false, status: 409, code: "CAPABILITY_EXISTS", message: `能力 ${id} 已注册` };
  return { ok: true, id };
}

export type UpdateCapabilityResult =
  | { ok: true; id: string }
  | { ok: false; status: 404; code: "CAPABILITY_NOT_FOUND"; message: string }
  | { ok: false; status: 409; code: "CAPABILITY_NAME_CONFLICT" | "CAPABILITY_CODE_CONFLICT"; message: string };

/** CEO 编辑能力：id 稳定，只改显示字段并 version+1；新名 slug 或 code 撞到其他行时 409。 */
export async function updateCapability(
  q: Query,
  id: string,
  input: Partial<CapabilityWriteInput>,
): Promise<UpdateCapabilityResult> {
  const nextSlug = input.name !== undefined ? slugId(input.name) || null : null;
  if (nextSlug) {
    const rows = await q("SELECT id, name FROM capability_config");
    if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
      return { ok: false, status: 409, code: "CAPABILITY_NAME_CONFLICT", message: `能力名称与已有能力冲突（${nextSlug}）` };
    }
  }
  if (input.code !== undefined && (await capabilityCodeTaken(q, input.code, id))) {
    return { ok: false, status: 409, code: "CAPABILITY_CODE_CONFLICT", message: `能力编号 ${input.code} 已被占用` };
  }
  const updated = await q(
    `UPDATE capability_config
        SET code = COALESCE($2, code), sort_order = COALESCE($3, sort_order), name = COALESCE($4, name),
            "group" = COALESCE($5, "group"), six_month_outcome = COALESCE($6, six_month_outcome),
            support_refs = COALESCE($7::jsonb, support_refs),
            version = version + 1
      WHERE id = $1
        AND ($8::text IS NULL OR $8 = id OR NOT EXISTS (SELECT 1 FROM capability_config WHERE id = $8))
      RETURNING id`,
    [
      id,
      input.code ?? null,
      input.sortOrder ?? null,
      input.name ?? null,
      input.group ?? null,
      input.sixMonthOutcome ?? null,
      input.supportRefs === undefined ? null : JSON.stringify(input.supportRefs),
      nextSlug,
    ],
  );
  if (updated.rowCount === 1) return { ok: true, id };
  const exists = await q("SELECT id FROM capability_config WHERE id = $1", [id]);
  if (exists.rowCount !== 1) return { ok: false, status: 404, code: "CAPABILITY_NOT_FOUND", message: "能力不存在" };
  return { ok: false, status: 409, code: "CAPABILITY_NAME_CONFLICT", message: `能力名称与已有能力冲突（${nextSlug}）` };
}
