"use client";

import { useEffect, useRef, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { ALL_ISSUES, ConsoleShell, isLiveIssue } from "@/components/agenda/console-shell";
import { IssueColumn } from "@/components/agenda/issue-column";
import { BreathingDot } from "@/components/agenda/research-line";
import { DynamicPanel, type DynamicPanelHandle } from "@/components/panel/dynamic-panel";
import { ResearchStepLine } from "@/components/research-step-line";
import { api, ApiError } from "@/lib/data/client";
import type { DomainSummary, IssueSummary } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";


/**
 * 首页 —— 一号位的驾驶舱。
 *
 * ## 这一屏只有两块
 *
 *   左中 议题：手上有哪些事，哪几件已经定了时间（`ConsoleShell` 的左栏 + 这里的中栏）。
 *   右   **动态面板**：iOS 锁屏式的一块玻璃，只装会后归他自己的那几件 action item
 *        （`DynamicPanel`）。
 *
 * 右栏原来是「待确认的会议纪要」（`DebriefColumn`）——那一叠 2026-09-03 撤了：审纪要
 * 现在是秘书的活（相一），一号位不必每天先从一堆不用他管的事里把要看的那几件挑出来。
 * 待确认的纪要没有消失，只是换了地方：`/sec/debriefs`。右栏腾出来的位置装的是另一件
 * 一直没有落点的东西——会后提炼出来、**点了他名**的执行项，原来只在议题详情页里睡着，
 * 现在有了一个每天都会看一眼的地方。
 *
 * 议题在这一屏上仍然有四种样子，而**它们全部由「在哪一栏、什么颜色」说清，没有一处
 * 状态标签**：
 *
 *   还在研究        中栏，纸色轻块
 *   已经定了时间    中栏，深色实心重块，排在最前
 *   会后归他的事    右栏的动态面板（按 action item，不是按议题摊开）
 *   已部署          不在这一屏上 —— 中栏标题那个滑块切过去才看得见（`SpaceSwitch`）
 *
 * ## 顶栏在这一屏上不出现
 *
 * 字标坐在左列的底边（`Wordmark`），版本号跟着它。所以 `StageNav` 在 `/` 上整条返回
 * `null` —— 理由写在那个组件里。这一屏因此从屏幕顶端就开始是内容。
 *
 * ## 三档滑块删了
 *
 * 「进行中 / 已部署 / 已关闭」那三格问的是「看哪一档」，而这一屏现在中栏摊开的是手上
 * 在办的全部，已部署搬去了中栏标题那个滑块后面。这一档三格滑块和现在的两档开关不是
 * 同一件事：那时是"看哪一个筛子"，筛子筛的是同一份清单；现在是"看哪一份清单"——
 * 已部署压根不在中栏这份清单的候选范围里，两份清单靠 `IssueColumn` 内部的
 * `SpaceSwitch` 切换，见那个组件顶部 2026-09-03 那一段。
 */

/**
 * 他刚粘进来、服务端还没答完的那一件（`PasteTopic` → `DeployingRow`）。
 *
 * 它不是一件议题 —— 库里此刻还没有这个对象。它是「你按的那一下正在办」这件事本身，
 * 所以带着的全是客户端手上已有的东西：粘进来的原文、此刻在等什么、按下的时刻。
 */
type Deploying = {
  /** 他粘进来的原文。标题要等服务端起（长的那两支要过一遍小模型），先摆原文。 */
  text: string;
  /** 此刻在等的那一句 —— 三种输入各自在等的事不一样（见 `PasteTopic`）。 */
  waiting: string;
  /** 他按下那一刻。那行小字上的秒表从这里走。 */
  startedAt: string;
  /** 服务端答完才有。清单上那一行真的出现了，这个占位才撤。 */
  issueId?: string;
};

export function HomeView() {
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());

  const [pickedDomain, setPickedDomain] = useState<string | null>(null);
  /* 他刚粘进来的那一件，服务端还在办。它在议题栏最前面占一块不可点的（`DeployingRow`）。 */
  const [deploying, setDeploying] = useState<Deploying | null>(null);
  /* 点开会议卡要让右栏那扇动态面板滑出详情 sheet——两栏是兄弟，这一句是唯一的接口。 */
  const panelRef = useRef<DynamicPanelHandle>(null);

  const issues = issuesRes.data ?? [];
  const domains = domainsRes.data ?? [];

  /*
   * 默认落点是**所有议题**，不是某一个域。
   *
   * 原来默认落在「最近有动静的那件议题所在的域」。那个落点在他进一件议题再退回来时是错的：
   * 这个状态不跨路由，退回来时重算一遍，于是他被扔进一个自己没选过的域，而屏幕上少了
   * 另外七个域的事 —— 少的那几件他看不见，也不知道自己在被筛。总览没有这个问题。
   */
  const domainId = pickedDomain ?? ALL_ISSUES;
  const overview = domainId === ALL_ISSUES;

  /**
   * 中栏那一份。
   *
   * `Candidate` 归左上角那扇窗，已了结的归右边缘那两颗点，**而正等着他确认会后要点的
   * 那几件归右栏** —— 议题在这一屏上的四种样子各占一个位置，同一件事不在两处出现。
   * 留在两处的话，他在左栏点开的那一件和右栏那张卡说的是同一件事，而两处能做的动作
   * 完全不同。
   */
  const liveAll = issues.filter(isLiveIssue);

  /*
   * 已部署有几件 —— 只给中栏那个滑块用（`IssueColumn` 的 `deployedCount`）。
   *
   * 口径和 `ConsoleShell`、`deployed-view.tsx` 必须是同一句，否则一号位会在两处看到
   * 两个不一样的「已部署」数：交出去还在跑的算，彻底完了的（`Closed` / `Dismissed`）
   * 不算——那一档的价值只是可查，不该占这一屏任何一个数字。
   */
  const deployedCount = issues.filter(
    (i) => i.settled && i.state !== "Closed" && i.state !== "Dismissed",
  ).length;

  /*
   * 按域筛。**已排会的那几件按「这场会上有没有这个域的议题」整场留下** —— 一场会横跨
   * 两个域是常态（那正是一号位的会该有的样子），按议题逐件筛会让同一场会在屏幕上缺几件，
   * 而缺的那几件恰好是他此刻在看的那一场会要谈的。
   */
  const slotsWithDomain = new Set(
    liveAll.filter((i) => i.domainId === domainId).flatMap((i) => (i.slot ? [i.slot.slotId] : [])),
  );
  const inDomain = overview
    ? liveAll
    : liveAll.filter(
        (i) => i.domainId === domainId || (i.slot && slotsWithDomain.has(i.slot.slotId)),
      );

  /*
   * 有深研在跑就重问，两种在跑的节拍不一样：带预估的那一档每秒问一次（进度是数据层按真实
   * 时钟算的），真跑的那一档五秒一次（它变的只有走到第几步，而一步是几十秒的量级）。
   */
  const issuesMutate = issuesRes.mutate;
  const anyRunning = issues.some((i) => i.research.state === "running");
  const anyEta = issues.some(
    (i) => i.research.state === "running" && i.research.progress !== undefined,
  );
  const every = anyEta ? 1000 : anyRunning ? 5000 : 0;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => void issuesMutate(), every);
    return () => clearInterval(t);
  }, [every, issuesMutate]);

  /*
   * 占位那一块由清单上的真块接手 —— **真块到了才撤**。「撤了没」是从清单算出来的，
   * 不另存一个状态：那等于把「清单上有没有这一行」抄成第二份，而两份之间任何一次不同步
   * 都会让占位和真块同时在屏幕上。
   */
  const deployingRow =
    deploying && !issues.some((i) => i.id === deploying.issueId) ? deploying : null;

  const startDeploying = (next: Deploying | null) => {
    setDeploying(next);
    if (!next) return;
    // 必须切到总览：刚立的那件议题没有域，八个域的清单谁都不显示它。
    setPickedDomain(ALL_ISSUES);
  };

  return (
    <ConsoleShell
      current="issues"
      domains={domains}
      domainId={domainId}
      onPickDomain={setPickedDomain}
      issues={issues}
    >
      {/*
       * 一块托盘，两栏。
       *
       * 发丝线（`divide-x divide-hairline`）撤了：右栏现在是动态面板，自带一整套玻璃
       * 与壁纸的视觉语言，跟中栏的纸色是两种材质，颜色本身已经在说「这是两件不相干的
       * 东西」，再画一条线是同一条边界画两遍。托盘底色 `bg-list-ground` 也跟着从整块
       * 托盘搬到了只属于中栏的那个容器上——原因见下面那个 wrapper 上的注释。
       */}
      <section className="grid h-full grid-cols-2 overflow-hidden rounded-2xl [--r:1rem]">
        {/*
         * 中栏单独包一层来挂底色，而不是像原来那样让托盘的 `bg-list-ground` 整块生效：
         * 这个 token 是全站的，跟着明暗主题走（`globals.css` 里 `.dark` 那份是纯黑的
         * `color-mix`）；但右边紧挨着的动态面板明确「不跟随全站明暗主题」（它自带壁纸，
         * 见 `panel.module.css` 顶部的说明）。如果中栏继续吃这个会变色的 token，主题一切，
         * 中栏和面板这两块材质的亮度关系就会跟着颠倒一次——规格钉的 `#F4F4F5` 是让中栏
         * 在任何主题下都固定亮，陪衬面板那块恒定的壁纸。这里用内联值而不是新开一个
         * token：这个值只服务这一屏这一栏，不是一个要被别处复用的设计决策。
         *
         * `grid` + `min-h-0`：把 `AsyncBoundary` 换成的这层 `div` 变成单格网格容器，
         * 让它的孩子（骨架屏或者 `IssueColumn` 自己的根节点）继续吃到跟以前一样的
         * 「拉伸到整栏高度」的效果——去掉这一层的话，`IssueColumn` 里 `grid-rows-
         * [auto_minmax(0,1fr)_auto]` 算的是内容高度，底部那个粘住的 `footer` 会往上
         * 缩到内容那么高，而不是贴住栏底。
         */}
        <div className="grid h-full min-h-0 min-w-0" style={{ backgroundColor: "#F4F4F5" }}>
          <AsyncBoundary resource={issuesRes} skeleton={<ColumnSkeleton />}>
            {() => (
              <IssueColumn
                issues={inDomain}
                domains={domains}
                today={api.today}
                lead={deployingRow ? <DeployingRow row={deployingRow} /> : null}
                footer={<PasteTopic deploying={deployingRow !== null} onDeploy={startDeploying} />}
                deployedCount={deployedCount}
                onOpenMeeting={(slotId) => panelRef.current?.openMeeting(slotId)}
              />
            )}
          </AsyncBoundary>
        </div>

        <DynamicPanel ref={panelRef} />
      </section>
    </ConsoleShell>
  );
}




