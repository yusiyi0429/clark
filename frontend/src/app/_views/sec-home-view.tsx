"use client";

import { useEffect, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { ALL_ISSUES, ConsoleShell, isLiveIssue } from "@/components/agenda/console-shell";
import { IssueColumn } from "@/components/agenda/issue-column";
import { BreathingDot } from "@/components/agenda/research-line";
import { DynamicPanel } from "@/components/panel/dynamic-panel";
import { ResearchStepLine } from "@/components/research-step-line";
import { api, ApiError } from "@/lib/data/client";
import type { DomainSummary, IssueSummary } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";

/**
 * 秘书那一侧的首页。
 *
 * ## 为什么这一屏和一号位的 `HomeView` 几乎是同一份东西
 *
 * 一号位当面定的话：「秘书的主页应当跟一号位的主页几乎一样，只是多了编排会议和纪要
 * 审阅的按钮。系统通过后台来给秘书和一号位的『交互区』推送不同的待交互信息。」——
 * 这句话把两件事分得很清楚：**屏幕的样子**是一件事，**屏幕上摆的是谁的事**是另一件事。
 * 前者不该因人而异（同一套三栏：雷达 + 业务域 + 字标 / 议题 / 动态面板），后者早就有
 * 现成的口子——`api.listActionItems()` 本来就是按当前登录的视角筛的（见
 * `dynamic-panel.tsx` 顶部注释、`src/lib/data/scope.ts`），秘书登进来看到的动态面板
 * 自然只装归她的那几条，不需要这一层再做任何区分。这也是为什么这份视图**没有**去过滤
 * `DynamicPanel` 塞给它什么——那件事早就在数据层做完了，这里再判一次就是把同一个口径
 * 抄成第二份，迟早和数据层的判据走岔。
 *
 * ## 这份文件和 `home-view.tsx` 的重复是故意的
 *
 * 两位一号位/秘书的主页在这一相由两个人并行改：一号位那份（`HomeView`）在加一个
 * 「议题 / 已部署」的两档滑块（`components/agenda/space-switch.tsx`，这份文件完全
 * 不碰、也不引用它），这一份在加两颗秘书专属的入口键。真要抽一份共用的
 * `<ConsoleView>` 出来，两处的改动会在同一段渲染树上打架。所以这一版选择让两份文件
 * 各自持有一份几乎相同的装配代码（`issuesRes`/`domainsRes` 的取数、按域筛的逻辑、
 * 深研跑着就轮询重问、`ColumnSkeleton`），代价是这份重复以后要有人合回去——记在这里，
 * 不是没意识到。
 *
 * ## 「立项并开始深研」这一段为什么原样留着
 *
 * 一号位的原话是「只是多了……按钮」，没有说要拿掉什么。这一段（`PasteTopic` /
 * `DeployingRow`）严格说是一号位拍板要不要立一件新战略议题的动作，秘书要不要也能按
 * 是一个业务权限问题，不是这一相要回答的架构问题——真要收紧，服务端那侧目前也没有
 * 按角色挡这个写接口（`src/lib/seat.ts` 开头就写着这条边界目前是软的）。所以这里照抄
 * 一号位那一份，不额外收权限，也不额外放权限；谁要收紧，去改 `api.addStrategicIssue`
 * 那一侧的权限判断，不是在这个装配文件里悄悄拿掉一个按钮。
 */

type Deploying = {
  text: string;
  waiting: string;
  startedAt: string;
  issueId?: string;
};

export function SecHomeView() {
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());

  const [pickedDomain, setPickedDomain] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<Deploying | null>(null);

  const issues = issuesRes.data ?? [];
  const domains = domainsRes.data ?? [];

  const domainId = pickedDomain ?? ALL_ISSUES;
  const overview = domainId === ALL_ISSUES;

  const liveAll = issues.filter(isLiveIssue);

  const slotsWithDomain = new Set(
    liveAll.filter((i) => i.domainId === domainId).flatMap((i) => (i.slot ? [i.slot.slotId] : [])),
  );
  const inDomain = overview
    ? liveAll
    : liveAll.filter(
        (i) => i.domainId === domainId || (i.slot && slotsWithDomain.has(i.slot.slotId)),
      );

  /*
   * `IssueColumn` 内部的 `SpaceSwitch`（A 组 2026-09-03 加的两档滑块）要一个「已部署
   * 有几件」的数去点亮「已部署」那一档——口径和 `console-shell.tsx` 里那份一模一样
   * （`i.settled && i.state !== "Closed" && i.state !== "Dismissed"`），这里照抄同一条
   * 判据，不是我这一相引入的新算法。这份文件写的时候 `SpaceSwitch` 还不存在（任务
   * 交代过不许提前建那个文件），它在这份文件动工期间由另一组落地，`IssueColumn` 的
   * 必填 prop 也跟着多了这一个——这里补上是为了让这份视图仍然吃得动那份契约，不是
   * 在越界改一号位那一组的活。
   */
  const deployedCount = issues.filter(
    (i) => i.settled && i.state !== "Closed" && i.state !== "Dismissed",
  ).length;

  /* 同 `home-view.tsx`：深研在跑就按同样的节拍重问一次，理由一字不差，见那份文件。 */
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

  const deployingRow =
    deploying && !issues.some((i) => i.id === deploying.issueId) ? deploying : null;

  const startDeploying = (next: Deploying | null) => {
    setDeploying(next);
    if (!next) return;
    setPickedDomain(ALL_ISSUES);
  };

  return (
    /*
     * `heightClass="h-full"`：这个壳这次不是挂在自己的整屏路由下，而是嵌进 `SecLayout`
     * 的 `<main>` 里，细账见 `console-shell.tsx` 里同名 prop 的注释。
     *
     * `showLogout={false}`：不是拦登出（`Wordmark` 现在一直渲染登出按钮，见
     * `console-shell.tsx`）——这具壳靠它认出「这是秘书那两屏」，从而在左栏多画一段
     * `SecJobLinks`。`ScheduleView` 传的是同一个值，理由整段写在 `console-shell.tsx`。
     */
    <ConsoleShell
      current="issues"
      domains={domains}
      domainId={domainId}
      onPickDomain={setPickedDomain}
      issues={issues}
      heightClass="h-full"
      showLogout={false}
    >
      {/*
       * 秘书专属的「编排会议」「纪要审阅」两颗入口键，原来贴着这份视图的正文顶部——
       * 现在挪进了 `ConsoleShell` 左栏（域列表和字标之间那段空地），理由是它们不再靠
       * `SecLayout` 的顶栏才够得着：那条栏拆掉了，两颗键得换个「从她这一侧哪一屏都在」
       * 的地方，见 `console-shell.tsx` 里 `SecJobLinks`。这份视图因此和 `home-view.tsx`
       * 的 `HomeView` 重新变回同一份装配——两栏的几何、颜色、边界理由全部写在那份文件
       * 里，这里不重复贴一遍相同的注释。
       */}
      <section className="grid h-full grid-cols-2 overflow-hidden rounded-2xl [--r:1rem]">
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
                interactive
              />
            )}
          </AsyncBoundary>
        </div>

        <DynamicPanel />
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

/* -------------------------------------------------------------------------- */
/* 以下两段（`PasteTopic` / `DeployingRow`）与 `home-view.tsx` 逐字相同。       */
/* 这是本文件头部注释里说明过的那笔重复账：两位一号位/秘书的主页此刻由两个    */
/* 人并行改，各自持有一份完整装配比共用一份、在同一段渲染树上打架更安全。     */
/* -------------------------------------------------------------------------- */

function PasteTopic({
  deploying,
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
        invalidate(
          "issues",
          "domains",
          "digest:today",
          "sensors",
          "withheld:today",
        );
        setText("");
        onDeploy({ ...row, issueId });
      })
      .catch((err: unknown) => {
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
    <div className="animate-panel rounded-xl bg-surface p-4">
      <textarea
        id="sec-paste-topic"
        aria-label="粘一件已经定了的战略议题"
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
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

function DeployingRow({ row }: { row: Deploying }) {
  return (
    <div
      aria-busy
      className="list-block concentric relative flex items-start gap-4 px-3.5 py-3"
    >
      <div className="min-w-0 flex-1">
        <span className="meta text-ink-faint">立项中</span>
        <span className="clamp-2 mt-1 block text-md leading-relaxed text-ink-muted">
          {row.text}
        </span>

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
