"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { TianshuMark } from "@/components/brand/tianshu-mark";
import { DomainNav } from "@/components/domain-nav";
import { LogOutButton } from "@/components/log-out-button";
import { APP_VERSION } from "@/lib/changelog";
import { api } from "@/lib/data/client";
import type { Card, DomainSummary, SensorTarget, WithheldItem } from "@/lib/data/types";
import { formatScanCadence, type ScanCadence } from "@/lib/scan/cadence";
import { useResource } from "@/lib/use-resource";

/**
 * 驾驶舱的外壳 —— **左边那一列，和右边那块地方的边框。**
 *
 * ## 为什么它是一个组件
 *
 * 一号位手上有两屏：战略议题（`/`）和已部署（`/deployed`）。两屏之间**左边那一列一个像素
 * 都不动**：同一扇雷达、同一列业务域、同一个字标坐在底边上。换的只有右边那一大块。
 *
 * 那一列因此不能各写一份。写两份的后果不是重复代码，是**两屏之间会漂**：雷达的间距在这
 * 一屏是 16px、在那一屏变成 20px，域列表的选中态在两边慢慢长成两个样子 —— 而这两屏之间
 * 是一次左右切换，任何一处不一致都会被看成「页面跳了一下」。
 *
 * ## 域的选中态由各屏自己拿着
 *
 * 壳不存它。两屏问的问题不一样（「这个域现在有几件事悬着」/「这个域已经交出去几件」），
 * 各自的默认落点也不一样，所以选中哪个域是那一屏的状态，壳只负责把它画出来、把点击交
 * 回去。
 */
/** 左栏那一列算数要的那几样。给全量议题，`ConsoleShell` 自己筛。 */
export type RailIssue = {
  state: string;
  settled: boolean;
  domainId?: string;
  debrief?: unknown;
  slot?: { ended: boolean };
};

