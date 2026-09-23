import { MissionDetailScreen } from "./MissionDetailScreen";
import { loadMissionDetail, requireCeo } from "@/lib/api/server";

export default async function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // 路由段是 percent-encoded 的原始 segment（Mission id 保留中文），openapi-fetch 还会再编码一次，
  // 不先解码就会变成双编码，Fastify 按解码后长度超 100 直接回 414。
  const { id: segment } = await params;
  const id = decodeURIComponent(segment);
  const cookie = await requireCeo(`/missions/${id}`);
  const { mission, planStatus } = await loadMissionDetail(cookie, id);
  return <MissionDetailScreen mission={mission} planStatus={planStatus} />;
}
