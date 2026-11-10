import type { TBudget, TTaskBudgetResponse } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { CardError } from "./taskCards.js";

/**
 * 预算（新首页设计 11.3、契约 budget.ts）：天枢只存和读，到了怎么降档、怎么停是本机程序的事（11.4）。
 * 本人的缺省在 person_settings.budget（没有 = 自动），每件 Task 单独设的在 task_budgets。
 */
export const AUTO_BUDGET: TBudget = { mode: "auto", hours: null, weeklyPercent: null, money: null };

/** 设预算至少一项上限（400）；别的模式三项清空。 */
export function normalizeBudget(budget: TBudget): TBudget {
  if (budget.mode !== "set") return { mode: budget.mode, hours: null, weeklyPercent: null, money: null };
  if (budget.hours === null && budget.weeklyPercent === null && budget.money === null)
    throw new CardError(400, "INVALID_INPUT", "设预算至少写一项：时长、本周额度或 TokenHub 金额");
  return budget;
}

export async function readBudgetDefault(q: Query, personId: string): Promise<TBudget> {
  return ((await q("SELECT budget FROM person_settings WHERE person_id=$1", [personId])).rows[0]?.budget as TBudget | null | undefined) ?? AUTO_BUDGET;
}

export async function writeBudgetDefault(q: Query, personId: string, budget: TBudget): Promise<TBudget> {
  const saved = normalizeBudget(budget);
  await q("INSERT INTO person_settings(person_id,budget) VALUES($1,$2::jsonb) ON CONFLICT (person_id) DO UPDATE SET budget=EXCLUDED.budget",
    [personId, JSON.stringify(saved)]);
  return saved;
}

/** 这件 Task 的预算；没单独设过用本人的缺省（inherited）。调用方先核对本人是负责人。 */
export async function readTaskBudget(q: Query, ownerId: string, taskId: string): Promise<TTaskBudgetResponse> {
  const own = (await q("SELECT budget FROM task_budgets WHERE owner_id=$1 AND plan_task_id=$2", [ownerId, taskId])).rows[0]?.budget as TBudget | undefined;
  return own ? { taskId, budget: own, inherited: false } : { taskId, budget: await readBudgetDefault(q, ownerId), inherited: true };
}

export async function writeTaskBudget(q: Query, ownerId: string, taskId: string, budget: TBudget, now: Date): Promise<TTaskBudgetResponse> {
  const saved = normalizeBudget(budget);
  await q(`INSERT INTO task_budgets(owner_id,plan_task_id,budget,updated_at) VALUES($1,$2,$3::jsonb,$4)
    ON CONFLICT (owner_id,plan_task_id) DO UPDATE SET budget=EXCLUDED.budget,updated_at=EXCLUDED.updated_at`, [ownerId, taskId, JSON.stringify(saved), now]);
  return { taskId, budget: saved, inherited: false };
}