export function ConsoleShell({
  /**
   * 哪一屏。**2026-09-03 起不再驱动任何视觉**——切换的高亮由 `IssueColumn` 里
   * `SpaceSwitch` 自己的 `useState` 管，这个字段只用来在 DOM 上留一个 `data-space`
   * 挂钩（见下面渲染那一段），调用方仍然要传，否则类型上分不清这具壳这次是替谁撑着。
   */
  current,
  domains,
  domainId,
  onPickDomain,
  /**
   * **全部议题**，没筛过。左栏那一列的每一个数都由它现算 —— 理由见下面那段。
   */
  issues,
  /**
   * 这一屏该吃多高。默认 `"h-screen"`——`/` 和 `/deployed` 挂在 `(tkos)/layout.tsx`
   * 下面，那层没给内容截出一段高度（`main` 只有 `flex-1`，没有 `min-h-0`），所以这里
   * 必须自己声明"占满整个视口"，不能指望外面给。
   *
   * `/sec/schedule`（`ScheduleView`）是唯一的例外：它嵌在 `SecLayout` 的 `<main>`
   * 里，外面已经有一顶 55px 的品牌栏。如果这里还照旧再拿一次整个视口的 `h-screen`，
   * 这顶栏就会把整版从视口下沿顶出去一截——相一验收时量到的 55px 溢出就是这么来的
   * （`document.scrollingElement.scrollHeight` 比 `window.innerHeight` 多出的
   * 正好是这顶栏的高度）。所以嵌套的这条路传 `"h-full"`，把"到底有多高"交还给
   * `SecLayout`（它的 `main` 用 `min-h-0 flex-1` 把"视口减去顶栏"算成一个确定的
   * 数，这里再用 `h-full` 去吃这一份）。
   *
   * 外层那个 `bg-surface` 容器也要跟着切——`h-full` 依赖百分比高度，而百分比只在
   * 父级给了一个**确定的** height（不是 `min-height`）时才会向下传递；默认路一直用
   * `min-h-full` 是因为它的父级（`main`）本来就没有确定高度，`min-height:100%` 在
   * 那种情况下会被当成 `auto` 处理，纯粹是摆设，不会和这里的 `h-screen` 打架。
   */
  heightClass = "h-screen",
  showLogout = true,
  children,
}: {
  current: "issues" | "deployed";
  domains: DomainSummary[];
  domainId: string;
  onPickDomain: (id: string) => void;
  issues: RailIssue[];
  heightClass?: "h-screen" | "h-full";
  /**
   * 传 `false` 的只有秘书那两屏（`/sec`、`/sec/schedule`）—— 这具壳因此拿它当
   * 「是不是嵌在秘书空间里」的信号。原来这个字段真的会拦住登出按钮（那时秘书的
   * 顶栏自己有一颗）；顶栏 2026-09-03 拆掉之后 `Wordmark` 成了她唯一的登出入口，
   * 不能再拦，见下面 `Wordmark` 已经不再吃这个字段。字段没改名、没删——改名要
   * 动 `schedule-view.tsx` 那一侧的调用，这具壳这次不碰那个文件。
   */
  showLogout?: boolean;
  children: ReactNode;
}) {
  /* 见上面 `showLogout` 的注释：秘书那两屏靠传 `false` 认出自己。 */
  const secretary = !showLogout;
  /*
   * 左栏那一列的数**全部在这里算，一个都不从服务端拿**。
   *
   * 原来「所有议题」那一格用的是这一屏筛出来的在办数，而八个域各自那个数用的是服务端的
   * `DomainSummary.openIssues` —— 两个口径。服务端那一份没有减掉「正等确认会后要点」的
   * 那几件（它们在右栏），于是屏幕上出现过这一幕：`方向与经营选择` 右边写着 1，点进去
   * 中间那一栏是空的。没有报错，没有加载中，就是一个数和一份清单对不上。
   *
   * 一份清单一个口径。同一个 `isLiveIssue` 既决定这一列的数、也决定中间那一栏摆什么，
   * 于是「数字说有一件」和「清单里有一行」在结构上是同一件事，不可能再各说各的。
   */
  const live = issues.filter(isLiveIssue);
  const openOf = new Map<string, number>();
  for (const i of live) {
    if (i.domainId) openOf.set(i.domainId, (openOf.get(i.domainId) ?? 0) + 1);
  }

  return (
    /*
     * 底是白的，右边那块托盘是浅灰的。
     *
     * 全站别的页面是「桌面压暗一档、纸浮上来」；这两屏反过来 —— 页面留白，内容坐在比它
     * 暗一档的托盘上。反过来的理由是这里没有「一张纸」：它是一版排好的面板，而面板的
     * 层次只能靠托盘。`--paper` 那个全站 token 一个字没动，白只铺在这两屏上。
     *
     * `data-space` 挂在这里，不是装饰——`current` 现在不再驱动任何视觉（那份职责
     * 2026-09-03 交给了 `IssueColumn` 里自己管的 `SpaceSwitch`，见那个组件顶部的说明），
     * 但它仍然是「这具壳这一次是替哪一屏撑着」的唯一凭据，留一个能在 DOM 上查到的
     * 挂钩，比让这个参数彻底不落地更便宜。
     */
    <div
      data-space={current}
      className={
        (heightClass === "h-full" ? "h-full bg-surface" : "min-h-full bg-surface") +
        " console-shell"
      }
    >
      {/*
       * 三档全部在 globals.css 里靠媒体查询判（宽/窄且够高/太小），这里只负责把三档
       * 都会用到的东西铺进 DOM——纯 CSS 切换，首帧就落对档，不会有一闪而过的错档。
       * 阈值怎么定的、为什么是这几个数，见 globals.css 里 `.console-shell` 那一段。
       */}
      <div
        className={`console-shell-row relative mx-auto flex ${heightClass} max-w-[1600px] gap-7 px-5 py-4`}
      >
        {/* 左：雷达、八块生意、字标。字标坐在底边上（`mt-auto`）—— 这两屏都没有顶栏。 */}
        <aside className="console-shell-aside flex w-[19.5rem] flex-none flex-col gap-4">
          <RadarPanel />
          <DomainNav
            label="业务域"
            domains={[
              {
                id: ALL_ISSUES,
                code: "",
                name: "所有议题",
                outcome: "",
                driName: "",
                openIssues: live.length,
              },
              ...domains.map((d) => ({ ...d, openIssues: openOf.get(d.id) ?? 0 })),
            ]}
            activeId={domainId}
            onPick={(id) => onPickDomain(id)}
          />
          {/* 域列表和字标之间那段本来空着——秘书两个专属入口原来长在 `SecLayout`
              的顶栏里，顶栏拆掉之后搬到这儿。只在秘书那两屏出现，见 `secretary`。 */}
          {secretary && <SecJobLinks />}
          <div className="mt-auto pt-2">
            <Wordmark />
          </div>
        </aside>

        {/*
         * 这里原来还挂着一个 `pl-9`（36px），是留给中栏左缘那两颗点（`deployed-rail.tsx`，
         * 已删除）的沟：那一栏是常驻在内容前面的一块小白板，不留这段空间的话议题清单的
         * 标题会被它盖住一角。「战略议题 / 已部署」的切换 2026-09-03 挪进了 `IssueColumn`
         * 自己的标题行（见 `SpaceSwitch`），中栏左缘不再有任何常驻的东西要靠这条沟躲开，
         * 那笔账因此清零，`pl-9` 跟着删掉。
         *
         * 外层 `gap-5`（20px）当年是"业务域栏和内容区之间的呼吸"与"给两颗点让出的沟"
         * 两笔账的和（20 + 36 = 56px）。第二笔账没了，第一笔账本身也没有理由维持
         * 原来那么宽——两栏之间只是普通的呼吸，不用再兼职留白，所以缩到大约是原来
         * 一半的 `gap-7`（28px）。
         */}
        <div className="console-shell-content relative min-w-0 flex-1">{children}</div>
      </div>

      {/*
       * 窄且够高那一档要单独出场的只有右栏（各屏自己拼的那个 `<section>` 的最后一个
       * 孩子——首页是动态面板，别的屏是各自那一格），媒体查询直接从这里的类名钩进
       * `.console-shell-content > section` 去改，不用各屏各改一次。
       *
       * 太小那一档不装内容，只留字标和一句话——同样是 CSS 切 `display`，不判断视口。
       */}
      <div className="console-shell-notice hidden h-full flex-col items-center justify-center gap-3 bg-paper px-6 text-center">
        <TianshuMark className="h-8 w-8" />
        <p className="meta text-ink-muted">窗口太小，放大一些再继续。</p>
      </div>
    </div>
  );
}

