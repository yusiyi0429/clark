"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { agendaCompareBy, slotLabel, UNRANKED } from "@/lib/data/agenda";
import { api, ApiError } from "@/lib/data/client";
import type {
  DomainSummary,
  IssueSummary,
  SlotIntakeState,
  TimelineEvent,
} from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";
import { INTAKE_SENDING, MeetingIntake, MeetingIntakeTrigger } from "./meeting-intake";
import { ResearchStatusLine } from "./research-line";
import { type Space, SpaceSwitch } from "./space-switch";
import { meetStyle } from "./tone";

/**
 * 议题栏 —— 首页右半屏的左边一列。
 *
 * ## 一份清单，两种东西
 *
 * 上一版把「已排会」和「研究中」分成两档滑块，切过去才看得见另一档。那是错的：一号位在
 * 这一栏上问的是**「我手上现在有哪些事，哪几件已经定了时间」**，而那是一个问题，不是两个。
 * 所以它们在同一份清单里，靠画法分开：
 *
 *   定了时间的   深色实心重块，浅色字，排在最前
 *   还在研究的   纸色轻块，墨色字
 *
 * 一屏扫下来先看到的是那几块深色 —— 那正是接下来要发生的事。
 *
 * ## 同一场会并成一块
 *
 * 同一场会的几件议题在这一栏里是**一块**：一条抬头（时间 · 到场的域 · 件数）加几行议题，
 * 中间只隔一条亮一档的细线。不是几张挨着的卡片 —— 挨着只说明「相邻」，并成一块才说明
 * 「它们被同一件事绑着」。
 *
 * ## 一场会待到**它办完为止**，不是到点就走
 *
 * 中间改过一版：会一到点就整场挪到右边那一栏，在那儿挂着「上传纪要 / 未召开」。那是错的，
 * 而错在哪儿一句话说得清 —— **那时这场会还什么都没发生**。到点只是时钟走过去了，纪要
 * 还没交、要点还没提炼出来；把它挪走等于在他还欠这场会一件事的时候，从「我手上有哪些事」
 * 那份清单里把它抹掉了。
 *
 * 所以三个出口（开始会议 / 上传录音或文字纪要 / 未召开）挪回这一块上，而这几件议题一直
 * 待在这一栏里，直到摘要和 checklist 生成完毕才走。**走那一下不由这里判断**：归属的判据
 * 在数据层（这一栏只画 `home-view` 递进来的那一份），所以跑完之后这几件自己就不在了。
 *
 * 「编排会议」那颗键 2026-09-02 撤了：排会搬去秘书那一侧（`/sec/schedule`）。
 * 不是隐藏 —— 一号位那一侧此刻没有这个动作，留一颗点了会跳出自己空间的键，
 * 比没有这颗键更难解释。
 *
 * ## 抬头那句「议题」换成了一个滑块（2026-09-03）
 *
 * 中栏左缘原来常驻着两颗点（`deployed-rail.tsx`，已删除），点开才看得见「战略议题 /
 * 已部署」这两个名字。那个做法的出发点是「标题这一排已经被『议题』两个字占满，容不下
 * 第二样东西」——而这句话本身站不住：「议题」是一句不接受任何交互的报幕，标题那一排
 * 真正被占用的只有版面，不是注意力。所以这一版直接把切换开关摆在报幕原来的位置上
 * （`SpaceSwitch`），不新增面积，也就不用再靠"收起来才是两个点"去省预算——开关整段
 * 常驻可见，理由和它现在的画法一起写在 `space-switch.tsx` 里。
 *
 * 切到「已部署」换的**只有下面这块可滚动的清单**，不离开这条路由：`lead`（刚粘进来
 * 还没立起来的那一件）和 `footer`（+ 创建新议题）都是「战略议题」这一档专属的动作，
 * 切走之后连着收起——它们问的是"现在要不要往这份清单里加一件"，而已部署那一档不接受
 * 新增。清单区用 `key={space}` 强制 React 在切换时重新挂载这一层，让 `.animate-panel`
 * 的入场动效重放一遍（同一个机制见 `panel.tsx` 顶部注释）：他按下开关时应该先看见"这一块
 * 刚刚换过一次"，再看见新内容，而不是硬切。
 */
