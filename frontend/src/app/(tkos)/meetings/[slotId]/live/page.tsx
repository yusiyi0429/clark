import { MeetingLiveView } from "@/app/_views/meeting-live-view";

/**
 * 一场会开着的时候那一页。
 *
 * 地址只有会这一段（没有议题）：这一页的单位是**一场会**，会上那几件议题在页面里切。
 * 和 `/meetings/[slotId]/[issueId]` 分工清楚 —— 那一条是会**后**某一件议题的那份提炼，
 * 单位是「议题 × 会」（理由写在那一页上）。
 *
 * `live` 是静态段，压在 `[issueId]` 前面命中 —— 所以不会有哪一件议题因为叫这个名字
 * 而抢走这条地址（议题 id 是 `ISS-` 开头的，本来也不会）。
 */
export default async function MeetingLivePage({
  params,
}: PageProps<"/meetings/[slotId]/live">) {
  const { slotId } = await params;
  return <MeetingLiveView slotId={slotId} />;
}