/**
 * 「所有议题」这一格的 id。它不是一个域 —— 它是**不按域看**。
 *
 * 存在的理由不是方便：一件刚升上来还没派人的战略议题**没有域**（见 `store.ts` 的
 * `disposeCard`），八个域的清单谁都不会显示它。没有这一格，那件事就在屏幕上消失了，
 * 而它恰恰是最需要他动一下的那一件。
 */
export const ALL_ISSUES = "__all__";

/**
 * 「还在我手上」的那一档。**左栏那一格的数由它算，两屏共用同一句。**
 *
 * 它被抽出来是因为它已经飘过一次：首页减掉了正等确认的那几件（它们在右栏，不在议题栏），
 * 已部署那一屏没减，于是同一格同一个词在两屏上是 11 和 13。屏幕上没有任何一处说明这个数
 * 换了口径 —— 他滑一下中栏标题那个开关，数就变了，而变的原因看不出来。
 *
 * 各归各处：`Candidate` 在左上角那扇窗、`settled` 归中栏标题那个开关的「已部署」那一档、
 * **已经提炼出摘要和待办的**在右栏，剩下的才是这一格。
 *
 * ## 判据里为什么没有 `slot.ended`
 *
 * 上一版是「会到点了（`slotPast`）就整场挪进右栏」，理由写的是「一场昨天就该开完的会不该
 * 还摆在接下来要发生的事里」。**那条规则被推翻了**：它把「还没交材料」和「这场会没开」
 * 一起送进了右栏，而在他澄清之前那是同一件事 —— 两种都还没有任何产出，右栏却是一叠等他
 * 过目的卡片。于是右栏里长期摞着几张什么都没有、只写着「等纪要」的卡。
 *
 * 现在的口径：**右栏只装已经有摘要和 checklist 的**（`debrief`）。一场会开完了、材料还没
 * 交，或者压根没开，那几件议题仍然留在这一栏，以「已经排了会」的样子待着 —— 交材料、
 * 标未召开这两个出口就长在那一块上（那块会在提炼跑的时候原地不动，见 `slotIntakeState`）。
 * 上一版担心的「昨天该开的会还写着将来时」由那一块自己说，不靠把它整场搬走。
 */
