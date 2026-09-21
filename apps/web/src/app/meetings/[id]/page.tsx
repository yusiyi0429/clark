import { CardPage } from "@/components/CardPage";
import { loadMeetingCard, requireCeo, tryLoadIssueCards } from "@/lib/api/server";

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/meetings/${id}`);
  const { cards } = await loadMeetingCard(cookie, id);
  const issueIds = (cards[0].payload as { issueIds?: string[] }).issueIds ?? [];
  const issues = await tryLoadIssueCards(cookie, issueIds);
  return <CardPage initialCards={[...cards, ...issues]} scope={`meeting:${id}`} label={cards[0].title} conversationPlacement="embedded" />;
}
