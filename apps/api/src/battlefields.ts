import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import type {
  TCard,
  TBattlefieldCardPayload,
  TBattlefieldManagementResponse,
  TBattlefieldTodo,
  TIssueLocation,
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
  name: string;
  positioning: string;
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
  const result = await q("SELECT id, version, name, positioning FROM battlefield_config ORDER BY id");
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
  | { ok: false; status: 404; code: "BATTLEFIELD_NOT_FOUND"; message: string };

/**
 * 删除战场：单事务内把所有受影响议题移出该战场并归一化，再删注册行。
 * radar_config.anchors 只删指向该战场的 ontology anchor（不重建，与月度计划签发时的重建逻辑对称）；
 * 月度计划是自包含 JSONB 快照，不回改。
 */
export async function deleteBattlefield(pool: Pool, id: string): Promise<DeleteBattlefieldResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT id FROM battlefield_config WHERE id = $1 FOR UPDATE", [id]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, code: "BATTLEFIELD_NOT_FOUND", message: "战场不存在" };
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
  | { ok: false; code: "BATTLEFIELD_EXISTS"; message: string };

/** CEO 注册战场：goal 写入既有 positioning，owner 是 migration 018 新增列；同 slug 名称返回 409。 */
export async function registerBattlefield(
  q: Query,
  input: { name: string; owner: string; goal: string },
): Promise<RegisterBattlefieldResult> {
  const id = slugId(input.name) || randomUUID();
  const result = await q(
    `INSERT INTO battlefield_config (id, version, name, positioning, owner)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, input.name, input.goal, input.owner],
  );
  if (result.rowCount !== 1) return { ok: false, code: "BATTLEFIELD_EXISTS", message: `战场 ${id} 已注册` };
  return { ok: true, id };
}

export type UpdateBattlefieldResult =
  | { ok: true; id: string }
  | { ok: false; status: 404; code: "BATTLEFIELD_NOT_FOUND"; message: string }
  | { ok: false; status: 409; code: "BATTLEFIELD_NAME_CONFLICT"; message: string };

/** CEO 编辑战场：id 稳定，只改显示字段并 version+1；新名 slug 撞到其他行的 id 或显示名时 409。 */
export async function updateBattlefield(
  q: Query,
  id: string,
  input: { name?: string; owner?: string; goal?: string },
): Promise<UpdateBattlefieldResult> {
  const nextSlug = input.name !== undefined ? slugId(input.name) || null : null;
  if (nextSlug) {
    const rows = await q("SELECT id, name FROM battlefield_config");
    if (hasNameSlugConflict(rows.rows as { id: string; name: string }[], id, nextSlug)) {
      return { ok: false, status: 409, code: "BATTLEFIELD_NAME_CONFLICT", message: `战场名称与已有战场冲突（${nextSlug}）` };
    }
  }
  const updated = await q(
    `UPDATE battlefield_config
        SET name = COALESCE($2, name), owner = COALESCE($3, owner), positioning = COALESCE($4, positioning),
            version = version + 1, updated_at = now()
      WHERE id = $1
        AND ($5::text IS NULL OR $5 = id OR NOT EXISTS (SELECT 1 FROM battlefield_config WHERE id = $5))
      RETURNING id`,
    [id, input.name ?? null, input.owner ?? null, input.goal ?? null, nextSlug],
  );
  if (updated.rowCount === 1) return { ok: true, id };
  const exists = await q("SELECT id FROM battlefield_config WHERE id = $1", [id]);
  if (exists.rowCount !== 1) return { ok: false, status: 404, code: "BATTLEFIELD_NOT_FOUND", message: "战场不存在" };
  return { ok: false, status: 409, code: "BATTLEFIELD_NAME_CONFLICT", message: `战场名称与已有战场冲突（${nextSlug}）` };
}

/**
 * 战场管理页投影：一次返回战场列表与可选议题。
 * 议题只取 pending 且非 capability 级；battlefieldIds 即归一化集合，未归属为空数组，
 * 因此同一议题可以同时出现在多个战场的关联列表里。
 */
export async function projectBattlefieldManagement(q: Query): Promise<TBattlefieldManagementResponse> {
  const battlefields = await q("SELECT id, name, owner, positioning FROM battlefield_config ORDER BY name, id");
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
  return {
    battlefields: (battlefields.rows as { id: string; name: string; owner: string; positioning: string }[]).map((row) => ({
      id: row.id,
      name: row.name,
      owner: row.owner,
      goal: row.positioning,
      pendingIssueCount: pending.filter((issue) => issue.battlefieldIds.includes(row.id)).length,
    })),
    issues: pending,
  };
}

/** 依据每个待办/feedback 自己的 battlefieldId 归属；空值表示公司级，不能通过 owner 反推。 */
function belongsTo(feedback: TMonthlyPlanFeedback, battlefieldId: string, todoIds: Set<string>): boolean {
  if (feedback.battlefieldId === battlefieldId) return true;
  return feedback.todoId !== undefined && todoIds.has(feedback.todoId);
}

function latestFeedback(
  feedback: TMonthlyPlanFeedback[],
  battlefieldId: string,
  todoIds: Set<string>,
): TBattlefieldCardPayload["latestFeedback"] {
  const matches = feedback
    .filter((candidate) => belongsTo(candidate, battlefieldId, todoIds))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const latest = matches[0];
  if (!latest) return null;
  return {
    text: latest.text,
    observedAt: latest.observedAt,
    sourceRef: latest.sourceRef,
    evidenceRef: latest.evidenceRef ?? null,
  };
}

/**
 * 战场 Card：正面读当前公司月已签发计划的目标，背面按时段内 todo/feedback 的 battlefieldId 投影。
 * 不计算百分比、健康分，也没有 BattlefieldProgress 对象。
 */
export async function listBattlefieldCards(q: Query, period: string): Promise<TCard[]> {
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
    const payload: TBattlefieldCardPayload = {
      battlefieldId: battlefield.id,
      name: battlefield.name,
      positioning: battlefield.positioning,
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
      latestFeedback: latestFeedback(plan?.negotiation.feedback ?? [], battlefield.id, todoIds),
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
      // 战场没有独立页面：正面就在首页，导航回首页避免死链。
      navigation: [{ href: "/", label: "Battlefield" }],
      actions: [],
    };
  });
}
