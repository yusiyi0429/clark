import { MissionCardScreen } from "@/components/missionCards/MissionCardScreen";
import { loadPersonalMissionCard } from "@/components/missionCards/loadPersonalMissionCard";
import { requireCeo } from "@/lib/api/server";

export default async function PersonalMissionCardPage({ params }: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await params;
  const cookie = await requireCeo(`/mission-cards/${cardId}`);
  const card = await loadPersonalMissionCard(cookie, cardId);
  return <MissionCardScreen key={card.id} initialCard={card} entry="ceo" />;
}
