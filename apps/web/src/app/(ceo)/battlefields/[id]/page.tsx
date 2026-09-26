import { BattlefieldDetailScreen } from "./BattlefieldDetailScreen";
import { loadBattlefieldCard, loadHomeCards, requireCeo } from "@/lib/api/server";

/** 战场二级页：战场本身读单个战场接口（404 → notFound，含本月反馈历史）；议题、会议与当期 Mission 读首页同一份集合。 */
export default async function BattlefieldPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  // 路由段是 percent-encoded 的原始 segment（战场 id 可能是中文），先解码再交给 openapi-fetch，避免双编码。
  const [{ id: segment }, { tab }] = await Promise.all([params, searchParams]);
  const id = decodeURIComponent(segment);
  const cookie = await requireCeo(`/battlefields/${segment}${tab === "progress" ? "?tab=progress" : ""}`);
  const [battlefield, home] = await Promise.all([loadBattlefieldCard(cookie, id), loadHomeCards(cookie)]);
  const card = battlefield.cards[0];
  if (!card) throw new Error("Battlefield Card missing");
  return <BattlefieldDetailScreen battlefield={card} cards={home.cards} initialTab={tab === "progress" ? "progress" : "decisions"} />;
}
