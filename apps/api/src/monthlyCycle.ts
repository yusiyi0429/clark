import type { TMonthlyCycle } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

export function shiftMonth(period: string, months: number): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 7);
}
export const ltoWindow = (period: string) => ({ start: shiftMonth(period, 1), end: shiftMonth(period, 6) });

/** 全周期只有个人复盘补建时落下的一个起点；阶段变化和讨论重开均不重置。 */
export async function readMonthlyCycle(q: Query, now: Date): Promise<TMonthlyCycle | null> {
  const review = (await q(`SELECT id,period,status,cycle_started_at FROM monthly_reviews
    WHERE cycle_started_at IS NOT NULL ORDER BY period DESC LIMIT 1`)).rows[0] as
    { id: string; period: string; status: string; cycle_started_at: Date } | undefined;
  if (!review) return null;
  const nextPeriod = shiftMonth(review.period, 1);
  const rounds = (await q(`SELECT r.status,r.confirmed_at FROM battlefield_config b
    LEFT JOIN mission_rounds r ON r.battlefield_id=b.id AND r.period=$1 ORDER BY b.id`, [nextPeriod])).rows as
    { status: string | null; confirmed_at: Date | null }[];
  const completedAt = rounds.length && rounds.every((row) => row.status === "confirmed" && row.confirmed_at)
    ? new Date(Math.max(...rounds.map((row) => row.confirmed_at!.getTime()))) : null;
  if (completedAt && now.getTime() - completedAt.getTime() > 7 * 86_400_000) return null;
  const outstanding = await q("SELECT 1 FROM personal_reviews WHERE monthly_review_id=$1 AND status NOT IN ('submitted','skipped') LIMIT 1", [review.id]);
  const plan = (await q("SELECT status FROM monthly_plans WHERE period=$1", [nextPeriod])).rows[0];
  const stage: TMonthlyCycle["stage"] = outstanding.rowCount ? "personal_reviews"
    : review.status === "collecting" ? "unit_reviews" : review.status === "summarizing" ? "company_summary"
    : review.status === "ltco_pending" ? "lto_decision" : plan?.status !== "confirmed" ? "period_plan"
    : completedAt ? "done" : "mission_cards";
  return { reviewPeriod: review.period, nextPeriod, startedAt: review.cycle_started_at.toISOString(),
    deadlineAt: new Date(review.cycle_started_at.getTime() + 72 * 60 * 60_000).toISOString(),
    completedAt: completedAt?.toISOString() ?? null, stage, serverNow: now.toISOString() };
}
