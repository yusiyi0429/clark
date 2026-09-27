import { DetailPanel } from "@/components/DetailPanel";
import { serverApi } from "@/lib/api/client";
import { loadMeetingCard, requireCeo, tryLoadIssueCards } from "@/lib/api/server";

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/meetings/${id}`);
  const { cards } = await loadMeetingCard(cookie, id);
  const issueIds = (cards[0].payload as { issueIds?: string[] }).issueIds ?? [];
  const [issues, thread] = await Promise.all([tryLoadIssueCards(cookie, issueIds),
    serverApi.GET("/api/threads/{objectType}/{objectId}", { params: { path: { objectType: "meeting", objectId: id } }, headers: { cookie } })]);
  return <DetailPanel initialCards={[...cards, ...issues]} scope={`meeting:${id}`} label={cards[0].title} mark="meeting" thread={{ objectType: "meeting", objectId: id, active: Boolean(thread.data) }} />;
}