export function IssueColumn({
  issues,
  domains,
  today,
  lead,
  footer,
  deployedCount,
  interactive = false,
  onOpenMeeting,
}: {
  /** 这一栏要显示的议题（已经按域筛过了）。只在「战略议题」那一档下用。 */
  issues: IssueSummary[];
  /** 域的名字表，用来把抬头上那几枚域标写出来。 */
  domains: DomainSummary[];
  today: string;
  /** 摆在清单最前面、不属于清单的那一块（他刚粘进来还没立起来的那一件）。 */
  lead?: ReactNode;
  /** 钉在这一栏底边上的那一条。**在清单外面，所以它不跟着清单一起变。** */
  footer?: ReactNode;
  /**
   * 已部署有几件。**只有开关上「已部署」那一格用它**——传进来的 `issues` 已经是
   * `home-view` 按「在办」筛过的那一份，已部署的那几件根本不在里面，这一栏自己
   * 算不出这个数，只能由调用方给（口径见 `ConsoleShell` 里同名的算法）。
   */
  deployedCount: number;
  /**
   * 会议卡要不要带开始会议 / 上传纪要 / 未召开那三颗键。
   *
   * 默认 `false`——一号位那一侧的卡是纯展示，点开是查看会议详情（`onOpenMeeting`）。
   * 排会、审纪要是秘书的活，`SecHomeView` 传 `interactive` 开回原来那三颗键。
   */
  interactive?: boolean;
  /** 一号位那一侧点开会议卡：把 slotId 交给外面，让动态面板滑出详情 sheet。 */
  onOpenMeeting?: (slotId: string) => void;
}) {
  /*
   * 「现在看哪一屏」是这一栏自己的状态，不上交给 `HomeView`——左栏和右边的动态面板
   * 都不需要知道这件事（那正是「只换中栏」这条要求本身），把它往上交只会多一层不必要
   * 的状态提升。
   */
  const [space, setSpace] = useState<Space>("issues");

  const rank = useMemo(() => {
    const m = new Map(issues.map((i) => [i.id, i.agendaRank] as const));
    return (id: string) => m.get(id) ?? UNRANKED;
  }, [issues]);
  const groups = useMemo(
    () => toGroups([...issues].sort(agendaCompareBy(rank))),
    [issues, rank],
  );
  const domainName = useMemo(() => {
    const m = new Map(domains.map((d) => [d.id, d.name] as const));
    return (id: string) => m.get(id);
  }, [domains]);

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
      <header className="flex h-10 items-center px-1">
        <div className="mx-auto">
          <SpaceSwitch value={space} onChange={setSpace} deployedCount={deployedCount} />
        </div>
      </header>

      {space === "issues" ? (
        <div
          key="issues"
          className="animate-panel scroll-slim min-h-0 space-y-2 overflow-y-auto p-2 [--p:0.5rem]"
        >
          {lead}
          {groups.length === 0 && !lead ? (
            <p className="meta px-1 py-2 text-ink-faint">这里现在是空的。</p>
          ) : (
            groups.map((g) =>
              g.kind === "slot" ? (
                <SlotBlock
                  key={g.key}
                  group={g}
                  today={today}
                  domainName={domainName}
                  interactive={interactive}
                  onOpenMeeting={onOpenMeeting}
                />
              ) : (
                <PlainCard key={g.key} issue={g.issue} />
              ),
            )
          )}
        </div>
      ) : (
        <div key="deployed" className="animate-panel min-h-0 overflow-y-auto p-2">
          <DeployedEmptyState />
        </div>
      )}

      {/* 底边那一条。在清单外面，所以切域、清单变长变短都不动它；切到「已部署」时连着收起 ——
          它是「往清单里加一件」的入口，已部署那一档不接受新增。 */}
      {space === "issues" && footer ? <div className="px-3 pt-2 pb-3">{footer}</div> : null}
    </div>
  );
}

/**
 * 「已部署」在中栏里的占位。**这一屏还没设计**，这里只放一句安静的话，不摆假数据、
 * 不画一份猜出来的布局。
 *
 * 写下来的这一句话是那一屏将来的组织原则，不是随手的空状态文案：**每一件议题都服务于
 * 某一条 mission**，已部署议题在这里要看的不是「它是什么」（那件事在定下来的时候已经
 * 说完），而是**它所服务的那条 mission 走到哪了**。真正的已部署视图落地时，这里排的
 * 该是 mission 的进度，不是重新照抄一份议题清单（`DeployedPane`/`deployed-view.tsx`
 * 那条独立路由已经是"照抄清单"这个做法的完整实现，仍然可达——这里不重复它，是给将来
 * 那个按 mission 组织的视图留位置）。
 */
