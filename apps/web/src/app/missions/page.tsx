import { MissionOverviewScreen } from "./MissionOverviewScreen";
import { loadBattlefieldManagement, loadMissionManagement, requireCeo } from "@/lib/api/server";

export default async function MissionsPage({ searchParams }: { searchParams: Promise<{ battlefieldId?: string; capabilityId?: string }> }) {
  const { battlefieldId, capabilityId } = await searchParams;
  const cookie = await requireCeo("/missions");
  const [{ missions }, { battlefields }] = await Promise.all([loadMissionManagement(cookie), loadBattlefieldManagement(cookie)]);
  return <MissionOverviewScreen missions={missions} battlefields={battlefields} initialFilters={{ battlefieldId, capabilityId }} />;
}