export const isLiveIssue = (i: {
  state: string;
  settled: boolean;
  debrief?: unknown;
}): boolean => i.state !== "Candidate" && !i.settled && !i.debrief;

/**
 * 字标坐在左列的底边上。
 *
 * 它不再在顶栏里（`StageNav` 在 `/` 上整条不出现）。摆到底边是因为这一屏的注意力从上往下
 * 走：雷达在最上、八块生意在中间、字标在最后 —— 而字标是这三样里唯一不需要他动作的东西。
 * 版本号跟着它，是它的尾注，不是第二组入口。
 *
 * ## 底下那行 `Internal Alpha`
 *
 * 这一版要在公司内部真的被人用，而**用它的人必须知道自己在用什么阶段的东西**：会有没
 * 做完的路、会有还在调的判断、会有今天还对明天就改了的口径。写在字标底下而不是弹一个
 * 横幅：横幅是要被关掉的，关掉之后这件事就没人记得了；字标一直在这一屏的底边上。
 *
 * 它**不是版本号的重复**。版本号答的是「跑的是哪一版」（点得开，进更新日志），这一行
 * 答的是「这东西成熟到什么程度」—— 两个问题，而后者才是他决定要不要照它做决定时问的。
 */
function Wordmark() {
  return (
    <div className="flex items-end justify-between gap-3 px-1">
      <div>
        <div className="flex items-center gap-1.5">
          <Link
            href="/"
            className="engraved flex min-w-0 flex-none items-center gap-1.5 rounded-[3px] transition-opacity duration-fast hover:opacity-90"
          >
            <TianshuMark className="h-[22px] w-[22px] shrink-0" />
            <span className="font-wordmark text-[19px] leading-none tracking-[0.055em]">天枢</span>
          </Link>
          <Link
            href="/changelog"
            className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
          >
            {APP_VERSION}
          </Link>
        </div>
        {/* 齐着字标的左沿（`ml-[1.75rem]` = 标记 22px + 间距 6px），不齐容器左沿 ——
            它是这个名字的下注，不是左列里的第三样东西。 */}
        <p className="text-micro mt-1 ml-[1.75rem] tracking-[0.08em] text-ink-faint">
          Internal Alpha
        </p>
      </div>
      {/* 一直渲染——两屏（一号位/秘书）现在都靠它退出登录，见上面 `showLogout`
          参数的注释。 */}
      <LogOutButton className="-mb-1 flex-none" />
    </div>
  );
}

/**
 * 秘书专属的两个工作入口：编排会议、纪要审阅。原来长在 `SecLayout` 的顶栏里，
 * 那条栏拆掉之后搬进这具壳的左栏——域列表和字标之间那段本来空着。
 */
function SecJobLinks() {
  return (
    <nav aria-label="秘书事务" className="flex flex-col gap-0.5 px-1">
      <Link
        href="/sec/schedule"
        className="meta rounded-[3px] px-0.5 py-1 text-ink-muted transition-colors duration-fast hover:text-ink"
      >
        编排会议
      </Link>
      <Link
        href="/sec/debriefs"
        className="meta rounded-[3px] px-0.5 py-1 text-ink-muted transition-colors duration-fast hover:text-ink"
      >
        纪要审阅
      </Link>
    </nav>
  );
}