function DeployedEmptyState() {
  return (
    <div className="flex h-full min-h-[12rem] items-center justify-center px-6 text-center">
      <p className="meta max-w-[22rem] text-ink-faint">
        已部署的议题和它们各自服务的 mission，将来会摊开在这里——看的是 mission 走到哪了，
        不是重新读一遍议题本身。
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 一场会 —— 一块                                                              */
/* -------------------------------------------------------------------------- */

function SlotBlock({
  group,
  today,
  domainName,
  interactive,
  onOpenMeeting,
}: {
  group: SlotGroup;
  today: string;
  domainName: (id: string) => string | undefined;
  interactive?: boolean;
  onOpenMeeting?: (slotId: string) => void;
}) {
  if (!interactive) {
    return (
      <ReadOnlySlotCard
        group={group}
        today={today}
        domainName={domainName}
        onOpenMeeting={onOpenMeeting}
      />
    );
  }
  return <EditableSlotCard group={group} today={today} domainName={domainName} />;
}

/**
 * 一号位那一侧的会议卡 —— 纯展示，没有开始会议 / 上传纪要 / 未召开三颗键。
 *
 * 点开这整块（而不是某一件议题）交给 `onOpenMeeting`：一号位这一屏要看的是「这场会
 * 谈什么、谈过没有」，不是逐件议题的详情，所以点击目标是整场会，去处是右栏那扇详情
 * sheet（`dynamic-panel.tsx` 的 `MeetingSheetContainer`），不是 `/issues/<id>`。
 */
function ReadOnlySlotCard({
  group,
  today,
  domainName,
  onOpenMeeting,
}: {
  group: SlotGroup;
  today: string;
  domainName: (id: string) => string | undefined;
  onOpenMeeting?: (slotId: string) => void;
}) {
  const head = group.issues[0].slot!;
  const attending = attendingOf(group, domainName);

  return (
    <button
      type="button"
      style={meetStyle(head.seq)}
      onClick={() => onOpenMeeting?.(head.slotId)}
      className="meet-face dither concentric block w-full overflow-hidden text-left"
      aria-label={`${slotLabel(head, today)}的会议 · 查看详情`}
    >
      <header className="relative flex items-baseline gap-2 px-3.5 pt-2.5 pb-2">
        <span className="shrink-0 text-sm font-medium whitespace-nowrap [color:var(--meet-fg)]">
          {slotLabel(head, today)}
        </span>
        {attending.length > 0 && (
          <span className="meta min-w-0 truncate [color:var(--meet-fg-dim)]">
            {attending.join(" · ")}
          </span>
        )}
        <span className="meta shrink-0 whitespace-nowrap [color:var(--meet-fg-dim)]">
          {group.issues.length} 件
        </span>
      </header>
      <div className="relative space-y-1.5 px-3.5 pb-3">
        {group.issues.map((issue) => (
          <ReadOnlyTopicRow key={issue.id} issue={issue} />
        ))}
      </div>
    </button>
  );
}

/** 会议卡上的一件议题：编号、标题、这是第几次讨论它（第几次讨论取不到就不写这一格）。 */
function ReadOnlyTopicRow({ issue }: { issue: IssueSummary }) {
  const round = useDiscussionRound(issue.id);
  return (
    <p className="flex items-baseline gap-2">
      <span className="meta shrink-0 [color:var(--meet-fg-dim)]">{issue.id}</span>
      <span className="clamp-1 min-w-0 flex-1 text-sm leading-relaxed [color:var(--meet-fg)]">
        {issue.title}
      </span>
      {round !== null ? (
        <span className="meta shrink-0 whitespace-nowrap [color:var(--meet-fg-dim)]">
          第 {round} 次讨论
        </span>
      ) : null}
    </p>
  );
}

/**
 * 这件议题此刻要开的这场会，是第几次讨论它。
 *
 * 数的是时间线上真落过的会后提炼（`E-<issueId>-debrief-<slotId>`，见 `store.ts` 的
 * `extractAndLandDebriefs`）——每场真正开完、材料也提炼完的会各留一条，同一个 slotId
 * 不会重复。数不到（时间线还没取回来）就不显示这一格，不给默认成「第一次」那种猜测。
 */
function useDiscussionRound(issueId: string): number | null {
  const res = useResource<TimelineEvent[]>(`timeline:${issueId}`, () =>
    api.getTimeline(issueId),
  );
  if (!res.data) return null;
  const marker = `E-${issueId}-debrief-`;
  return res.data.filter((e) => e.id.startsWith(marker)).length + 1;
}

/** 到场的域，从这一块上的议题算出来（`domainsOfSlot` 那条规则的屏幕这一侧）。 */
function attendingOf(
  group: SlotGroup,
  domainName: (id: string) => string | undefined,
): string[] {
  return [...new Set(group.issues.map((i) => i.domainId).filter(Boolean) as string[])]
    .map(domainName)
    .filter(Boolean) as string[];
}

/** 秘书那一侧的会议卡 —— 开始会议 / 上传纪要 / 未召开原样照旧。 */
function EditableSlotCard({
  group,
  today,
  domainName,
}: {
  group: SlotGroup;
  today: string;
  domainName: (id: string) => string | undefined;
}) {
  const head = group.issues[0].slot!;
  const attending = attendingOf(group, domainName);

  const invalidate = useInvalidate();
  /**
   * 他刚交的那一份还在路上。
   *
   * 这一档由本地这一侧说，不等服务端：从松手到服务端记上这件事之间有一段空窗，那段里
   * 问状态问回来的还是「什么都没在办」，而屏幕上这一块此刻要是不变，看起来就是那一下
   * 没按上。所以两个来源合起来用（见下面的 `working`）。
   */
  const [handing, setHanding] = useState(false);
  const intake = useSlotIntake(head.slotId, handing);

  /** 交材料那一格展开着没有。键在右上角，格子铺在卡片底下（见 `MeetingIntake`）。 */
  const [intakeOpen, setIntakeOpen] = useState(false);
  /** 「未召开」的第一下。第二下才真撤。 */
  const [arming, setArming] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<string | null>(null);

  /** 这一块此刻正在办这份材料 —— 底流动，三颗键收起来。 */
  const working =
    handing || intake.status === "checking" || intake.status === "summarizing";
  /** 停下来了，而且没成。原话摆出来，三颗键回来 —— 他要能重传一份。 */
  const stopped = intake.status === "rejected" || intake.status === "failed";

  return (
    <section
      style={meetStyle(head.seq)}
      className="meet-face dither concentric overflow-hidden"
      aria-label={`${slotLabel(head, today)}的会议`}
      /*
       * 三处「按错了就把手移开」共用这一个 —— `onMouseLeave` 挂在**这一层**，不是各自
       * 的按钮上（同 `RemoveIssue` 那处的理由）：挂在按钮上的话，第一下按完指针只要蹭出
       * 边一个像素就收了回去，于是第二下按的又是「未召开」，他会觉得这颗键按不动。
       */
      onMouseLeave={() => {
        setArming(false);
        setCancelFailure(null);
      }}
    >
      {/*
       * 正在办的时候，这一块的**底**变成流动的马赛克（`.mosaic-flow`，globals.css）。
       *
       * 它是绝对定位的一层，所以下面每一段内容都得自己 `relative` 才压得住它 ——
       * 定位过的元素画在普通流内容的上面，不这么办的话马赛克会盖在议题标题上。
       * 另一条路是给这一块 `isolation: isolate` 再把马赛克压成负层级，没走：那会把
       * `.dither` 那层 `mix-blend-mode` 的合成组也一起改掉，为了一个层级动一层混色不划算。
       */}
      {working ? <div aria-hidden className="mosaic-flow" /> : null}

      {/*
       * 抬头。**两颗办事的键收在这一行的右端。**
       *
       * 它们从前和「开始会议」并排站在卡片底下 —— 三颗一样轻的字，而其中一颗是他九成
       * 情况下要按的那一颗。并排等于让他每次都要读完三个词再挑一个。交材料和撤会都是
       * **例外路径**（会开完了才补材料、这场会没开成），例外路径归位到角上。
       */}
      <header className="relative flex items-baseline gap-2 px-3.5 pt-2.5 pb-2">
        <span className="shrink-0 text-sm font-medium whitespace-nowrap [color:var(--meet-fg)]">
          {slotLabel(head, today)}
        </span>
        {attending.length > 0 && (
          <span className="meta min-w-0 truncate [color:var(--meet-fg-dim)]">
            {attending.join(" · ")}
          </span>
        )}
        <span className="meta shrink-0 whitespace-nowrap [color:var(--meet-fg-dim)]">
          {group.issues.length} 件
        </span>
        {/*
         * 正在办的时候把这两颗**收起来而不是不渲染**（`hidden` = display:none）。
         * 那一份材料是 `MeetingIntake` 自己发出去的请求，把它从树上摘掉等于把那个请求
         * 的落地扔了 —— 没人收 `onDone`，也没人把「不办了」说回来，这一块会一直流。
         */}
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-3",
            working && "invisible",
          )}
        >
          {/*
           * 角上这一颗只写四个字。**全称留在 `title` 上** —— 「上传会议录音/文本纪要」
           * 十一个字摆在这一行里，会把时间那几个字挤到第二行去（量过：卡片宽 290px
           * 装不下）。而这颗键是例外路径，它不值得让抬头折行。
           */}
          <MeetingIntakeTrigger
            open={intakeOpen}
            onToggle={() => setIntakeOpen((on) => !on)}
            label="上传纪要"
            title="上传会议录音 / 文本纪要"
          />
          <CancelSlot
            slotId={head.slotId}
            arming={arming}
            onArm={setArming}
            onFailure={setCancelFailure}
          />
        </span>
      </header>

      {/*
       * 会上要谈的那几件 —— **一份名单，不是一叠入口。**
       *
       * 从前每一件是一个铺满整行的 `<Link>`：一块能点的面、一块 hover 时会亮起来的底、
       * 一行 `text-md` 的标题。三样都在说「这里可以点进去」，而他站在这张卡前面要做的事
       * 只有一件 —— 开会。那几件议题此刻的职责是**告诉他这场会要谈什么**，它们是这张卡的
       * 说明文字，不是这张卡的出口。
       *
       * 所以整行不再可点，字压到 `--meet-fg-dim` 那一档；只有编号那几个字符还是链接 ——
       * 去看某一件的详情仍然走得通，但那个点击区从「整行」缩到「六个字符」。缩，不是删：
       * 删掉的话，他要从别处再找回这件议题，而它明明就在眼前。
       */}
      <div className="relative space-y-1 px-3.5 pb-2.5">
        {group.issues.map((issue) => (
          <p key={issue.id} className="flex items-baseline gap-2">
            <Link
              href={`/issues/${issue.id}`}
              className="meta shrink-0 rounded-[3px] underline decoration-current/25 underline-offset-4 transition-colors duration-fast [color:var(--meet-fg-dim)] hover:[color:var(--meet-fg)]"
            >
              {issue.id}
            </Link>
            <span className="clamp-1 text-sm leading-relaxed [color:var(--meet-fg-dim)]">
              {issue.title}
            </span>
          </p>
        ))}
      </div>

      {/*
       * 交材料那一路要说的话，以及那一格本身。**只在真有话说时才占位** ——
       * 空着的时候这一层根本不渲染，下面那条浅色带因此直接贴着议题名单。
       *
       * 注意 `working` 也在这个条件里：那一份材料是 `MeetingIntake` 自己发出去的请求，
       * 把它从树上摘掉等于把那个请求的落地扔了（没人收 `onDone`）。失败那一档 `intakeOpen`
       * 仍然是 true（只有交成了才收），所以它写的那句原话也留得住。
       */}
      {working || stopped || intakeOpen || cancelFailure ? (
      <div className="relative px-3.5 pt-1 pb-3">
        {working ? <WorkingLine status={intake.status} name={intake.name} /> : null}

        {stopped ? (
          /*
           * 模型/服务端的**原话**，一个字不改地摆在这一块上。
           *
           * 这里不写「处理失败，请重试」那一类话：那句话对读的人只有「坏了」这一个信息，
           * 而真正的那句多半是「这份录音只有背景噪声」或者「这份文字里没有一件能对上
           * 议题的事」—— 他据此决定重传哪一份，或者干脆改成贴文字。
           */
          <p
            role="alert"
            className="mb-2 text-sm leading-relaxed [color:var(--meet-fg)]"
          >
            {intake.reason ?? "这一份没处理成，服务端没说为什么。"}
          </p>
        ) : null}

        {/* 交材料那一格。展开时它**顶掉**下面那颗大键 —— 他此刻在办的是另一件事。 */}
        <MeetingIntake
          slotId={head.slotId}
          open={intakeOpen}
          onClose={() => setIntakeOpen(false)}
          onBusyChange={setHanding}
          /*
           * 交完让清单重新去问一次。列这两个 key 是为了**不清空它们**：清空会让外面
           * 那层边界掉回骨架，把他正在看的这一栏整个重挂一遍（见 `useInvalidate`）。
           */
          onDone={async () => invalidate("issues", "slots")}
          className="mb-1"
        />

        {cancelFailure ? (
          <p role="alert" className="meta mt-2 [color:var(--meet-fg)]">
            {cancelFailure}
          </p>
        ) : null}
      </div>
      ) : null}

      {/*
       * 卡片下半张 —— **一整块「开始会议」，无边。**
       *
       * 这张卡在首页上只回答一个问题：*这场会，现在开不开。* 从前答它的是一颗和另外两颗
       * 并排的、带下划线的小字，占这张卡不到一成的面积；而它是这里唯一一件正事。
       *
       * ## 为什么是无边，不是一颗躺在卡里的键
       *
       * 一颗四周留白、自己带圆角的键，读起来是「这张卡上放着一个控件」；而它要说的是
       * **这张卡的下半部分就是这个动作**。所以它左右下三边直接贴到卡沿（圆角由外面那层
       * `overflow-hidden` 裁），上沿是一条明确的分界 —— 一块面接着另一块面，中间没有缝。
       *
       * ## 颜色是同一档会色兑白，不是另一个颜色
       *
       * `color-mix(var(--meet) 75%, white)`。**75 这个数是量出来的**：白字压在它上面，
       * 四个色档 × 明暗两套主题，最差的一档 4.80（80% 那一档是 5.46 但已经太接近卡面，
       * 分不出是两块面；72% 掉到 4.46，过不了 4.5）。所以一场会换一档色它自己跟着换，
       * 而不是在这里写死一个蓝。
       *
       * ## 那点光感
       *
       * 上浅下深的微弱竖向渐变（73%→82%，跟卡面那道同一个方向 —— 光源只有一个），
       * 加一道接光的上棱（`inset` 一条白）。悬停时**只把那道棱提亮**，不动底色：
       * 底色一提亮，白字的对比度就掉到 4.5 以下，而一个只在悬停时读不清的按钮，
       * 排查起来比一直读不清更难。
       */}
      {!working && !intakeOpen ? (
        <Link
          href={`/meetings/${head.slotId}/live`}
          /* 5.5rem = 88px。量过：这张卡（两件议题）抬头以下共 160px，这一块占 55%。 */
          className={cn(
            "meet-start relative flex min-h-[5.5rem] w-full items-center justify-center",
            "text-lg font-medium tracking-[0.02em] [color:var(--meet-fg)]",
          )}
        >
          开始会议
        </Link>
      ) : null}
    </section>
  );
}