function ColumnSkeleton() {
  return (
    <div aria-live="polite" className="space-y-2 p-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="list-block concentric px-3.5 py-3">
          <span className="skeleton block h-2.5 w-24" />
          <span className="skeleton mt-2 block h-4 w-[82%]" />
        </div>
      ))}
    </div>
  );
}

function PasteTopic({
  /** 上一件还在部署。这个入口这时是哑的：位置不动，正在办的那一件由清单最前面那行说。 */
  deploying,
  /** 把「正在部署的那一件」交给这一屏（`HomeView` 的 `startDeploying`）。 */
  onDeploy,
}: {
  deploying: boolean;
  onDeploy: (next: Deploying | null) => void;
}) {
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const raw = text.trim();
  /*
   * 等着的那一下说清在等什么，三句都是此刻真的在发生的事（同 `digest-view` 的 `AddOwn`）。
   * 判错的代价只是这句话不准 —— 真正的分类由服务端重做一遍。
   */
  const kind = /^https?:\/\/\S+$/i.test(raw) ? "link" : raw.length > 60 ? "long" : "short";
  const busyLabel =
    kind === "link"
      ? "正在打开那个链接…"
      : kind === "long"
        ? "正在读一遍，顺手起个标题…"
        : "正在立项，起深研…";

  const submit = () => {
    if (!raw || busy) return;
    setBusy(true);
    setFailure(null);
    /*
     * 这一下就把框收起来，那一行开始动。
     *
     * 它**不是**乐观更新（H2 那条仍然成立）：那一行不冒充一件议题 —— 没有编号、
     * 点不动、标题就是他粘进来的原文。它说的只是「你按的那一下正在办」，而这句话
     * 此刻是真的。库里到底有没有立起这件议题，仍然由服务端下面那句话说。
     */
    // 秒表的起点只取一次：服务端答完之后那一行还在（等真行接手），重取会把它拨回 0 秒。
    const row: Deploying = {
      text: raw,
      waiting: busyLabel,
      startedAt: new Date().toISOString(),
    };
    onDeploy(row);
    setOpen(false);
    void api
      .addStrategicIssue(raw)
      .then(({ issueId }) => {
        /*
         * 首页这几栏他还在看着（没被带走），所以原地重问、不清空 —— 清掉的话这一栏
         * 会掉回骨架、左边那份域列表会空一帧。见 `useInvalidate`。
         */
        invalidate(
          "issues",
          "domains",
          "digest:today",
          "sensors",
          "withheld:today",
        );
        setText("");
        // 占位那一行还留着，等清单上的真行接手（`HomeView` 里那个 `deployingRow`）。
        onDeploy({ ...row, issueId });
      })
      .catch((err: unknown) => {
        // 立不起来就把那一行撤掉，框带着原文回来 —— 框里的字一个都不清。
        onDeploy(null);
        setOpen(true);
        setFailure(err instanceof ApiError ? err.message : "没立起来。");
      })
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div>
        <button
          type="button"
          /*
           * 上一件还在部署时按不动：那一下会把清单最前面那行占位换成新的一件，而前一件
           * 仍然在服务端跑着 —— 屏幕上就少了一件正在办的事。等它换成真行（几秒到一分钟）
           * 这里自己回到可按。
           */
          disabled={deploying}
          onClick={() => setOpen(true)}
          className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint disabled:text-ink-faint disabled:no-underline"
        >
          + 创建一个新的战略议题
        </button>
        {failure ? (
          <p role="alert" className="meta mt-2 text-counter">
            {failure}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    /* 一块输入面。它坐在托盘上，所以边界照托盘里的规矩来 —— 纸色，没有环
       （同 `.list-block`）。里面那个框自己是 `bg-paper`，凹在这张纸上。 */
    <div className="animate-panel rounded-xl bg-surface p-4">
      <textarea
        id="paste-topic"
        /* 同 `digest-view` 那一个：屏幕上的说明删了，控件名不能跟着没。 */
        aria-label="粘一件已经定了的战略议题"
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter 提交。裸 Enter 留给换行 —— 一段议题也可能想断几行写。
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        /* 贴一整篇进来时框自己长高，14rem 封顶再内部滚（同 `AddOwn`）。 */
        className="report scroll-slim mt-2 field-sizing-content max-h-56 min-h-[3.75rem] w-full resize-none overflow-y-auto rounded-md border border-hairline bg-paper px-3 py-2.5 text-md text-ink outline-none transition-colors duration-fast placeholder:text-ink-faint focus:border-hairline-strong"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || raw.length === 0}
          onClick={submit}
          className="inline-flex h-9 items-center rounded-lg bg-solid px-3.5 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
        >
          {busy ? busyLabel : "立项并开始深研"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          算了
        </button>
      </div>
      {failure ? (
        <p role="alert" className="meta mt-2 text-counter">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 刚粘进来那一件，服务端还在办的那一段 —— **清单最前面一行不可点的议题。**
 *
 * ## 它不是乐观更新
 *
 * 库里此刻还没有这个对象：编号是服务端发的、标题是服务端起的（长的那两支要过一遍小
 * 模型）、深研也要它去起。所以这一行**点不动**，而且它一样都不冒充：编号那一格写
 * 「立项中」，标题位摆的是他粘进来的原文。它说的全部只有一句 —— 你按的那一下正在办，
 * 办的是这一段话。点得进去的那一行要等真的立起来（清单上的 `IssueRow`）。
 *
 * ## 动的是这行字自己
 *
 * 「调研部署中」旁边一颗呼吸的点，底下那句是此刻真的在等的事 + 一只秒表
 * （`ResearchStepLine` 的那道扫光，理由写在那个组件上）。不给进度条、不给百分比：
 * 这一段等多久取决于那个链接抓不抓得下来，编一个分母出来是在说谎。
 *
 * 几何照抄 `IssueRow`：同一块 `.list-block` 的纸、同样的内边距、同样的同心圆角、
 * 同样宽的右列（8.5rem，里面同样是那颗进不去的会议），进度那一格也落在同一个位置 ——
 * 标题底下。少的只有 `row-link` 那层 hover：这一块此刻点不进去。等它立起来换成真的
 * 那一块时，位置和高度都不该跳。
 */
function DeployingRow({ row }: { row: Deploying }) {
  return (
    <div
      aria-busy
      className="list-block concentric relative flex items-start gap-4 px-3.5 py-3"
    >
      <div className="min-w-0 flex-1">
        <span className="meta text-ink-faint">立项中</span>
        {/* 原文可能是一整篇，两行封顶：这一行的作用是让他认出「是我刚粘的那一段」。 */}
        <span className="clamp-2 mt-1 block text-md leading-relaxed text-ink-muted">
          {row.text}
        </span>

        {/* 进度那一格在标题底下，和真议题同一个位置（`IssueRow` 的那一格）。
            「进行中」是那五步真起来之后的话（`ResearchStatusLine`）；此刻还没起，
            所以这里说的是它前面那一段：部署。 */}
        <div className="mt-1.5 space-y-1">
          <p className="meta flex items-center gap-1.5 text-factual">
            <BreathingDot className="bg-factual" />
            深度研究 · 调研部署中
          </p>
          <ResearchStepLine
            className="meta block leading-relaxed"
            startedAt={row.startedAt}
            fallback={row.waiting}
          />
        </div>

        <p className="meta mt-1.5 text-ink-faint">您粘进来的 · 已定为战略议题</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
