import type { QueryResult } from "pg";
import { companyPeriod } from "./monthlyPlans.js";
import { listBattlefieldRows } from "./battlefields.js";
import { listCapabilityRows } from "./capabilities.js";
import { listMissionRows, type MissionRow } from "./missions.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type MissionConversationSummary = Pick<MissionRow, "id" | "code" | "period" | "title" | "owner_id" | "capability_id" | "capability_code" | "capability_name" | "battlefield_ids" | "battlefield_names" | "outcome">;

function missionSummary(row: MissionRow): MissionConversationSummary {
  const { id, code, period, title, owner_id, capability_id, capability_code, capability_name, battlefield_ids, battlefield_names, outcome } = row;
  return { id, code, period, title, owner_id, capability_id, capability_code, capability_name, battlefield_ids, battlefield_names, outcome };
}

/** 首页对话的有界实时业务摘要；详细 Mission 由 list_missions 工具按需读取。 */
export async function globalConversationContext(q: Query, now: Date): Promise<Record<string, unknown>> {
  const period = companyPeriod(now);
  const [battlefields, capabilities, missions, issues, plan] = await Promise.all([
    listBattlefieldRows(q),
    listCapabilityRows(q),
    listMissionRows(q, period),
    q("SELECT id, title, location, urgency FROM issues WHERE status = 'pending' ORDER BY created_at, id"),
    q("SELECT id, status FROM monthly_plans WHERE period = $1 ORDER BY version DESC LIMIT 1", [period]),
  ]);
  return {
    period,
    battlefields: battlefields.map(({ id, code, name, owner_id, six_month_outcome }) => ({ id, code, name, ownerId: owner_id, sixMonthOutcome: six_month_outcome, missionCount: missions.filter((item) => item.battlefield_ids.includes(id)).length })),
    capabilities: capabilities.map(({ id, code, name, sixMonthOutcome }) => ({ id, code, name, sixMonthOutcome, missionCount: missions.filter((item) => item.capability_id === id).length })),
    missionCount: missions.length,
    pendingIssues: issues.rows,
    monthlyPlan: plan.rows[0] ?? null,
  };
}

export async function listConversationMissions(q: Query, filters: { period?: string; battlefieldId?: string; capabilityId?: string; ownerId?: string }, person?: { personId: string; role: "ceo" | "member" }): Promise<MissionConversationSummary[]> {
  const rows = await listMissionRows(q, filters.period, person);
  return rows
    .filter((item) => !filters.battlefieldId || item.battlefield_ids.includes(filters.battlefieldId))
    .filter((item) => !filters.capabilityId || item.capability_id === filters.capabilityId)
    .filter((item) => !filters.ownerId || item.owner_id === filters.ownerId)
    .map(missionSummary);
}