/**
 * 此刻在办什么 —— **一行照实说的话，两档分得开。**
 *
 * 「正在看这份材料能不能用」和「正在按议题提炼」是两件不同的事：前一段还可能把这份材料
 * 退回来（那时三颗键会回来），后一段已经在写他要读的东西了。用同一句话盖住这两段，等于
 * 让他在第一段结束前一直以为提炼已经开始。
 *
 * **这里不写「正在智能分析」那一类话。** 那种句子核不动 —— 屏幕上说的每一句都要对得上
 * 服务端此刻真在做的那一件事。
 *
 * 这一行不动（不挂 `.sweeping-text` 那道扫光）：它底下那块马赛克已经在流了，一块在流的底
 * 加一行在扫光的字，是两个东西各自在动，读起来像两件事。
 */
function WorkingLine({
  status,
  name,
}: {
  status: SlotIntakeState["status"];
  name?: string;
}) {
  const line =
    status === "checking"
      ? "正在看这份材料能不能用"
      : status === "summarizing"
        ? "正在按议题提炼"
        : /*
           * 服务端还没接手的那一段：那一份还在 `MeetingIntake` 那条请求里（贴的文字是
           * 一瞬间，录音要在这一步转成文字，可以是几分钟）。这句话跟那一格说的是同一句，
           * 所以从那边取，不在这里抄第二份。
           */
          INTAKE_SENDING;

  return (
    <p className="meta mb-2 [color:var(--meet-fg)]" aria-live="polite">
      {line}
      {name ? <span className="[color:var(--meet-fg-dim)]"> · {name}</span> : null}
    </p>
  );
}