/**
 * 雷达。
 *
 * ## 这块小窗从「三条标题 + 一条扫描带」改成了「只有雷达」
 *
 * 上一版把三条潜在议题的标题摆在这里，理由是让他扫一眼就能决定点不点。问题在于
 * 那三条**在 `/signals` 里也有，而且更全**，于是这块小窗成了一份缩水的名单 ——
 * 它占掉了首页左上角最好的位置，换来的是「同样的东西看两遍」。
 *
 * 现在它只回答一个问题：**「现在有人在替我盯着吗」**。这个问题在别处答不了，
 * 而且它是一号位对这个产品最底层的那一点信任。整块是一个按钮，点进去才是名单。
 *
 * ## 「实时感」只能用真东西做
 *
 * 底下那行一闪而过的字，来源只有三种，全部点得开、可核对：
 *
 *   靶点   —— 某次会后确认真的布控下去的 Re-open Trigger
 *   未出卡 —— 今天判断过、认为不值得打扰他的那些（带不出卡理由）
 *   已出卡 —— 今天真的端上来的那几条
 *
 * **绝不出现「正在分析全网资讯」「今日已扫描 1,286 条」这类话。** 编一个没人核得动
 * 的分母，和编一个走到 100% 却什么都不会发生的进度条是同一种错误，而且更隐蔽：
 * 它换来的信任是假的，掉一次就再也补不回来。写错能被指出来，写虚不能。
 *
 * 要如实说的是：这台雷达表达的是「系统在持续盯着这些靶点」，不是「它正在外网抓
 * 东西」。抓取现在**确实接了**（`lib/scan/run.ts`，按靶点策略检索加逐条研判，过线的进
 * `/signals-inbox`），但那不在这一格里 —— 这一格摊的是布控着的靶点。别顺手在这里
 * 加一个「今天抓了 N 条」：那个分母没人核得动，而它换来的信任是假的。
 *
 * ## 光是从上往下的，不是转的
 *
 * 上一版是一个 720px 的雷达盘转在小窗里（波束 + 量程环 + 回波点，圆心压在标题左边那颗
 * 哨兵点上，绝大部分被裁在框外）。它成立，但它把一块 336×102 的横向小窗当成了一个圆形
 * 仪表：**盘的形状和窗的形状不是一回事**，于是四个角永远有一块扫不到，调盘径调了三轮
 * （760 → 420 → 720）都是在跟这件事较劲。
 *
 * 现在光从上沿进来、往下走、从下沿出去 —— 顺着这块窗自己的形状。方向也更对：这一格
 * 底下就是业务域和议题，光往下走是「上面这层扫到的东西往下面流」，转圈是「它在自己那儿
 * 打转」。
 *
 * ## 节拍
 *
 * 扫一趟 4.6s（3.2s 走完 + 1.4s 全暗）、哨兵环 2.3s 一次（正好一半）、**闪现的字由那道
 * 光自己驱动** —— `onAnimationIteration` 就是「刚扫完一趟」这件事本身。用 `setInterval`
 * 也能换，但那是两个独立的钟，跑几分钟就错开，那时它不再像扫到了什么，只像两个凑巧都
 * 在动的东西。减弱动效的人这里自动静止：全局那条 `prefers-reduced-motion` 把动画次数
 * 压成 1 次，`animationiteration` 一次都不会来，字停在第一条；那道光退成一道静止的
 * 顶光（见 globals.css 里 `.scan-light` 在那条查询下的样子）。
 */
