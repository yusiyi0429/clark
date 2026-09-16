import { notFound } from "next/navigation";
import { CardPage } from "@/components/CardPage";
import { loadMonthlyPlanCards, requireCeo } from "@/lib/api/server";

export default async function MonthlyPlanPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  const cookie = await requireCeo(`/plans/${period}`);
  const { cards } = await loadMonthlyPlanCards(cookie);
  const plan = cards.find((card) => (card.payload as { period?: string }).period === period);
  if (!plan) notFound();
  return <CardPage initialCards={[plan]} scope={`monthly-plan:${plan.objectRef.id}`} label={plan.title} />;
}
