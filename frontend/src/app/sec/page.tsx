import type { Metadata } from "next";

import { SecHomeView } from "@/app/_views/sec-home-view";

export const metadata: Metadata = {
  title: "秘书 · TKOS",
  robots: { index: false, follow: false },
};

/**
 * 秘书那一侧的首页。
 *
 * ## 这一页从「两张入口卡片」改成了「一号位那套三栏控制台」
 *
 * 上一版这里只摊两张链接卡（`编排会议`/`纪要审阅`），理由写的是「这一侧此刻只有两件
 * 事，摘一段摘要出来是同一份东西在屏幕上出现两遍」。那条理由此刻被推翻了——2026-09-03
 * 一号位当面定了新的说法：秘书的主页应当跟一号位的主页几乎一样（同一套雷达、业务域、
 * 议题清单、动态面板），只是多两颗属于她自己的入口键；两个人之间的差别应该只体现在
 * 「交互区」（动态面板）被后台推送了什么，不是屏幕的骨架长成两个样子。
 *
 * 骨架从此和一号位共用同一套装配逻辑（`ConsoleShell` + `IssueColumn` + `DynamicPanel`），
 * 具体接线和「两颗键为什么落在这个位置」的完整论证在 `SecHomeView` 里，这里不重复。
 */
export default function SecHomePage() {
  return <SecHomeView />;
}
