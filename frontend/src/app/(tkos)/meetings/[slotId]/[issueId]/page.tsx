import { MeetingDebriefView } from "@/app/_views/meeting-debrief-view";

/**
 * 一件议题在一场会上的那一份，详细内容。
 *
 * 地址是 `会 / 议题` 两段，因为**会后提炼的单位就是「议题 × 会」**（见 `MeetingDebrief`）：
 * 同一件议题开三次会就有三份，各自只说自己那一场。挂在 `/issues/[id]` 底下的话，这三份
 * 就得在议题这一层再选一次「哪一场」——而那个选择本来已经由他点进来的那张卡做完了。
 *
 * 页面本身是什么、四节为什么是这个顺序，写在 `MeetingDebriefView` 上。
 */
export default async function MeetingDebriefPage({
  params,
}: PageProps<"/meetings/[slotId]/[issueId]">) {
  const { slotId, issueId } = await params;
  /*
   * `(tkos)` 是一号位那一侧的路由组，这里传 `readOnly`。
   *
   * 排会与审纪要相一已经搬去了秘书空间（`/sec/schedule`、`/sec/debriefs`）；一号位
   * 点名要保留的只是**看得到**会议细节 —— 会议原文、摘要、要做的事、参会的 DRI ——
   * 不是在这儿替秘书按「无需再议」或者改一条要点的字。这个布尔值不是从这个页面运行时
   * 判出来的，是这条路由本身的性质：往后秘书那一侧要开同一个组件的等价页面时，
   * 那条路由自己会传 `false`，两边各管各的座位，不需要一个共享的运行时开关。
   */
  return <MeetingDebriefView slotId={slotId} issueId={issueId} readOnly />;
}