/**
 * 未召开 —— **按两下才撤。**
 *
 * 这一下会把整场会从账上抹掉（那几件议题原样回到清单里），而它就挨着「上传录音」——
 * 手滑一次的代价是那几件议题的排会记录全没了，而屏幕上不会有任何东西提示他刚撤掉了什么。
 * 所以第一下只把字换成「确定撤掉」，第二下才真撤；退回去那一下由外面那一层的
 * `onMouseLeave` 管（理由写在那儿）。
 *
 * 撤不掉的时候要说出为什么：服务端会挡下「这场会已经有纪要了」（见 `store.cancelMeetingSlot`），
 * 那句话得原样摆到他眼前 —— 只说「没撤掉」他会以为这颗键坏了。
 */
function CancelSlot({
  slotId,
  arming,
  onArm,
  onFailure,
}: {
  slotId: string;
  arming: boolean;
  onArm: (armed: boolean) => void;
  onFailure: (message: string | null) => void;
}) {
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!arming) {
          onArm(true);
          return;
        }
        onArm(false);
        setBusy(true);
        onFailure(null);
        void api
          .cancelMeetingSlot(slotId)
          .then(() => invalidate("issues", "slots"))
          .catch((err: unknown) => {
            onFailure(err instanceof ApiError ? err.message : "这一场没撤掉。");
          })
          .finally(() => setBusy(false));
      }}
      className={cn(
        "meta rounded-[3px] underline decoration-current/40 underline-offset-4 transition-colors duration-fast",
        arming ? "[color:var(--meet-fg)]" : "meet-btn-quiet",
      )}
    >
      {busy ? "撤销中…" : arming ? "确定撤掉" : "未召开"}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* 交上去那一份走到哪儿了                                                       */
