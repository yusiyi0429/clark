import { CardPage } from "@/components/CardPage";
import { loadSignalCard, requireCeo } from "@/lib/api/server";

export default async function SignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/radar/signals/${id}`);
  const { cards } = await loadSignalCard(cookie, id);
  return <CardPage initialCards={cards} scope={`signal:${id}`} label={cards[0].title} layout="feed" />;
}
