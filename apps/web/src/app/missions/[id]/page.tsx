import { MissionDetailScreen } from "./MissionDetailScreen";
import { loadMissionDetail, requireCeo } from "@/lib/api/server";

export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/missions/${id}`);
  const { mission, planStatus } = await loadMissionDetail(cookie, id);
  return <MissionDetailScreen mission={mission} planStatus={planStatus} />;
}
