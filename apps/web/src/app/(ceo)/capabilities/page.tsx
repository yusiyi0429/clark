import { CapabilityDetailScreen, type CapabilityPlan } from "./CapabilityDetailScreen";
import { loadHomeCards, loadMonthlyPlanCards, requireCeo } from "@/lib/api/server";
import { companyMonth } from "@/lib/companyTime";

/** 公司能力详情：能力域、议题与当期 Mission 读首页同一份 Card 集合；本月目标读当月月度计划（签发后首页不再带它）。 */
export default async function CapabilitiesPage() {
  const cookie = await requireCeo("/capabilities");
  const [{ cards }, plans] = await Promise.all([loadHomeCards(cookie), loadMonthlyPlanCards(cookie)]);
  const period = companyMonth(new Date());
  const plan = (plans.cards.find((card) => (card.payload as { period?: string }).period === period)?.payload as CapabilityPlan | undefined) ?? null;
  return <CapabilityDetailScreen cards={cards} plan={plan} />;
}
