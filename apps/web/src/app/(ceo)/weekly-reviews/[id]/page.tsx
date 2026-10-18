import { WeeklyReviewScreen } from "@/components/weeklyReview/WeeklyReviewScreen";
import { loadWeeklyReview } from "@/components/weeklyReview/loadWeeklyReview";
import { requireCeo } from "@/lib/api/server";

export default async function WeeklyReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/weekly-reviews/${id}`);
  const review = await loadWeeklyReview(cookie, id);
  return <WeeklyReviewScreen key={review.weeklyReviewId} initialReview={review} />;
}
