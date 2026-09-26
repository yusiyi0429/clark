import { DetailPanel } from "@/components/DetailPanel";
import { loadRadarCards, requireCeo } from "@/lib/api/server";

export default async function RadarPage() {
  const cookie = await requireCeo("/radar");
  const { radar, signals } = await loadRadarCards(cookie);
  return <DetailPanel initialCards={[radar, ...signals]} scope="global" label="雷达信号" />;
}
