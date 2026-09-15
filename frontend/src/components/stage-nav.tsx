"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IssueHeader } from "@/components/advisor/issue-header";
import { TianshuMark } from "@/components/brand/tianshu-mark";
import { LogOutButton } from "@/components/log-out-button";
import { cn } from "@/lib/utils";

/**
 * 顶上那一行。**它不再是一条栏。**
 *
 * 这里的历史是一路减下来的：五格流程条 → 通栏 header → 悬浮胶囊 → 现在什么都没有。
 * 最后这一步的理由和前几步是同一个：那颗胶囊什么都不承载。
 *
 * 那时它上面只剩两样东西（字标、文档库），而一颗 1232px 宽、带边、带影子、带磨砂的
 * 圆角胶囊是**为一屋子控件准备的容器**。容器里只剩两件东西时，容器本身就是屏幕上最重的
 * 那个物件 —— 一号位第一眼看见的是一条横贯全屏的浅灰长条，而不是他要读的议题。
 *
 * 现在字标直接坐在纸上。位置一个像素都没动：
 *
 * - 外层 `px-4 py-2 sm:px-6` + `h-12` 仍然合成 64px，各页面里的 `calc(100vh-4rem)`
 *   照旧。
 * - 内层保留 `px-5`。它原本是胶囊自己的内边距，胶囊没了，这 20px 就没有来由了 ——
 *   但它是字标现在这个位置的来由（24 + 20 = 44px）。留着，注明它是位置而不是容器。
 *
 * 剩下的都拿掉了：
 *
 * - **胶囊**（`.floating`）：底色、磨砂、影子、半像素暗边。
 * - **两条竖发丝线**（字标／返回之间，文档库左边）。它们是分隔**同一个容器里**相邻
 *   两组控件用的。容器没了，一条 16px 高的竖线悬在空纸上，分隔的是空气。
 * - **演示复位那颗按钮**。它是给 demo 场次之间回到干净状态用的，从来不属于产品。
 *   `api.resetDemo` 留在数据层（scope 仍是 ceo），要用就走接口，不在屏幕上占一格。
 * - **右上角那个「文档库」**（2026-08-20 拿掉的）。**页面还在**（`/docs`、`/docs/[id]`），
 *   而且必须在：报告与判断里每一条内部依据都指着它，「出处点得开」是那些页面的地基。
 *   拿掉的只是这一行上的常驻入口 —— 一号位不是从导航去翻文件柜的，他是读到一条依据、
 *   想看原文才点进去。要加回来的话，位置和字色的账在 git 历史里。
 *
 * 保留的是那条渐进模糊带（`.scroll-edge`）。它不是栏 —— 静止在未滚动的页面上，
 * 92% 的桌面色盖在桌面上，看不见；只有深色内容滚到这一行底下时它才现形，把内容化开。
 * 胶囊拿掉之后它成了这一行文字唯一的底，所以它的高位拉长了一段（见 globals.css 里
 * 那段算式：最坏情况从 3.25:1 回到 5.32:1）。那段算式对现在这一行照样成立：它算的是
 * `ink-muted` 压在最深的内容上，而「返回」和议题头部用的都是这一档。
 *
 * ## 这一行只回答两件事
 *
 * **我在哪**（字标 = 回主页）和**怎么回去**。不在主页时字标右边那格是「返回」；已经在
 * 主页时它什么也不说 ——「战略议题」四个字是那一屏自己那块板的标题，不是导航项。
 * 右端只留退出登录：它不是产品环节的入口，是结束这次使用的出口。
 *
 * 字标右边那枚小小的版本号（2026-08-20 加的）是唯一的例外，而它不算第三件事：
 * 它指的是**这个产品自己**改了什么（`/changelog`），不是一号位工作流里的哪一站。
 * 它贴着字标，是那块牌子的尾注 —— 不在右端，右端仍然空着。
 *
 * 议题研究页还多一段：那一页的**议题身份与议题动作长在这一行里**（`IssueHeader`），
 * 不是下面的第二条 header。两条 header 在一块 950px 高的屏幕上吃掉 168px，而那一页的
 * 正文是两栏要连读的东西 —— 合成一行之后省下的 92px 全部给了报告与把关区。
 *
 * 这一行因此知道一条具体路由的内容。这是有意的：它本来就按路由决定自己有什么，「在这一页，
 * 头部承载的是那件议题」是同一类判断。内容本身归 `components/advisor/`，这里只负责把
 * 它放在哪。
 *
 * ## 议题研究页上这一行再矮一档（`compact`）
 *
 * 那一页是这个产品里唯一**两栏都要连读**的页面：左边一份研报正文，右边一整场对话，
 * 两边各自滚。页面不滚，所以这一行占掉的每一个像素都是从正文里扣的 —— 别的页面正文
 * 可以往下长，那一页不能。64 → 48px，扣的 16px 全给了那两栏。
 *
 * 同一个理由砍掉三样：
 *
 * 1. **版本号**。它是字标的尾注，指的是「这个产品改了什么」；一号位在读一件议题时，
 *    这是屏幕上最不相关的一格。别的页面上它照旧。
 * 2. **「返回战略主页」那四个字**。收成一枚箭头（`aria-label`/`title` 里那句话不动，
 *    读屏和悬停都还听得见「返回战略主页」）。这是全站唯一一处这么收的：别处那一行
 *    是空的，写全「回哪」不占任何人的地方，而这一页右边紧挨着议题编号和标题。
 * 3. **那条渐进模糊带**（`.scroll-edge`）。它是给「内容滚到这一行底下」准备的，而
 *    那一页整页不滚，两栏各自滚在自己的框里，永远不会滚到这一行底下 —— 一层永远
 *    不现形的东西。那一页的底又是整片白纸（不是桌面），带子里的纸色淡出会在白上
 *    显出一道灰。
 */

