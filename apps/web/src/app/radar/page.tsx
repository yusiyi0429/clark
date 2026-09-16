import { CardPage } from "@/components/CardPage";
import { loadRadarCards, requireCeo } from "@/lib/api/server";

export default async function RadarPage() {
  const cookie = await requireCeo("/radar");
  const { radar, signals } = await loadRadarCards(cookie);
  return <CardPage initialCards={[radar, ...signals]} scope="global" label="雷达信号" layout="feed" />;
}
