import { ReviewItemScreen } from "@/components/monthlyReview/ReviewItemScreen";
import { loadMonthlyReviewItem } from "@/components/monthlyReview/loadMonthlyReview";
import { requireMember } from "@/lib/api/server";

export default async function MyMonthlyReviewItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const { cookie } = await requireMember(`/me/reviews/items/${itemId}`);
  const item = await loadMonthlyReviewItem(cookie, itemId);
  return <ReviewItemScreen key={item.itemId} initialItem={item} />;
}
