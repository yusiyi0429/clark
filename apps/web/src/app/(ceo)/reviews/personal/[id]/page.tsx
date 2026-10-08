import { PersonalReviewScreen } from "@/components/monthlyReview/PersonalReviewScreen";
import { loadPersonalReview } from "@/components/monthlyReview/loadMonthlyReview";
import { requireCeo } from "@/lib/api/server";

export default async function PersonalReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/reviews/personal/${id}`);
  const review = await loadPersonalReview(cookie, id);
  return <PersonalReviewScreen key={review.personalReviewId} initialReview={review} />;
}
