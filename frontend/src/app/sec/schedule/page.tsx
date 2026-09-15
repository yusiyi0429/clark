import type { Metadata } from "next";
import { ScheduleView } from "@/app/_views/schedule-view";

export const metadata: Metadata = {
  title: "编排会议 · TKOS",
  robots: { index: false, follow: false },
};

/**
 * 编排会议。左边全部在办议题，右边某一天的上午与下午，中间靠拖。
 *
 * 它从 `(tkos)/schedule` 搬到这一侧：排哪天开会、哪几件凑一场，是秘书的活。
 *
 * `ScheduleView` 仍然套着 `ConsoleShell`（一号位那个三栏壳，左边是雷达、八块生意、
 * 字标）——这是一笔明账：这一侧的排会页此刻长得和一号位的控制台一样，左边那几个
 * 入口点进去会离开秘书空间。等这一侧的东西多起来、值得有自己的布局时再改。下面
 * 传的两个 prop 都只是为了让它能落在秘书空间里，不是在还这笔账。
 *
 * `doneHref="/sec"`：`ScheduleView` 默认把「完成编辑」指向 `"/"`，那是它原来挂在
 * 一号位主屏下时唯一的意思。秘书进不去一号位那一侧（见 `src/lib/seat.ts`），照
 * 默认值走的话，她编完会被送到自己进不去、也不该进的地方，而且没有回头路。
 *
 * `heightClass="h-full"`：默认的 `"h-screen"` 假设自己是这一页唯一在算高度的人，
 * 而这里的 `ConsoleShell` 嵌在 `SecLayout` 的 `<main>` 里，外面已经有一顶品牌栏，
 * 两边都去要整个视口的高度，多出来的那一截正是相一验收时量到的 55px 溢出。传
 * `"h-full"` 把"到底有多高"交还给 `SecLayout`（细账见 `console-shell.tsx` 里同名
 * prop 的注释）。
 */
export default function SecSchedulePage() {
  return <ScheduleView doneHref="/sec" />;
}
