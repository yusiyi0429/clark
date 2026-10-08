import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import type {
  TCard,
  TBattlefieldCardPayload,
  TBattlefieldManagementResponse,
  TBattlefieldTodo,
  TCapabilitySupportRef,
  TIssueLocation,
  TMissionAnchor,
  TMonthlyPlanBattlefield,
  TMonthlyPlanExport,
  TMonthlyPlanFeedback,
  TMonthlyPlanTodo,
  TRadarAnchor,
} from "@warmap/contracts";
import { hasNameSlugConflict, slugId } from "./slug.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type BattlefieldRow = {
  id: string;
  version: number;
  code: string;
  sort_order: number;
  name: string;
  owner_id: string;
  participant_ids: string[] | null;
  six_month_outcome: string;
  missionAnchors: TMissionAnchor[];
};

/** 已签发计划的最小结构：战场投影只读这一份持久对象，不保存第二份目标。 */
type ConfirmedPlanRow = {
  version: number;
  period: string;
  company_outcome: string;
  battlefields: TMonthlyPlanBattlefield[];
  todos: TMonthlyPlanTodo[];
  negotiation: { feedback: TMonthlyPlanFeedback[] };
  exports: TMonthlyPlanExport[];
};

export async function listBattlefieldRows(q: Query): Promise<BattlefieldRow[]> {
  const result = await q(
    "SELECT id, version, code, sort_order, name, owner_id, participant_ids, six_month_outcome, mission_anchors AS \"missionAnchors\" FROM battlefield_config ORDER BY sort_order, code, id",
  );
  return result.rows as BattlefieldRow[];
}

/** 已注册的战场 id 集合；BattlefieldConfig 是 battlefieldId 的确定性校验来源。 */export async function getRegisteredBattlefieldIds(q: Query): Promise<Set<string>> {
  const result = await q("SELECT id FROM battlefield_config");
  return new Set(result.rows.map((row) => (row as { id: string }).id));
}

/** 返回第一个未注册的 battlefieldId；undefined 表示全部合法。 */
export function findUnregisteredBattlefieldId(
  registered: Set<string>,
  battlefieldIds: (string | undefined)[],
): string | undefined {
  return battlefieldIds.find((id): id is string => id !== undefined && !registered.has(id));
}

/** 议题的战场归属是一个集合：capability 级主归属是能力，不参与战场集合（返回 null）。 */
export function battlefieldSetOf(location: TIssueLocation): string[] | null {
  if (location.level === "capability") return null;
  return location.level === "battlefield" ? [location.battlefieldId] : [...location.relatedBattlefieldIds];
}

/** 方案 A 归一化：0 个 = 未归属，1 个 = battlefield 级，≥2 个 = 排序去重的 company 级。 */
export function normalizeBattlefieldSet(ids: string[]): TIssueLocation {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return { level: "company", relatedBattlefieldIds: [] };
  if (unique.length === 1) return { level: "battlefield", battlefieldId: unique[0] };
  return { level: "company", relatedBattlefieldIds: unique };
}

export type DeleteBattlefieldResult =
  | { ok: true; detachedIssues: number }
  | { ok: false; status: 404; code: "BATTLEFIELD_NOT_FOUND"; message: string }
  | { ok: false; status: 409; code: "BATTLEFIELD_HAS_MISSION_ROUNDS"; message: string };

/**
 * 删除战场：单事务内把所有受影响议题移出该战场并归一化，清掉能力里指向该战场及其战略锚点的 supportRefs，再删注册行。
 * radar_config.anchors 只删指向该战场的 ontology anchor（不重建，与月度计划签发时的重建逻辑对称）；
 * 月度计划是自包含 JSONB 快照，不回改。
 */
