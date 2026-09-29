import { ReviewOverviewScreen } from "@/components/monthlyReview/ReviewOverviewScreen";
import { loadMonthlyReview } from "@/components/monthlyReview/loadMonthlyReview";
import { requireCeo } from "@/lib/api/server";

export default async function MonthlyReviewPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  const cookie = await requireCeo(`/reviews/${period}`);
  const review = await loadMonthlyReview(cookie, period);
  return <ReviewOverviewScreen key={period} initial={review} />;
}
