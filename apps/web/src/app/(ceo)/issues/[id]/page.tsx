import { DetailPanel } from "@/components/DetailPanel";
import { loadIssueCard, loadMeetingCards, requireCeo } from "@/lib/api/server";
import { serverApi } from "@/lib/api/client";

export default async function IssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/issues/${id}`);
  const [{ cards }, meetings, thread] = await Promise.all([loadIssueCard(cookie, id), loadMeetingCards(cookie),
    serverApi.GET("/api/threads/{objectType}/{objectId}", { params: { path: { objectType: "issue", objectId: id } }, headers: { cookie } })]);
  const scheduled = meetings.cards.filter((card) => (card.payload as { status?: string }).status === "scheduled");
  return <DetailPanel initialCards={[...cards, ...scheduled]} scope={`issue:${id}`} label={cards[0].title} thread={{ objectType: "issue", objectId: id, active: Boolean(thread.data) }} />;
}