/* -------------------------------------------------------------------------- */

/** 几秒问一次。够快到看得出它在走，又不至于一屏几块会各自每秒敲一次。 */
const POLL_MS = 3000;
/** 连着这么多次问不到就不问了。一直问下去的话，服务端真塌了这一块会永远流着。 */
const GIVE_UP_AFTER = 5;

/**
 * 轮询这一场会的材料处理到哪一步。
 *
 * ## 为什么挂载就问一次
 *
 * 他刷新页面、或者昨天传完今天再打开，这一块要是不问就只能显示三颗键 —— 而那份材料
 * 可能正在提炼。这一问是一次读，不起模型，代价只有一个请求。
 *
 * ## 为什么只在「还在办」时接着问
 *
 * `useResource` 那套整体关掉了自动重验证，理由是等待状态不能被静默重取骗过去。这里是
 * 反过来的一档：屏幕上正写着「正在按议题提炼」，那句话的真假只有服务端知道，所以**只
 * 在这句话还挂着的时候**接着问；落到 done / rejected / failed 就停。
 */
function useSlotIntake(slotId: string, handing: boolean): SlotIntakeState {
  const [state, setState] = useState<SlotIntakeState>({ status: "idle" });

  /*
   * `handing` 进依赖表：他刚交完那一份（true → false）要重新开一轮问，否则这一块会
   * 停在本地那一档上，等不到服务端接手。
   */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const again = () => {
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    const tick = async () => {
      try {
        const next = await api.slotIntakeState(slotId);
        if (!alive) return;
        misses = 0;
        setState(next);
        if (next.status === "checking" || next.status === "summarizing") again();
      } catch {
        if (!alive) return;
        misses += 1;
        /*
         * 问不到不等于没在办，所以先接着问、屏幕上保持上一次的说法。连着几次都问不到
         * 才认账 —— 那时说的是「问不到」这件事本身，不是替服务端编一个结论。
         */
        if (misses < GIVE_UP_AFTER) again();
        else setState({ status: "failed", reason: "问不到这一份材料现在走到哪儿了。" });
      }
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [slotId, handing]);

  return state;
}

/* -------------------------------------------------------------------------- */
/* 还在研究的一件 —— 一张纸                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 还没定时间的那一件。
 *
 * 它比深色那几块轻一整档：纸色、墨字、只有编号、标题和一行还在跑的研究状态。上一版这里
 * 挂着五行小字（深研第几步、承接研究等谁、域与 DRI、对谈几轮、判断待确认几条），收到一行
 * 的理由写在下面那一段注释上。
 */
function PlainCard({ issue }: { issue: IssueSummary }) {
  /*
   * 背后那一轮此刻在跑没有。`done` 是跑完了，`idle` 是压根没开过 —— 两档都不动，
   * 剩下的才是在办（口径同 `ResearchStatusLine` 里那几支）。
   */
  const running = issue.research.state !== "done" && issue.research.state !== "idle";

  return (
    /*
     * 整块是入口，而删除那一小截压在它上面一层。两个 `<a>` 不能嵌套，所以铺开的那一层
     * 用标题上的伪元素做（`after:inset-0`），删除键 `relative z-10` 压在它上面 ——
     * 不这样的话，那一下会被铺开的那层吃掉，变成「进这件议题」。
     */
    <div className="list-block row-link concentric group relative px-3.5 py-3">
      {/*
       * 右边沿那条马赛克（`.mosaic-edge`，画法和分寸写在那儿）。
       *
       * **摆在最前面，而底下每一段自己 `relative`** —— 绝对定位的元素画在普通流内容
       * 上面，不这么办的话，标题第二行只要够长就会从马赛克底下透出来。
       *
       * 那句 `relative` 加在标题的 `<span>` 上，**不能加在 `<Link>` 上**：铺满整块的
       * 点击区是这个 Link 的 `after:inset-0`，而它认的是最近一个定位过的祖先 ——
       * Link 自己一旦定位，那一层就缩成标题那一行，整张卡就不再是入口了。
       */}
      {running ? <div aria-hidden className="mosaic-edge" /> : null}
      <div className="relative z-10 flex items-center gap-2">
        <span className="meta text-ink-faint">{issue.id}</span>
        <RemoveIssue issue={issue} />
      </div>
      <Link
        href={`/issues/${issue.id}`}
        className="after:absolute after:inset-0 after:content-['']"
      >
        <span className="clamp-2 relative mt-0.5 block text-md leading-relaxed text-ink">
          {issue.title}
        </span>
      </Link>
      {/*
       * 一行研究状态，就一行。
       *
       * 上一版这里有五行（深研第几步、承接研究等谁、域与 DRI、对谈几轮、判断待确认几条）。
       * 全删掉是不对的 —— 这一栏里「还在研究」那一档唯一还在动的东西就是它，没有它，
       * 那几张浅色卡片在屏幕上是静止的；但留五行同样不对：那五行的墨量会把这一栏真正要
       * 说的那件事（哪几件已经定了时间）整个冲淡。
       *
       * 所以只留这一行，而且**只在它真有话说的时候出现**（跑完了就不再写「已完成」——
       * 已完成是一个不需要每天读一遍的事实）。
       */}
      {issue.research.state !== "done" && (
        <div className="relative mt-1.5">
          <ResearchStatusLine research={issue.research} />
        </div>
      )}
    </div>
  );
}

/**
 * 删掉这一行的议题。**内部测试用，不是产品功能。**
 *
 * ## 为什么它长在这儿，又为什么这么小
 *
 * 立案、预研、深研、判断这几条链路现在都在真模型上调，一天十几轮，每一轮都在议题板上
 * 留一件试出来的东西。live 档没有「删一件」的口子，只有 `resetDemo` —— 那是把整库推回
 * 种子，连他上一场聊出来的一起没。
 *
 * 所以它必须在议题板上（垃圾就在这儿），又必须**不占位**：鼠标压到这一行才现身，
 * 平时那一行看起来和它不存在时一模一样。真正的处置动作是三键里的「搁置」和会后关闭，
 * 它们各有各的账；这一刀没有账，删完就像它没来过。
 *
 * ## 两下才删
 *
 * 不弹窗 —— 一个调试入口不值得一层弹层，而弹层要的注意力比这件事本身多。改成两下：
 * 第一下把这一小截换成「真的删？」，第二下才真删。鼠标离开这一行就退回去，所以
 * 「按错了」的代价是把手移开。
 *
 * ## 删不掉的时候要说出为什么
 *
 * 服务端会挡下「这件议题上还有任务在跑」（见 `store.ts` 的 `removeIssue`）。那句话得
 * 原样摆到他眼前：「删不掉」三个字会让他以为按钮坏了，而实际上他只要等那一轮跑完。
 */
function RemoveIssue({ issue }: { issue: IssueSummary }) {
  const invalidate = useInvalidate();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    /*
     * `relative z-10`：整行的点击区是标题那个 `<Link>` 上铺开的伪元素（`after:inset-0`），
     * 不压在它上面一层的话，这一下会被那一层吃掉，变成「进这件议题」。
     *
     * 左右间距由编号那一行的 flex `gap-2` 给，这里不再自己带 `ml-2`。
     */
    <span
      className="relative z-10 inline-flex align-middle"
      onMouseLeave={() => {
        setArmed(false);
        setFailure(null);
      }}
    >
      <button
        type="button"
        disabled={busy}
        aria-label={armed ? `确认删除 ${issue.id}` : `删除 ${issue.id}（调试用）`}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setBusy(true);
          setFailure(null);
          void api
            .removeIssue(issue.id)
            // 作废清单让这一行自己消失。不本地过滤：这一行的去留由服务端说了算。
            .then(() => invalidate())
            .catch((err: unknown) => {
              setArmed(false);
              setFailure(err instanceof ApiError ? err.message : "没删掉。");
            })
            .finally(() => setBusy(false));
        }}
        className={cn(
          "meta rounded-[3px] underline decoration-hairline underline-offset-4 transition-colors duration-fast",
          // 平时是隐形的：没 hover 到这一行就不占注意力。键盘走到它上面也要现身。
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          armed ? "text-counter decoration-counter" : "text-ink-faint hover:text-ink-muted",
        )}
      >
        {busy ? "删除中…" : armed ? "真的删？" : "删除"}
      </button>
      {failure ? (
        <span
          role="alert"
          className="absolute top-full left-0 z-20 mt-1.5 w-max max-w-[20rem] rounded-md border border-hairline-strong bg-surface px-2.5 py-1.5 text-sm leading-relaxed text-ink shadow-e2"
        >
          {failure}
        </span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 左上：雷达                                                                  */


/* -------------------------------------------------------------------------- */

type SlotGroup = { kind: "slot"; key: string; issues: IssueSummary[] };
type Group = SlotGroup | { kind: "plain"; key: string; issue: IssueSummary };

/**
 * 把排好序的议题折成「一块一块」。
 *
 * 同一场会的几件在排序里本来就是连着的（`agendaCompareBy` 先比会议时间、再比会内议程），
 * 所以这里只要一趟扫下来遇到换场就收口。**不按 slotId 分组再排序** —— 那会让「会内的
 * 议程顺序」和「块与块之间的顺序」由两处决定，而两处迟早会不一致。
 */
function toGroups(sorted: IssueSummary[]): Group[] {
  const out: Group[] = [];
  for (const issue of sorted) {
    const slotId = issue.slot?.slotId;
    if (!slotId) {
      out.push({ kind: "plain", key: `p:${issue.id}`, issue });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "slot" && last.key === `s:${slotId}`) last.issues.push(issue);
    else out.push({ kind: "slot", key: `s:${slotId}`, issues: [issue] });
  }
  return out;
}
