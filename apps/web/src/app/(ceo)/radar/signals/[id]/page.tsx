import { DetailPanel } from "@/components/DetailPanel";
import { loadRadarCards, loadSignalCard, requireCeo } from "@/lib/api/server";

export default async function SignalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = await requireCeo(`/radar/signals/${id}`);
  const { cards } = await loadSignalCard(cookie, id);
  // 「继续浏览」用雷达列表同一份信号（clark：读完一条，下一条已经在下面）；列表读不到时文章照常打开。
  const others = await loadRadarCards(cookie)
    .then(({ signals }) => signals.filter((signal) => signal.id !== cards[0].id))
    .catch(() => []);
  return <DetailPanel initialCards={[...cards, ...others]} scope={`signal:${id}`} label={cards[0].title} />;
}
