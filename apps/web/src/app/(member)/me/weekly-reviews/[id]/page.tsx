import { WeeklyReviewScreen } from "@/components/weeklyReview/WeeklyReviewScreen";
import { loadWeeklyReview } from "@/components/weeklyReview/loadWeeklyReview";
import { requireMember } from "@/lib/api/server";

export default async function MyWeeklyReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cookie } = await requireMember(`/me/weekly-reviews/${id}`);
  const review = await loadWeeklyReview(cookie, id);
  return <WeeklyReviewScreen key={review.weeklyReviewId} initialReview={review} />;
}
