"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { LiveData } from "@/components/live-data";
import { LogOutButton } from "@/components/log-out-button";

/**
 * 秘书那一侧的外壳。骨架照 `src/app/dri/layout.tsx`。
 *
 * **不套 `StageNav`**，理由和 DRI 那一侧同一条：那条导航只认「议题 / 会议」两个
 * 大类，而这一侧没有这两个大类 —— 秘书来这里做的是排会和审纪要，两件都是"把材料
 * 弄进来、把该走的往下推"，不是"我手上有哪些事"。
 *
 * `LiveData` 放在外壳里，换页时 `layout` 不重挂，一条连接活过整个会话（同另外两侧）。
 * 在这一侧尤其要紧：秘书面前的东西几乎全是别人的动作产生的 —— 会开完了、纪要提炼
 * 出来了，都不是他自己点出来的。
 *
 * ## 顶栏 2026-09-03 拆掉了——她的空间该长得跟一号位一样
 *
 * 一号位那一侧从来没有顶栏（字标坐在左列底边，见 `console-shell.tsx` 的 `Wordmark`）。
 * 秘书这一侧原来有一条：品牌 + 「编排会议」「纪要审阅」两个链接 + 登出，55px。两侧
 * 三栏骨架此刻已经是同一套（`ConsoleShell`），这条栏是唯一还在提醒"这是另一个空间"
 * 的东西，所以拆掉，两颗链接跟着搬进 `ConsoleShell` 左栏那段本来空着的地方
 * （`SecJobLinks`，域列表和字标之间）。
 *
 * `/sec`、`/sec/schedule` 都套那具壳，搬过去之后哪儿都够得着，登出也一并交给
 * `Wordmark`（它现在一直渲染登出按钮）。`/sec/debriefs` 不套 `ConsoleShell`——没有
 * 左栏可搬，下面 `needsFallbackNav` 单独给它补一份同样的两个入口和登出，不铺成
 * 全站的浮层，也不再造一条栏。
 *
 * ## 根节点还是 `h-screen`，`main` 还是 `min-h-0 flex-1`——顶栏没了，这两处没变
 *
 * 少了顶栏之后 `main` 分到的不再是"视口减去 55px"，是整个视口——但算法不用改：
 * `flex-1` 在只有一个 flex item 时一样会把它撑到父级的全部高度，`min-h-0` 仍然是
 * 把这份高度从"下限"改成"精确值"的那一步，`ConsoleShell` 的 `heightClass="h-full"`
 * 照旧吃得到。真正变的只是这份高度里不再有 55px 被顶栏先拿走。
 */
export default function SecLayout({ children }: LayoutProps<"/sec">) {
  const pathname = usePathname();
  /* `/sec` 与 `/sec/schedule` 套 `ConsoleShell`，登出和两个入口已经在它的左栏里
     （`console-shell.tsx` 的 `SecJobLinks` + `Wordmark`）。`/sec/debriefs` 没有那具
     壳——它是删掉顶栏之后唯一没地方去的一页，这里单独给它补上，而不是给全站都加
     一层浮层。 */
  const needsFallbackNav = pathname !== "/sec" && pathname !== "/sec/schedule";

  return (
    <div className="flex h-screen flex-col">
      <LiveData />
      <main className="min-h-0 flex-1">{children}</main>
      {needsFallbackNav && (
        // `top-4` 而不是 `bottom-4`：左下角是浏览器和开发工具惯用的角落
        // （devtools 的路由指示器就钉在那儿），这两颗链接不跟它抢像素。
        <div className="pointer-events-none fixed inset-x-6 top-4 flex items-center justify-between">
          <nav aria-label="秘书事务" className="pointer-events-auto flex items-center gap-4">
            <Link
              href="/sec"
              className="meta text-ink-faint transition-colors duration-fast hover:text-ink-muted"
            >
              控制台
            </Link>
            <Link
              href="/sec/schedule"
              className="meta text-ink-faint transition-colors duration-fast hover:text-ink-muted"
            >
              编排会议
            </Link>
          </nav>
          <LogOutButton className="pointer-events-auto" compact />
        </div>
      )}
    </div>
  );
}
