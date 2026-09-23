import { MissionManagementScreen } from "./MissionManagementScreen";
import { loadBattlefieldManagement, loadCapabilityManagement, loadMissionCards, loadPeople, requireCeo } from "@/lib/api/server";

export default async function MissionConfigPage({ searchParams }: { searchParams: Promise<{ missionId?: string }> }) {
  const { missionId } = await searchParams;
  const cookie = await requireCeo("/config/missions");
  const [missions, { battlefields }, { capabilities }, people] = await Promise.all([
    loadMissionCards(cookie),
    loadBattlefieldManagement(cookie),
    loadCapabilityManagement(cookie),
    loadPeople(cookie),
  ]);
  return (
    <MissionManagementScreen
      missions={missions.cards}
      battlefields={battlefields}
      capabilities={capabilities}
      people={people}
      initialMissionId={missionId}
    />
  );
}