export async function deleteBattlefield(pool: Pool, id: string): Promise<DeleteBattlefieldResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ id: string; missionAnchors: TMissionAnchor[] }>(
      "SELECT id, mission_anchors AS \"missionAnchors\" FROM battlefield_config WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, code: "BATTLEFIELD_NOT_FOUND", message: "战场不存在" };
    }
    const rounds = await client.query("SELECT id FROM mission_rounds WHERE battlefield_id = $1 LIMIT 1", [id]);
    if (rounds.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, code: "BATTLEFIELD_HAS_MISSION_ROUNDS", message: "战场已有 Mission Card 轮次，不能删除" };
    }
    // 受影响议题：battlefield 级正好是该战场，或 company 集合包含该战场（capability 级主归属是能力，不参与）
    const affected = await client.query<{ id: string; location: TIssueLocation }>(
      `SELECT id, location FROM issues
        WHERE (location->>'level' = 'battlefield' AND location->>'battlefieldId' = $1)
           OR (location->>'level' = 'company' AND location->'relatedBattlefieldIds' @> $2::jsonb)
        FOR UPDATE`,
      [id, JSON.stringify([id])],
    );
    for (const row of affected.rows) {
      const remaining = (battlefieldSetOf(row.location) ?? []).filter((candidate) => candidate !== id);
      await client.query(
        "UPDATE issues SET location = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1",
        [row.id, JSON.stringify(normalizeBattlefieldSet(remaining))],
      );
    }
    // 能力 supportRefs 只能指向已登记战场与战略锚点：同一事务内清掉指向该战场及其锚点 code 的 ref，只有真正被改的能力 version+1
    const missionCodes = new Set((locked.rows[0].missionAnchors ?? []).map((mission) => mission.code));
    const capabilities = await client.query<{ id: string; support_refs: TCapabilitySupportRef[] }>(
      "SELECT id, support_refs FROM capability_config FOR UPDATE",
    );
    for (const row of capabilities.rows) {
      const refs = row.support_refs ?? [];
      const kept = refs.filter(
        (ref) =>
          !(ref.type === "battlefield" && ref.battlefieldId === id) && !(ref.type === "mission-anchor" && missionCodes.has(ref.missionCode)),
      );
      if (kept.length !== refs.length) {
        await client.query(
          "UPDATE capability_config SET support_refs = $2::jsonb, version = version + 1 WHERE id = $1",
          [row.id, JSON.stringify(kept)],
        );
      }
    }
    // Mission 的 battlefieldIds 必须归一化：同一事务移除该战场，只对受影响 Mission version+1
    const missions = await client.query<{ id: string; battlefield_ids: string[] }>(
      "SELECT id, battlefield_ids FROM missions WHERE battlefield_ids @> $1::jsonb FOR UPDATE",
      [JSON.stringify([id])],
    );
    for (const row of missions.rows) {
      const kept = (row.battlefield_ids ?? []).filter((candidate) => candidate !== id);
      await client.query("UPDATE missions SET battlefield_ids = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1", [
        row.id,
        JSON.stringify(kept),
      ]);
    }
    await client.query("DELETE FROM battlefield_config WHERE id = $1", [id]);
    const config = await client.query<{ anchors: TRadarAnchor[] }>("SELECT anchors FROM radar_config WHERE id = 'default' FOR UPDATE");
    if (config.rowCount === 1) {
      const anchors = config.rows[0].anchors ?? [];
      const kept = anchors.filter((anchor) => !(anchor.source === "ontology" && anchor.location.type === "battlefield" && anchor.location.id === id));
      if (kept.length !== anchors.length) {
        await client.query("UPDATE radar_config SET anchors = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 'default'", [JSON.stringify(kept)]);
      }
    }
    await client.query("COMMIT");
    return { ok: true, detachedIssues: affected.rows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type RegisterBattlefieldResult =
  | { ok: true; id: string }
  | { ok: false; status: 409; code: "BATTLEFIELD_EXISTS" | "BATTLEFIELD_NAME_CONFLICT" | "BATTLEFIELD_CODE_CONFLICT" | "MISSION_ANCHOR_CODE_CONFLICT"; message: string };

export type BattlefieldWriteInput = {
  code: string;
  sortOrder: number;
  name: string;
  ownerId?: string;
  sixMonthOutcome: string;
  missionAnchors?: TMissionAnchor[];
  /** 签发后起草任务卡的名单；只在编辑时写入，没存过时按上月 Mission 推算。 */
  participantIds?: string[];
};

/** code 非空时同表唯一；空 code 是迁移期未编号的旧行，不参与冲突。 */
async function battlefieldCodeTaken(q: Query, code: string, selfId: string): Promise<boolean> {
  const rows = await q("SELECT id FROM battlefield_config WHERE code = $1 AND id <> $2", [code, selfId]);
  return (rows.rowCount ?? 0) > 0;
}

/** 战略锚点 code 全表唯一：同一次 payload 内重复与跨战场重复都算冲突，返回第一个冲突 code。 */
async function missionAnchorCodeConflict(q: Query, missionAnchors: TMissionAnchor[], selfId: string): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const mission of missionAnchors) {
    if (seen.has(mission.code)) return mission.code;
    seen.add(mission.code);
  }
  if (seen.size === 0) return undefined;
  const rows = await q("SELECT mission_anchors AS \"missionAnchors\" FROM battlefield_config WHERE id <> $1", [selfId]);
  for (const row of rows.rows as { missionAnchors: TMissionAnchor[] }[]) {
    for (const mission of row.missionAnchors ?? []) {
      if (seen.has(mission.code)) return mission.code;
    }
  }
  return undefined;
}

