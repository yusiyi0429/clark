import { notFound } from "next/navigation";
import { LtcoDecisionScreen } from "@/components/monthlyReview/LtcoDecisionScreen";
import { loadMonthlyReview } from "@/components/monthlyReview/loadMonthlyReview";
import { requireCeo } from "@/lib/api/server";

export default async function LtcoDecisionPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  const cookie = await requireCeo(`/reviews/${period}/ltco`);
  const { review } = await loadMonthlyReview(cookie, period);
  if (!review) notFound();
  return <LtcoDecisionScreen key={`${review.reviewId}:${review.version}`} review={review} />;
}