/** `/issues/ISS-106` → `ISS-106`；别的路由（含 `/issues` 列表）返回 null。 */
function issueIdOf(pathname: string): string | null {
  const m = /^\/issues\/([^/]+)$/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * 能当「上一级」的就这几页，名字照那一页自己标题里的写法，不另起一套。
 *
 * 主页那一档写的是**「战略主页」**而不是「主页」：这个产品里「主页」这个词本身不说明
 * 任何事（潜在议题、扫描记录、文档库都是「一页」），而主页那一屏是他的战略议题清单。
 */
const PAGES = {
  home: { href: "/", name: "战略主页" },
  signals: { href: "/signals", name: "潜在议题" },
  issues: { href: "/issues", name: "战略议题" },
  docs: { href: "/docs", name: "文档库" },
  decisions: { href: "/decisions", name: "会后确认" },
  outcomes: { href: "/outcomes", name: "目标与任务" },
} as const;

type Parent = (typeof PAGES)[keyof typeof PAGES];

/**
 * 回哪儿去 —— **上一级，不是主页**。
 *
 * 从潜在议题清单点进一张卡，他心里的「回去」是回那张清单：他刚才正在那儿挑，还没挑完。
 * 一律回主页，等于每次退出都把他甩回起点，剩下的几条得重新找一遍。
 *
 * 这张表按**屏幕上真的存在的那条入口**排，不是按 URL 的层级。`/signals-scans`
 * （扫描记录）在路径上和 `/signals`（潜在议题）是兄弟，可进它的唯一口子是潜在议题
 * 那一屏标题行上的「扫描记录 →」—— 所以它的上一级是潜在议题。待定区、处置记录、
 * 监控策略同理：这几页全挂在那一屏上，一条也不从主页进。（待挑的信号原来也是一页，
 * 现在是那一屏的下半段，`/signals-inbox` 只剩一个跳转。）
 *
 * 每一格都带着上一级**叫什么**，屏幕上写全（「返回潜在议题」）。只写「返回」两个字的
 * 话，这一行说得出的只是「有地方可回」，回到哪儿得按下去才知道 —— 而一号位在这些页面
 * 之间是来回跳的，「回哪」正是他要的那半句。
 *
 * 没进这张表的按主页算。留在那一档的多半是**入口不止一处**的页面：判断
 * （`/judgments/[id]`）从目标与任务那棵树、也从文档里每一条依据点进来；议题研究
 * （`/issues/[id]`）从主页的清单、去向记录、会后确认都能进。猜一个上一级就会有一部分
 * 次数把他送到他没来过的地方，那时候回主页反而是老实话。
 */
const PARENTS: { test: RegExp; parent: Parent }[] = [
  { test: /^\/signals\/[^/]+$/, parent: PAGES.signals }, // 潜在议题详情
  { test: /^\/signals-scans$/, parent: PAGES.signals }, // 扫描记录
  { test: /^\/signals-log$/, parent: PAGES.signals }, // 处置记录
  { test: /^\/archive$/, parent: PAGES.signals }, // 待定区
  { test: /^\/sensors$/, parent: PAGES.signals }, // 监控策略
  { test: /^\/issues-log$/, parent: PAGES.issues }, // 去向记录
  { test: /^\/docs\/[^/]+$/, parent: PAGES.docs },
  { test: /^\/decisions\/[^/]+$/, parent: PAGES.decisions },
  { test: /^\/outcomes\/commitment\/[^/]+$/, parent: PAGES.outcomes }, // 逐条裁决
];

function parentOf(pathname: string): Parent {
  return PARENTS.find((p) => p.test.test(pathname))?.parent ?? PAGES.home;
}

/**
 * @param version 屏幕上那枚版本号，形如 `v0.20.0`。**由外面传进来**，不在这里
 *   import `lib/changelog` —— 这是个客户端组件，import 一下整份日志正文（每一版
 *   改了什么，几十条中文）就跟着进每一页的 JS 包，而那些字只有 `/changelog`
 *   那一页要用。真源仍是同一个模块，见 `app/(tkos)/layout.tsx`。
 */
export function StageNav({ version }: { version: string }) {
  const pathname = usePathname();
  const home = pathname === "/";
  const issueId = issueIdOf(pathname);
  const back = parentOf(pathname);
  /* 矮一档的那一行 —— 目前只有议题研究页，理由见文件开头。 */
  const compact = issueId !== null;

  /*
   * **主页和已部署那一页上整条不出现。**
   *
   * 主页那一屏自己就是排好的一版：左边一列（雷达、业务域、字标）加右边两栏。字标坐在
   * 左列的底边上 —— 那是那一屏的设计（2026-08-30 定的），顶上再挂一条常驻栏就是同一个
   * 字标在一屏上出现两次，而两次里必然有一次是多余的。
   *
   * 返回入口在主页上本来也无处可去（它就是根），版本号跟着字标走进了左列底部。所以这一
   * 行在主页上没有任何一项还剩下要做的事。
   *
   * 已部署那一页同理：三屏是同一套满屏版式（`h-screen`），顶上再压一条常驻栏，
   * 整版就会被顶出视口一截。「回去」在它上面有更准确的说法 —— 右边缘那两颗点里的另一颗。
   *
   * 编排会议 2026-09-02 搬去了 `/sec/schedule`：那一侧套的是 `SecLayout`，根本不挂
   * 这个组件，所以这里不用再单独认它的路径。
   */
  if (home || pathname === "/deployed") return null;

  return (
    <header className={cn("sticky top-0 z-30 px-4 sm:px-6", compact ? "py-1" : "py-2")}>
      {/*
       * 矮的那一档底下有一条横线，从屏幕左边到右边。
       *
       * 它只在这一档存在，而这一档只有议题研究页 —— 那一页整屏是一张白纸，正文两栏之间
       * 那条竖线从上一直画到底。竖线的上端本来悬在空处：眼睛顺着它往上走，走到半空就
       * 没了。这条横线是那根竖线的顶 —— 两条接上之后，屏幕才是「一张纸被分成了上面一行
       * 和下面两栏」，而不是「三条不相干的线」。
       *
       * 别的页面上没有它，也不该有：那些页面的内容会滚到这一行底下，靠的是渐进模糊带
       * （`.scroll-edge`，见上）把内容化开。一条实线在那儿会把「化开」变成「切断」，
       * 滚到一半的字会正好被它切一刀。
       *
       * **它是绝对定位的，不是 `border-b`。** 这一行的高度是一个被人依赖的数：`py-1`
       * 加 `h-10` 正好 48px，而那一页的正文写着 `h-[calc(100vh-3rem)]`。加一条
       * `border-b` 就是 48.67px，两块加起来比视口高 0.67px —— 于是整页多出一根竖滚动条，
       * 内容再被它挤窄 15px。绝对定位的线不占高度。
       *
       * `inset-x-0` 贴的是 padding box，所以它穿过左右那 16/24px 的内边距，真的从屏幕
       * 这边到那边。
       */}
      {compact ? (
        <div aria-hidden className="absolute inset-x-0 bottom-0 border-b border-hairline" />
      ) : null}

      {/*
       * 渐进模糊带。比这一行高（88px > 64px），所以过渡在文字**下方**才结束 ——
       * 在这一行高度上就收完的话，底沿会出现一条「上面糊下面清」的硬线。
       *
       * 三个空 div 不是凑数：两层错开的模糊 + 一层纸色淡出，各自带自己的 mask，
       * 合起来才是连续的。写在这里而不是伪元素里，是因为一个元素只有两个伪元素，
       * 而这里要三层。
       *
       * 它必须是**绝对定位**的（规则在 globals.css 的 `.scroll-edge`）。这条 CSS
       * 曾经整个缺失过一段时间：class 名照写、三处媒体查询照覆盖，唯独主定义没有 ——
       * 于是这个 88px 高的 div 留在正常流里，把下面的内容往下顶了 88px，
       * 屏幕上就是「顶栏上方一大片空白」。CSS 少一条规则不报错，别把它当没事。
       */}
      {compact ? null : (
        <div aria-hidden className="scroll-edge h-[5.5rem]">
          <div />
          <div />
          <div />
        </div>
      )}

      {/* 没有面、没有边、没有影子。`px-5` 只为守住字标那 44px（见文件开头）。
          矮的那一档收到 `px-4`：那一页两栏之间只有一条线，整屏是一张白纸，
          字标离屏幕边太远反而像另有一层容器。 */}
      <div
        className={cn(
          "relative z-10 mx-auto flex max-w-[1600px] items-center",
          compact ? "h-10 gap-3 px-4" : "h-12 gap-4 px-5",
        )}
      >
        {/*
         * 字标 —— 六向枢纽标记 +「天枢」两个字。
         *
         * 这不是被删掉的谛听兽头：新图形从「天枢」本身出发，中央双层枢纽向六个方向
         * 发出长短不一的光路。图形负责解释名字，两个字负责把名字念出来。
         *
         * SVG `aria-hidden`，所以链接的无障碍名仍然就是屏幕上那两个字；读屏不会重复念。
         *
         * ## 两个尺寸
         *
         * **字 19px。** 这一档同时
         * 也是这一行的高度账：抖音美好体的两字墨区是 0.908em（-108…800／1000），19px 上
         * 墨高 17.25px，和 48px 高的这一行、和右边 12px 的版本号已经配平过一轮。
         *
         * **标记 22px、间距 6px。** 22px 让中心双环在低分屏上仍能分开；6px 比字间距大、
         * 比字标到下一组内容的 16px 小，图形和文字因此读成同一件东西。
         *
         * `tracking-[0.055em]` 是把两个汉字撑开成一块牌子 —— 挨在一起是个词，分开一点
         * 才是字标。在 19px 上它是 1.05px，加上两个字自己的边空（天右 40／枢左 29，
         * 合 1.3px）合成 2.36px 的字间空气。比行楷那一版的 4.5px 紧：这款字方正、边空
         * 本来就窄，同一个 tracking 在它身上给出的是另一个数，而这个数在 19px 上仍然
         * 是「一块牌子」。再多就散成两个字，再少就糊成一个词。
         *
         * 末尾那个 `-mr-[1.05px]`：没有。行尾多出来的那 1.05px 字距不抵 —— 右边紧接
         * 的是 16px 的 gap，1px 在里面看不出来，而抵掉需要一个负 margin，读代码的人
         * 得先想明白它在抵什么。
         *
         * `.engraved` 给的是石身色（`--granite`）加一道半像素的下沿反光。悬停只剩整体压
         * 10% 不透明度 —— 品牌双色（`--brand-deep`/`--brand-bright`）是更早那枚标记身上
         * 的效果，这两个字是同一块石头的一部分，不该在悬停时变成蓝的。
         */}
        <Link
          href="/"
          className="engraved flex min-w-0 flex-none items-center gap-1.5 rounded-[3px] transition-opacity duration-fast hover:opacity-90"
        >
          <TianshuMark className="h-[22px] w-[22px] shrink-0" />
          <span className="font-wordmark text-[19px] leading-none tracking-[0.055em]">天枢</span>
        </Link>

        {/*
         * 版本号 —— 这一行上唯一一个「去别处」的入口，而它去的是**关于这一行自己**
         * 的那一页（改了什么）。文件开头那条约束因此没有被推翻：常驻入口指向的不是
         * 产品的另一个环节，是这个产品的版本。
         *
         * **它必须在字标外面。** `<a>` 里套 `<a>` 是无效 HTML，浏览器会把内层那个
         * 提出来，点击落到谁身上不确定。所以字标和它是兄弟节点。
         *
         * `-ml-2.5`（10px）把它拉回来：外层的 gap 是 16px，那是**两组东西之间**的
         * 距离（字标 / 返回）。版本号不是第三组，它是字标的尾注 —— 6px 让它贴着
         * 那块牌子，和标记到字的 6px 同一档。
         *
         * `mt-[3px]` 是往下坐一点点：12px 的字和 19px 的行楷按中线对齐时，视觉上
         * 会显得偏高（行楷的墨压在 em 的下半部）。三个像素让它落在两个字的下沿附近，
         * 读起来是「刻在牌子边上的一行小字」。
         *
         * 已经在这一页时不再是链接 —— 一个指向当前页面的链接，按下去什么都不发生，
         * 而读屏会把它念成一个可去的地方。
         *
         * `aria-label` 里**必须带上屏幕上那串版本号**：只写「更新日志」的话，读屏念的
         * （更新日志）和眼睛看见的（v0.20.0）是两个东西，语音操作说不出这个链接的名字
         * —— 那正是 2.5.3（Label in Name）要挡的。`title` 留着，它只管鼠标悬停那句提示。
         */}
        {compact ? null : pathname === "/changelog" ? (
          <span className="meta -ml-2.5 mt-[3px] flex-none text-ink-faint">{version}</span>
        ) : (
          <Link
            href="/changelog"
            title="更新日志"
            aria-label={`更新日志 ${version}`}
            className="meta -ml-2.5 mt-[3px] flex-none rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
          >
            {version}
          </Link>
        )}

        {/*
         * 主页上这里是空的：「战略议题」四个字挪进了那一屏自己的表头 —— 它是那块板的
         * 标题，不是导航项。这一行只回答「我在哪、怎么回去」，回不去的时候（已经在主页）
         * 就什么都不说。
         *
         * `-ml-2.5` 抵掉它自己的左内边距：那 10px 是给悬停淡底留的呼吸，不该算进
         * 字标到「返回」之间的那 16px 间距里 —— 不抵，两组之间读起来是 26px。
         *
         * 悬停底是 `wash-hover`（半透明），不是 `neutral-wash`（算死的不透明色）。
         * 这四个字坐在桌面上，不在纸上：#f2f2f4 铺在 #f1f1f3 的桌面上是往亮的方向
         * 走 0.4%，悬停等于没有。见 globals.css 里 `--wash-hover` 那段。
         */}
        {home ? null : (
          <Link
            href={back.href}
            /* 矮的那一档只剩箭头。**那句话没丢**：`aria-label` 和 `title` 里仍然是
               「返回战略主页」，读屏念的和悬停看到的都还是「回哪」。 */
            {...(compact ? { "aria-label": `返回${back.name}`, title: `返回${back.name}` } : {})}
            className={cn(
              "flex h-8 flex-none items-center rounded-md text-ink-muted transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink",
              compact ? "-ml-1.5 w-8 justify-center" : "-ml-2.5 gap-1.5 px-2.5 text-base",
            )}
          >
            <ArrowLeft className={compact ? "size-4" : "size-3.5"} aria-hidden />
            {compact ? null : `返回${back.name}`}
          </Link>
        )}

        {issueId ? <IssueHeader id={issueId} /> : null}
        <LogOutButton className="ml-auto flex-none" compact={compact} />
      </div>
    </header>
  );
}
