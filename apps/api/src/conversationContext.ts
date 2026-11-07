import type { QueryResult } from "pg";
import { companyPeriod } from "./monthlyPlans.js";
import { listBattlefieldRows } from "./battlefields.js";
import { listCapabilityRows } from "./capabilities.js";
import { listMissionRows, type MissionRow } from "./missions.js";
import { issueOriginFields } from "./dataOrigin.js";
import { visibleMissions } from "./visibleMissions.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type MissionConversationSummary = Pick<MissionRow, "id" | "code" | "period" | "title" | "owner_id" | "capability_id" | "capability_code" | "capability_name" | "battlefield_ids" | "battlefield_names" | "outcome">;

function missionSummary(row: MissionRow): MissionConversationSummary {
  const { id, code, period, title, owner_id, capability_id, capability_code, capability_name, battlefield_ids, battlefield_names, outcome } = row;
  return { id, code, period, title, owner_id, capability_id, capability_code, capability_name, battlefield_ids, battlefield_names, outcome };
}

/**
 * 首页对话的有界实时业务摘要；详细 Mission 由 list_missions 工具按需读取。
 * Mission 数是本月的，加 visibleMissions 里别的月份的（本月没有时退回各人最近一个月的、之前月份还有没了结 Task 的）；
 * missionPeriods 是这些 Mission 在哪几个月，伙伴按它给 list_missions 传 period。
 */
export async function globalConversationContext(q: Query, now: Date, names: Map<string, string> = new Map()): Promise<Record<string, unknown>> {
  const period = companyPeriod(now);
  const [battlefields, capabilities, missions, issues, plan, meetings, strategy] = await Promise.all([
    listBattlefieldRows(q),
    listCapabilityRows(q),
    visibleMissionRows(q, now),
    q("SELECT id, version, title, location, urgency, origin_ref FROM issues WHERE status = 'pending' ORDER BY created_at, id"),
    q("SELECT id, version, status, company_outcome, battlefields, confirmed_at FROM monthly_plans WHERE period = $1 ORDER BY version DESC LIMIT 1", [period]),
    q("SELECT id, version, title, status, scheduled_at, ends_at FROM meetings WHERE status <> 'cancelled' ORDER BY scheduled_at, id LIMIT 30"),
    q("SELECT version, ltco FROM company_strategy_config WHERE id = 'default'"),
  ]);
  const planRow = plan.rows[0] as { id: string; version: number; status: string; company_outcome: string; battlefields: { battlefieldId: string; outcome: string }[]; confirmed_at: Date | null } | undefined;
  const monthOutcome = new Map((planRow?.battlefields ?? []).map((item) => [item.battlefieldId, item.outcome]));
  const shanghai = (date: Date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return {
    period,
    company: strategy.rows[0] ? { ltco: (strategy.rows[0] as { ltco: string }).ltco, version: (strategy.rows[0] as { version: number }).version } : null,
    battlefields: battlefields.map(({ id, code, name, owner_id, six_month_outcome, version }) => ({ id, code, name, ownerId: owner_id, owner: names.get(owner_id) ?? owner_id, version,
      sixMonthOutcome: six_month_outcome, monthOutcome: monthOutcome.get(id) ?? null, missionCount: missions.filter((item) => item.battlefield_ids.includes(id)).length })),
    capabilities: capabilities.map(({ id, code, name, sixMonthOutcome }) => ({ id, code, name, sixMonthOutcome, missionCount: missions.filter((item) => item.capability_id === id).length })),
    missionCount: missions.length,
    missionPeriods: [...new Set(missions.map((item) => item.period))].sort().reverse(),
    // AI 候选议题带 nature / origin（来源性质，Agent 据此不把它说成已发生的事实），真实议题字段不变。
    pendingIssues: (issues.rows as { origin_ref?: unknown }[]).map(({ origin_ref, ...row }) => ({ ...row, ...issueOriginFields(origin_ref) })),
    // 首页说“公司结果/本月目标”时直接对应这份计划的具体字段与版本（反馈 3）。
    monthlyPlan: planRow ? { id: planRow.id, version: planRow.version, status: planRow.status, companyOutcome: planRow.company_outcome,
      confirmedAt: planRow.confirmed_at?.toISOString() ?? null, battlefields: planRow.battlefields } : null,
    meetings: (meetings.rows as { id: string; version: number; title: string; status: string; scheduled_at: Date; ends_at: Date }[])
      .map((row) => ({ id: row.id, version: row.version, title: row.title, status: row.status, start: `${shanghai(row.scheduled_at)}（北京时间）`, end: shanghai(row.ends_at) })),
  };
}

/** 本月的 Mission 照旧全列（listMissionRows），再加 visibleMissions 里别的月份的那几个。 */
async function visibleMissionRows(q: Query, now: Date): Promise<MissionRow[]> {
  const period = companyPeriod(now);
  const [current, visible] = await Promise.all([listMissionRows(q, period), visibleMissions(q, now)]);
  const others = new Set(visible.filter((item) => item.period !== period).map((item) => item.id));
  const periods = [...new Set(visible.filter((item) => others.has(item.id)).map((item) => item.period))];
  const earlier = (await Promise.all(periods.map((month) => listMissionRows(q, month)))).flat().filter((row) => others.has(row.id));
  return [...current, ...earlier];
}

export async function listConversationMissions(q: Query, filters: { period?: string; battlefieldId?: string; capabilityId?: string; ownerId?: string }, person?: { personId: string; role: "ceo" | "member" }): Promise<MissionConversationSummary[]> {
  const rows = await listMissionRows(q, filters.period, person);
  return rows
    .filter((item) => !filters.battlefieldId || item.battlefield_ids.includes(filters.battlefieldId))
    .filter((item) => !filters.capabilityId || item.capability_id === filters.capabilityId)
    .filter((item) => !filters.ownerId || item.owner_id === filters.ownerId)
    .map(missionSummary);
}
