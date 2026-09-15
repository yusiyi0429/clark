import type { QueryResult } from "pg";
import type {
  TCard,
  TBattlefieldCardPayload,
  TBattlefieldTodo,
  TMonthlyPlanBattlefield,
  TMonthlyPlanExport,
  TMonthlyPlanFeedback,
  TMonthlyPlanTodo,
} from "@warmap/contracts";

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

/** BattlefieldConfig 是 battlefieldId 的确定性校验来源。 */
export async function getRegisteredBattlefieldIds(q: Query): Promise<Set<string>> {
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
      navigation: [{ href: `/battlefields/${battlefield.id}`, label: "Battlefield" }],
      actions: [],
    };
  });
}