/** 清掉能力里指向这些战略锚点 code 的 supportRefs，只有真正被改的能力 version+1。 */
async function dropMissionAnchorSupportRefs(q: Query, missionCodes: Set<string>): Promise<void> {
  if (missionCodes.size === 0) return;
  const capabilities = await q("SELECT id, support_refs FROM capability_config FOR UPDATE");
  for (const row of capabilities.rows as { id: string; support_refs: TCapabilitySupportRef[] }[]) {
    const refs = row.support_refs ?? [];
    const kept = refs.filter((ref) => !(ref.type === "mission-anchor" && missionCodes.has(ref.missionCode)));
    if (kept.length !== refs.length) {
      await q("UPDATE capability_config SET support_refs = $2::jsonb, version = version + 1 WHERE id = $1", [
        row.id,
        JSON.stringify(kept),
      ]);
    }
  }
}

/** CEO 注册战场：显示编号与排序独立于名称；同 slug 显示名或同 code 返回 409。 */
export async function registerBattlefield(q: Query, input: BattlefieldWriteInput): Promise<RegisterBattlefieldResult> {
  const id = slugId(input.name) || randomUUID();
  const nextSlug = slugId(input.name) || null;
  if (nextSlug) {
    const rows = await q("SELECT id, name FROM battlefield_config");
    if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
      return { ok: false, status: 409, code: "BATTLEFIELD_NAME_CONFLICT", message: `战场名称与已有战场冲突（${nextSlug}）` };
    }
  }
  if (await battlefieldCodeTaken(q, input.code, id)) {
    return { ok: false, status: 409, code: "BATTLEFIELD_CODE_CONFLICT", message: `战场编号 ${input.code} 已被占用` };
  }
  const missionConflict = await missionAnchorCodeConflict(q, input.missionAnchors ?? [], id);
  if (missionConflict) {
    return { ok: false, status: 409, code: "MISSION_ANCHOR_CODE_CONFLICT", message: `战略锚点编号 ${missionConflict} 已被占用` };
  }
  const result = await q(
    `INSERT INTO battlefield_config (id, version, code, sort_order, name, owner_id, six_month_outcome, mission_anchors)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, input.code, input.sortOrder, input.name, input.ownerId ?? "", input.sixMonthOutcome, JSON.stringify(input.missionAnchors ?? [])],
  );
  if (result.rowCount !== 1) return { ok: false, status: 409, code: "BATTLEFIELD_EXISTS", message: `战场 ${id} 已注册` };
  return { ok: true, id };
}

export type UpdateBattlefieldResult =
  | { ok: true; id: string }
  | { ok: false; status: 404; code: "BATTLEFIELD_NOT_FOUND"; message: string }
  | { ok: false; status: 409; code: "BATTLEFIELD_NAME_CONFLICT" | "BATTLEFIELD_CODE_CONFLICT" | "MISSION_ANCHOR_CODE_CONFLICT"; message: string };

/**
 * CEO 编辑战场：id 稳定，只改显示字段并 version+1；新名 slug、code 或战略锚点 code 撞到其他行时 409。
 * 一次事务内完成战场更新与旧战略锚点 code 的 supportRefs 清理，避免悬空引用。
 */
export async function updateBattlefield(
  pool: Pool,
  id: string,
  input: Partial<BattlefieldWriteInput>,
): Promise<UpdateBattlefieldResult> {
  const client = await pool.connect();
  try {
    const q: Query = (sql, params) => client.query(sql, params);
    await client.query("BEGIN");
    const locked = await client.query<{ id: string; missionAnchors: TMissionAnchor[] }>(
      "SELECT id, mission_anchors AS \"missionAnchors\" FROM battlefield_config WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, code: "BATTLEFIELD_NOT_FOUND", message: "战场不存在" };
    }
    const nextSlug = input.name !== undefined ? slugId(input.name) || null : null;
    if (nextSlug) {
      const rows = await client.query("SELECT id, name FROM battlefield_config");
      if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
        await client.query("ROLLBACK");
        return { ok: false, status: 409, code: "BATTLEFIELD_NAME_CONFLICT", message: `战场名称与已有战场冲突（${nextSlug}）` };
      }
    }
    if (input.code !== undefined && (await battlefieldCodeTaken(q, input.code, id))) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, code: "BATTLEFIELD_CODE_CONFLICT", message: `战场编号 ${input.code} 已被占用` };
    }
    if (input.missionAnchors !== undefined) {
      const missionConflict = await missionAnchorCodeConflict(q, input.missionAnchors, id);
      if (missionConflict) {
        await client.query("ROLLBACK");
        return { ok: false, status: 409, code: "MISSION_ANCHOR_CODE_CONFLICT", message: `战略锚点编号 ${missionConflict} 已被占用` };
      }
    }
    const updated = await client.query(
      `UPDATE battlefield_config
          SET code = COALESCE($2, code), sort_order = COALESCE($3, sort_order), name = COALESCE($4, name),
              owner_id = COALESCE($5, owner_id), six_month_outcome = COALESCE($6, six_month_outcome),
              mission_anchors = COALESCE($7::jsonb, mission_anchors),
              participant_ids = COALESCE($9::jsonb, participant_ids),
              version = version + 1, updated_at = now()
        WHERE id = $1
          AND ($8::text IS NULL OR $8 = id OR NOT EXISTS (SELECT 1 FROM battlefield_config WHERE id = $8))
        RETURNING id`,
      [
        id,
        input.code ?? null,
        input.sortOrder ?? null,
        input.name ?? null,
        input.ownerId ?? null,
        input.sixMonthOutcome ?? null,
        input.missionAnchors === undefined ? null : JSON.stringify(input.missionAnchors),
        nextSlug,
        input.participantIds === undefined ? null : JSON.stringify(input.participantIds),
      ],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, status: 409, code: "BATTLEFIELD_NAME_CONFLICT", message: `战场名称与已有战场冲突（${nextSlug}）` };
    }
    // 删除或改名旧战略锚点：同事务清掉指向这些 code 的 supportRefs，受影响能力 version+1
    if (input.missionAnchors !== undefined) {
      const nextCodes = new Set(input.missionAnchors.map((mission) => mission.code));
      const removed = new Set((locked.rows[0].missionAnchors ?? []).map((mission) => mission.code).filter((code) => !nextCodes.has(code)));
      await dropMissionAnchorSupportRefs(q, removed);
    }
    await client.query("COMMIT");
    return { ok: true, id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 战场管理页投影：一次返回战场列表与可选议题。
 * 议题只取 pending 且非 capability 级；battlefieldIds 即归一化集合，未归属为空数组，
 * 因此同一议题可以同时出现在多个战场的关联列表里。参与者名单由调用方按起草规则给出。
 */
export async function projectBattlefieldManagement(q: Query, ownerNames: Map<string, string>,
  participantsOf: (battlefieldId: string) => Promise<{ personIds: string[]; derived: boolean }>): Promise<TBattlefieldManagementResponse> {
  const battlefields = await q(
    "SELECT id, version, code, sort_order, name, owner_id, six_month_outcome, mission_anchors AS \"missionAnchors\" FROM battlefield_config ORDER BY sort_order, code, id",
  );
  const issues = await q(
    `SELECT id, title, urgency, location FROM issues
      WHERE status = 'pending' AND location->>'level' <> 'capability'
      ORDER BY created_at DESC, id`,
  );
  const pending = (issues.rows as { id: string; title: string; urgency: { level: string; decisionBy?: string }; location: TIssueLocation }[]).map((row) => ({
    id: row.id,
    title: row.title,
    urgencyLevel: row.urgency.level as TBattlefieldManagementResponse["issues"][number]["urgencyLevel"],
    ...(row.urgency.decisionBy ? { decisionBy: row.urgency.decisionBy } : {}),
    battlefieldIds: battlefieldSetOf(row.location) ?? [],
  }));
  const participants = new Map(await Promise.all((battlefields.rows as BattlefieldRow[]).map(async (row) => [row.id, await participantsOf(row.id)] as const)));
  return {
    battlefields: (battlefields.rows as BattlefieldRow[]).map((row) => ({
      id: row.id,
      version: row.version,
      code: row.code,
      sortOrder: row.sort_order,
      name: row.name,
      ownerId: row.owner_id,
      ownerDisplayName: ownerNames.get(row.owner_id) ?? "",
      sixMonthOutcome: row.six_month_outcome,
      missionAnchors: row.missionAnchors ?? [],
      pendingIssueCount: pending.filter((issue) => issue.battlefieldIds.includes(row.id)).length,
      participantIds: participants.get(row.id)!.personIds,
      participantsDerived: participants.get(row.id)!.derived,
    })),
    issues: pending,
  };
}

/** 依据每个待办/feedback 自己的 battlefieldId 归属；空值表示公司级，不能通过 owner 反推。 */
function belongsTo(feedback: TMonthlyPlanFeedback, battlefieldId: string, todoIds: Set<string>): boolean {
  if (feedback.battlefieldId === battlefieldId) return true;
  return feedback.todoId !== undefined && todoIds.has(feedback.todoId);
}

/** 归属本战场的反馈，按 observedAt 倒序；第一条就是卡片背面的「最新反馈」。 */
function battlefieldFeedback(
  feedback: TMonthlyPlanFeedback[],
  battlefieldId: string,
  todoIds: Set<string>,
): TBattlefieldCardPayload["feedback"] {
  return feedback
    .filter((candidate) => belongsTo(candidate, battlefieldId, todoIds))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .map((item) => ({
      text: item.text,
      observedAt: item.observedAt,
      sourceRef: item.sourceRef,
      evidenceRef: item.evidenceRef ?? null,
    }));
}

/**
 * 战场 Card：正面读当前公司月已签发计划的目标，背面按时段内 todo/feedback 的 battlefieldId 投影。
 * 不计算百分比、健康分，也没有 BattlefieldProgress 对象。
 */
export async function listBattlefieldCards(q: Query, period: string, ownerNames: Map<string, string>): Promise<TCard[]> {
  const battlefields = await listBattlefieldRows(q);
  const planResult = await q(
    `SELECT version, period, company_outcome, battlefields, todos, negotiation, exports
       FROM monthly_plans WHERE status = 'confirmed' AND period = $1`,
    [period],
  );
  const plan = planResult.rowCount === 1 ? (planResult.rows[0] as ConfirmedPlanRow) : null;
  const issues = await q(
    `SELECT id, title, urgency->>'level' AS urgency, location
       FROM issues
      WHERE status = 'pending' AND location->>'level' = 'battlefield'
      ORDER BY created_at DESC, id`,
  );

  return battlefields.map((battlefield) => {
    const planTodos = (plan?.todos ?? []).filter((todo) => todo.battlefieldId === battlefield.id);
    const todoIds = new Set(planTodos.map((todo) => todo.id));
    const exportByTodo = new Map((plan?.exports ?? []).map((item) => [item.todoId, item]));
    const todos: TBattlefieldTodo[] = planTodos.map((todo) => {
      const exported = exportByTodo.get(todo.id);
      return {
        id: todo.id,
        title: todo.title,
        ownerId: todo.ownerId,
        dueAt: todo.dueAt ?? null,
        sourceRef: todo.sourceRef,
        exportStatus: exported?.status ?? null,
        exportRef: exported?.exportRef ?? null,
      };
    });
    const target = plan?.battlefields.find((candidate) => candidate.battlefieldId === battlefield.id)?.outcome ?? null;
    const feedback = battlefieldFeedback(plan?.negotiation.feedback ?? [], battlefield.id, todoIds);
    const payload: TBattlefieldCardPayload = {
      battlefieldId: battlefield.id,
      code: battlefield.code,
      sortOrder: battlefield.sort_order,
      name: battlefield.name,
      ownerId: battlefield.owner_id,
      ownerDisplayName: ownerNames.get(battlefield.owner_id) ?? "",
      sixMonthOutcome: battlefield.six_month_outcome,
      missionAnchors: battlefield.missionAnchors ?? [],
      period: plan?.period ?? null,
      target,
      pendingIssues: (issues.rows as { id: string; title: string; urgency: string; location: unknown }[])
        .filter((issue) => (issue.location as { battlefieldId?: string }).battlefieldId === battlefield.id)
        .map((issue) => ({
          id: issue.id,
          title: issue.title,
          urgency: issue.urgency as TBattlefieldCardPayload["pendingIssues"][number]["urgency"],
          location: issue.location as TBattlefieldCardPayload["pendingIssues"][number]["location"],
        })),
      todos,
      latestFeedback: feedback[0] ?? null,
      feedback,
    };
    return {
      schemaVersion: 1,
      id: `battlefield:${battlefield.id}`,
      version: plan?.version ?? battlefield.version,
      kind: "battlefield",
      objectRef: { type: "battlefield", id: battlefield.id, version: plan?.version ?? battlefield.version },
      title: battlefield.name,
      badge: "Battlefield",
      urgency: "normal",
      payload,
      // 战场二级页：待决策 / 进展两个页签（id 可能是中文，按路径段编码）。
      navigation: [{ href: `/battlefields/${encodeURIComponent(battlefield.id)}`, label: "Battlefield" }],
      actions: [],
    };
  });
}