function RadarPanel() {
  const pending = useResource<Card[]>("digest:today", () => api.listPending());
  const sensors = useResource<SensorTarget[]>("sensors", () => api.listSensorTargets());
  const withheld = useResource<WithheldItem[]>("withheld:today", () => api.listWithheld());
  const cadence = useResource<ScanCadence>("scan:cadence", () => api.getScanCadence());

  const open = (pending.data ?? []).filter((c) => !c.disposedAs);
  const targets = sensors.data ?? [];
  const seen = withheld.data ?? [];
  /*
   * 「盯着几个靶点」和「实际多久来一轮」拼成一行。哪一半没有就不出现，两半都没有时
   * 这一行整个不渲染 —— 屏幕上没有这一行，本身就说明还没有可说的。
   */
  /*
   * 一轮都没扫过时 `formatScanCadence` 回空串（它的规矩：屏幕上没有这一行，本身就说明
   * 没扫过）。**这一格不能照搬那条规矩** —— 它是整屏上唯一回答「现在有人在替我盯着吗」
   * 的地方，而在这里「什么都不显示」和「这块地方还没做完」长得一模一样。所以缺了就
   * 照实说一句：还没扫过。数还没回来时不说话（那一两百毫秒里断言「还没扫过」可能是假的）。
   */
  const rhythm = cadence.data
    ? formatScanCadence(cadence.data) || "还没扫过"
    : "";
  const radarLine = [targets.length > 0 ? `正在盯 ${targets.length} 个靶点` : "", rhythm]
    .filter(Boolean)
    .join(" · ");

  /*
   * 闪现的那一串。两种来源混在一条时间线上，顺序固定（靶点 → 未出卡），不打乱 ——
   * 打乱之后同一条会隔很久才再出现一次，看起来像卡住了。
   *
   * **「已出卡」那一支删掉了。** 它和标题旁边那个「今日新增 N 个」说的是同一批东西，
   * 而且那几条就摊在点进去的第一屏上 —— 在这一格里再念一遍它们的标题，占掉的是另外
   * 两支的出场机会，而那两支在别处答不了：靶点是「我替你盯着什么」，未出卡是「我替你
   * 挡了什么」。这一格的全部意义是回答「现在有人在替我盯着吗」，不是预览清单。
   */
  const lines: { kind: string; text: string }[] = [
    ...targets.map((t) => ({ kind: "靶点", text: t.text })),
    ...seen.map((w) => ({ kind: "未出卡", text: w.line })),
  ];
  const [i, setI] = useState(0);
  const line = lines.length > 0 ? lines[i % lines.length] : null;

  return (
    <Link
      href="/signals"
      aria-label={`潜在议题，今日 ${open.length} 条`}
      /*
       * 深底，而且是玻璃。
       *
       * 整屏只有这一块不是纸 —— 它是**感知层**，和它下面那些「在办的事」不是一类
       * 东西。用底色说出来，比用标题说出来快一个量级：眼睛先看到色块，才读到字。
       *
       * 深底还有一个附带的好处：光在浅底上是一块周期性变暗的灰，在深底上它是**发光**
       * 的 —— 后者才是「有东西在扫」。
       *
       * 玻璃（`.glass-panel`）而不是实心面：实心面读起来是一块贴上去的深色板，边界硬、
       * 和它坐着的那张纸没有关系。为什么是 90% 而不是更透、通透感到底由什么承担，
       * 全部写在 globals.css 里 `.glass-panel` 那一段。
       *
       * `.dither` 是配套的，不是可选项：面上那道洗光和走过去那道扫光都是极微妙的
       * 长渐变，8 位 sRGB 下必然起带（**越微妙越会起带**，而微妙正是这里想要的）。
       * 2.5% 的噪点把等高线打断。
       */
      /*
       * 扫光的钟挂在这块面上，不挂在那道光自己身上 —— 面上有两层要听同一个
       * `--scan-y`（光、回波点），钟在根上它们才不用各自对相位。理由写在 globals.css
       * 里 `@property --scan-y` 那一段。
       */
      onAnimationIteration={(e) => {
        /*
         * 只认这块面自己那一趟扫光。
         *
         * `animationiteration` 是冒泡的，而这块面里还有一个哨兵环在跳（2.3s 一次，
         * 正好是扫光的一半）—— 不挡住的话闪现的那一行会被它带着走两倍快，而那时它
         * 和屏幕上那道光已经没有关系了。只有根上挂着扫光，所以判据是「事件源就是
         * 这块面本身」，不用去认动画名。
         */
        if (e.target !== e.currentTarget) return;
        if (lines.length > 1) setI((n) => n + 1);
      }}
      className="glass-panel dither animate-scan group relative block overflow-hidden rounded-2xl"
    >
      {/* 走过去的那道光，和只在被它扫到时才亮的那片回波点。两层都吃根上那个
          `--scan-y`，所以永远在同一条线上；几何全部在 CSS 里（`inset: 0`），
          这里不给尺寸 —— 上一版那个 720px 的盘要在这里算半径，就是因为圆形的
          几何和这块横向小窗对不上。 */}
      <span aria-hidden className="scan-light" />
      <span aria-hidden className="scan-echo" />
      {/* 指针压上来时提亮的那一片，同一个方向的光。平时不占任何东西。 */}
      {/* 时长写成 `duration-[var(--dur-slow)]` 而不是 `duration-slow`：查过编译出来的
          样式表，`.duration-fast/-slow` 这类**根本没有生成** —— Tailwind v4 的
          `duration-*` 认的是 `--transition-duration-*` 那个命名空间，而这套 token 叫
          `--dur-*`。全站上百处都在写 `duration-fast`，实际吃的是默认的 150ms。
          那一片要单独修（改 token 映射会一次动到上百个元素的节拍），这里先只保证
          这一处真的是 320ms —— 光要慢，慢是它不催人的全部原因。 */}
      <span
        aria-hidden
        className="glass-lift opacity-0 transition-opacity duration-[var(--dur-slow)] ease-swift group-hover:opacity-100"
      />

      <div className="relative px-4 py-3">
        <p className="flex items-center gap-2">
          <span aria-hidden className="relative flex size-1.5 shrink-0 items-center justify-center">
            <span className="animate-sentinel absolute size-1.5 rounded-full bg-factual" />
            <span className="relative size-1.5 rounded-full bg-factual" />
          </span>
          <span className="text-md font-medium text-solid-fg">潜在议题</span>
          {open.length > 0 && (
            <span className="meta text-solid-fg/55">今日新增 {open.length} 个</span>
          )}
        </p>

        {/*
         * 这里原来还写着「今天筛过 N 条」。它和标题旁边那个数说的是同一件事，
         * 一行之内出现两次 —— 删掉，只留下别处答不了的那一个：盯着几个靶点。
         *
         * 后半句原来是手写的「每天自动检测」，三个页面各抄一份，背后没有任何数据 ——
         * 抓取那一侧改了定时，这三处一个字都不会变。现在它是**算出来的**：台账上真发生过
         * 几轮自动扫描、隔多久来一轮、上一轮多久以前（`scanCadence`）。他要确认的
         * 「不按那个键它自己也会转」，由这几个数字自己回答；对面停摆时它也会跟着说实话。
         *
         * 措辞只有一处出处（`formatScanCadence`），三个页面都调它。
         */}
        {radarLine && <p className="meta mt-2 pl-3.5 text-solid-fg/75">{radarLine}</p>}

        {/*
         * 一闪而过的那一行。
         *
         * `key` 换掉整个节点，`animate-fade` 才会重放 —— 原地换字在余光里是一次
         * 闪烁，淡进来才是一次翻页。截断而不换行：这一行的作用是让他**瞥见**系统
         * 在看具体的东西，不是让他读完。真要读，点进去。
         */}
        <p className="mt-1.5 h-[1.15rem] pl-3.5">
          {line && (
            <span
              key={`${i}-${line.text}`}
              className="animate-fade meta block truncate text-solid-fg/50"
              title={line.text}
            >
              {/* 满色，不再 `/80`：玻璃化之后合成底从 #17171b 抬到 #2d2d31，
                  `factual/80` 在新底上是 3.97:1，破 4.5。满色是 5.35。 */}
              <span className="mr-1.5 text-factual">{line.kind}</span>
              {line.text}
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* 中：议题卡                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 一件在办的战略议题。
 *
 * 版面只用**两级字**：一行 15px 的标题，其余全是 12px 的元数据。上一版标题是 17px，
 * 和左右两栏的面板标题一样响 —— 一屏上四五处同样大的字，读起来像手抄报，谁也不比谁
 * 重要。这里的层级靠位置和颜色做，不靠字号。
 *
 * ## 一列，从上往下读（2026-08-27 改的）
 *
 * 上一版是左右两半：左半「这件事是什么」，右半「两份研究各自的状态」。分栏的代价是
 * **进度跑到了第二眼**：整块最要紧的一行（机器此刻在跑第几步）被塞进右边一条
 * 11.5rem 宽的窄格，字挤成两行，而标题底下那一行却让给了「进入议题研究 →」——
 * 一句整块都点得进去、根本不用写出来的话。
 *
 * 现在是一列：
 *
 *   编号 + 一颗小牌   小牌写「今日添加 / N 天前添加」。日子是这一件的出身，跟编号是
 *                     同一类东西（哪来的、什么时候来的），所以并在第一行，不占正文。
 *   标题
 *   深研进度          `● 正在分层成稿 · 第 6/7 步 · 已 29 分 09 秒`。整块的第一眼。
 *   承接研究          只在人那份**真有话说**的时候出现（等谁回传 / 已回传）。
 *   域 / DRI + 事实   `● 未指派DRI · 对谈 3 轮 · 判断待确认 2 条`，全是算出来的数，
 *                     不写「进展顺利」这种没法核对的话。
 *
 * 右边只剩会议那一颗，和一条竖发丝线把它隔开 —— 那一颗是**动作**，不是状态，
 * 混在这一列里读起来会像第六行字。
 *
 * 「承接研究 · 未指派」这一句是同一天删的：它和这一列最后那行的「未指派DRI」说的是
 * 同一件事（这件事此刻没有主人），来源不同不构成在一块 100px 高的东西上写两遍的理由。
 * 留下的是 DRI 那一句 —— 他要派的是人，不是「承接研究」这个动作。
 */
