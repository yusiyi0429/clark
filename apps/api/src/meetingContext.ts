import { companyPeriod } from "./monthlyPlans.js";
import type { Query } from "./meetingStore.js";
import { taskStandards } from "./tasks.js";
import { visibleMissions } from "./visibleMissions.js";
import type { WorldSnapshot } from "./worldReader.js";

/**
 * 会后解读与影响分析用的公司地图（只读）：
 * - 长期：公司长期 outcome（LTCO）、各战场长期目标（六个月 outcome）、本体里的长期目标（LTO）与本期目标；
 * - 本月：本月计划的公司 outcome 与各战场 outcome；
 * - 每个人：看得见的 Mission（visibleMissions：本月的，本月没有时退回这个人最近一个月的，加之前月份还有没了结 Task 的；带月份、outcome、时间边界）。
 *   影响分析另带每个人手上还没完成的 Task 和验收项。
 * 这些字段本身不多，全部带上（议题 3 第五轮：会上可能讨论长期方向的调整）。
 */
export type InterpretationContext = {
  period: string;
  company: { longTermOutcome: string | null; monthOutcome: string | null };
  battlefields: { id: string; name: string; ownerName: string; longTermOutcome: string | null; monthOutcome: string | null }[];
  /** 本体里的目标（读到才有）：每个责任单元的 LTO 与本期目标。 */
  worldGoals: { unit: string; lto: string | null; periodGoals: { title: string; outcome: string | null }[] }[];
  people: { personId: string; name: string; missions: { id: string; code: string; period: string; title: string; outcome: string; timeBoundary: string }[] }[];
};

export type ImpactCandidateTask = {
  id: string; title: string; status: string; dueDate: string | null; missionCode: string | null;
  /** 完成标准逐条（验收项），index 从 0 数。 */
  acceptance: string[];
};
export type ImpactCandidate = InterpretationContext["people"][number] & { tasks: ImpactCandidateTask[] };

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").trim();
  return value ? (value.length > max ? `${value.slice(0, max)}…` : value) : null;
};

export async function meetingInterpretationContext(q: Query, now: Date, names: Map<string, string>, world?: WorldSnapshot | null): Promise<InterpretationContext> {
  const period = companyPeriod(now);
  const [strategy, plan, battlefields, visible] = await Promise.all([
    q("SELECT ltco FROM company_strategy_config WHERE id = 'default'"),
    q("SELECT company_outcome, battlefields FROM monthly_plans WHERE period = $1 ORDER BY version DESC LIMIT 1", [period]),
    q("SELECT id, name, owner_id, six_month_outcome FROM battlefield_config ORDER BY sort_order, id"),
    visibleMissions(q, now),
  ]);
  const missions = await q(`SELECT id, code, period, title, owner_id, outcome, time_boundary FROM missions WHERE id = ANY($1::text[])
    ORDER BY owner_id, period DESC, code`, [visible.map((mission) => mission.id)]);
  const planRow = plan.rows[0] as { company_outcome: string; battlefields: { battlefieldId: string; outcome: string }[] } | undefined;
  const monthOutcome = new Map((planRow?.battlefields ?? []).map((item) => [item.battlefieldId, item.outcome]));
  const people = new Map<string, InterpretationContext["people"][number]>();
  for (const row of missions.rows as { id: string; code: string; period: string; title: string; owner_id: string; outcome: string; time_boundary: string }[]) {
    const person = people.get(row.owner_id) ?? { personId: row.owner_id, name: names.get(row.owner_id) ?? row.owner_id, missions: [] };
    person.missions.push({ id: row.id, code: row.code, period: row.period, title: row.title, outcome: clip(row.outcome, 400) ?? "", timeBoundary: clip(row.time_boundary, 120) ?? "" });
    people.set(row.owner_id, person);
  }
  return {
    period,
    company: { longTermOutcome: clip((strategy.rows[0] as { ltco?: string } | undefined)?.ltco, 1200), monthOutcome: clip(planRow?.company_outcome, 800) },
    battlefields: (battlefields.rows as { id: string; name: string; owner_id: string; six_month_outcome: string }[]).map((row) => ({
      id: row.id, name: row.name, ownerName: names.get(row.owner_id) ?? row.owner_id,
      longTermOutcome: clip(row.six_month_outcome, 600), monthOutcome: clip(monthOutcome.get(row.id), 600),
    })),
    worldGoals: (world?.units ?? []).map((unit) => ({
      unit: unit.unit.title,
      lto: clip(unit.lto?.outcome ?? unit.lto?.title, 600),
      periodGoals: unit.periodGoals.map((goal) => ({ title: goal.title, outcome: clip(goal.outcome, 400) })),
    })),
    people: [...people.values()],
  };
}

/**
 * 影响分析的候选人：每个人的本月 Mission，加上手上还没完成的 Task（截止日、验收项）。
 * 只列有 Mission 或有未完成 Task 的人；每人最多 15 个 Task（最近更新的优先）。
 */
export async function impactCandidates(q: Query, context: InterpretationContext, names: Map<string, string>): Promise<ImpactCandidate[]> {
  const tasks = await q(
    `SELECT t.id::text, t.title, t.status, t.due_date::text AS due_date, t.done_definition, t.owner_id, m.code AS mission_code
       FROM tasks t LEFT JOIN missions m ON m.id = t.mission_id
      WHERE t.status IN ('not_started', 'in_progress', 'returned')
      ORDER BY t.owner_id, t.updated_at DESC`,
  );
  const byPerson = new Map<string, ImpactCandidate>(context.people.map((person) => [person.personId, { ...person, tasks: [] }]));
  for (const row of tasks.rows as { id: string; title: string; status: string; due_date: string | null; done_definition: string | null; owner_id: string; mission_code: string | null }[]) {
    const person = byPerson.get(row.owner_id) ?? { personId: row.owner_id, name: names.get(row.owner_id) ?? row.owner_id, missions: [], tasks: [] };
    if (person.tasks.length >= 15) continue;
    person.tasks.push({ id: row.id, title: row.title, status: row.status, dueDate: row.due_date, missionCode: row.mission_code,
      acceptance: taskStandards(row.done_definition).slice(0, 10).map((line) => clip(line, 200)!) });
    byPerson.set(row.owner_id, person);
  }
  return [...byPerson.values()].filter((person) => names.has(person.personId));
}
