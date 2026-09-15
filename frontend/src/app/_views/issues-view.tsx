"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { ResearchStepLine } from "@/components/research-step-line";
import { StateBadge } from "@/components/state-badge";
import { api } from "@/lib/data/client";
import type { Issue, IssueSummary } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 页面2 议题列表 —— 五个环节的第二格。
 *
 * 「一号位真正在乎的问题」这张清单，是这个系统里唯一有权把事情往下推的地方。所以它
 * 只回答两个问题，别的都不答：
 *
 * 1. **哪几件是我的。** 排序按「要不要您」，不按时间。时间序是信息流的属性；这是一份
 *    还没落地的判断清单。
 * 2. **它怎么进来的。** 每一行都挂着来源 —— 待定事项采信、您自己添加、探讨中衍生。三个
 *    来源缺一不可：只有采信一条，这就是个收件箱；没有手动添加，一号位心里那件事永远
 *    进不来；没有衍生，探讨就白探讨了。来源写在屏幕上，这份清单才可信。
 *
 * 但**这一页没有添加入口**。这里的每一件事都是从潜在议题那一屏采信过来的，包括他自己
 * 提的那些 —— 「+ 我自己有一件事」在潜在议题页上（`digest-view`）。原来那个入口在这里，
 * 于是他打一行字就直接得到一条在办议题：那是一条特权通道，跳过了「值不值得占我时间」
 * 这一次处置。这份清单的可信度全在「上面每一件都被他亲手采信过」。
 *
 * 没有看板、没有筛选器、没有标签体系、没有搜索 —— v1 的议题是个位数，那几样东西都是
 * 替一个还不存在的问题造的界面。
 */

const ORIGIN_LABEL: Record<Issue["origin"], string> = {
  signal: "待定事项采信",
  manual: "您添加",
  derived: "探讨中衍生",
};

type Group = { title: string; accent: boolean; issues: IssueSummary[] };

/**
 * 只区分两段：进行中 / 已确认。不再单设「需要判断」——「哪件要您、今天要不要」
 * 是系统替人下的断言，这份清单只陈述状态，判断留给读它的人。
 */
function group(issues: IssueSummary[]): Group[] {
  const settled = issues.filter(
    (i) =>
      i.state === "Decided" ||
      i.state === "Monitoring" ||
      i.state === "Closed" ||
      i.state === "Dismissed",
  );
  const live = issues.filter((i) => !settled.includes(i));

  return [
    { title: "进行中", accent: false, issues: live },
    { title: "已确认", accent: false, issues: settled },
  ].filter((g) => g.issues.length > 0);
}

export function IssuesView() {
  const resource = useResource<IssueSummary[]>("issues", () => api.listIssues());

  /*
   * 有深研在跑就每五秒重问一次。
   *
   * 这一页原来一次都不轮询，因为它只显示一个布尔 —— 那个布尔在报告落库之前不会变，
   * 轮询也问不出新东西。现在每一行写着走到第几步，那是几十秒一变的东西：不问就等于
   * 把开跑那一刻的步骤号钉在屏幕上，而它看起来和一个真在走的步骤号一模一样。
   *
   * 五秒，不是一秒：一步是几十秒的量级，那行字上的秒表在客户端自己走。
   */
  const mutate = resource.mutate;
  const running = (resource.data ?? []).some((i) => i.research.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void mutate(), 5000);
    return () => clearInterval(t);
  }, [running, mutate]);

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<IssuesSkeleton />}>
        {(all) => {
          /*
           * `Candidate` 不在这份清单上 —— 它还在潜在议题那一屏等着被处置，还不是
           * 「一号位真正在乎的问题」。混进来的话「共 N 件」数的就是收件箱的条数，
           * 而这一页的全部意义是回答「我手上到底有几件事」。
           */
          const issues = all.filter((i) => i.state !== "Candidate");
          return (
          <>
            <PanelHead
              eyebrow={`共 ${issues.length} 件`}
              title="战略议题"
              actions={
                <Link
                  href="/issues-log"
                  className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
                >
                  去向记录 →
                </Link>
              }
            />

            <OriginLine issues={issues} />

            {issues.length === 0 ? (
              /*
               * 空是**第一天的正常状态**，不是缺数据：所有议题都从潜在议题那一屏采信
               * 过来，一件都还没采信时这里就是空的。所以这里必须给出那个起点的口子 ——
               * 否则他站在一份空清单前，没有任何线索知道下一步该去哪。
               */
              <PanelEmpty title="现在一件议题都没有。">
                <Link
                  href="/signals"
                  className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
                >
                  去潜在议题 →
                </Link>
              </PanelEmpty>
            ) : (
              <div className="mt-7 space-y-8">
                {group(issues).map((g) => (
                  <section key={g.title}>
                    <h2 className="meta mb-2.5 flex items-baseline gap-2 text-ink-faint">
                      <span className={cn(g.accent && "text-judgment")}>
                        {g.title} · {g.issues.length}
                      </span>
                    </h2>
                    {/*
                     * 一份清单，不是一叠卡片。
                     *
                     * 每件议题原来是一张带描边的卡，一屏读起来是六个框、不是六件事。现在
                     * 整段是一块面（`.card`），行与行之间只有一条从内容左边缘起笔的发丝线
                     * （`.row + .row::before`）—— 所以这里不留行间距，最后一行也不画线。
                     */}
                    <ul className="card overflow-hidden">
                      {g.issues.map((issue, i) => (
                        <li
                          key={issue.id}
                          className="stagger row row-link concentric"
                          style={{ "--i": i } as React.CSSProperties}
                        >
                          <Link
                            href={`/issues/${issue.id}`}
                            className={cn(
                              "block px-3.5 py-3.5",
                              g.accent && "border-l-2 border-l-judgment",
                            )}
                          >
                            <div className="flex items-center gap-2.5">
                              <StateBadge state={issue.state} />
                              <span className="meta text-ink-faint">
                                {ORIGIN_LABEL[issue.origin]}
                              </span>
                              <span className="meta text-ink-faint">{issue.id}</span>
                              {issue.assigneeName && (
                                <span className="meta rounded-[3px] bg-neutral-wash px-1.5 py-[1px] text-ink-muted">
                                  指派 · {issue.assigneeName}
                                </span>
                              )}
                            </div>
                            <p className="report mt-1 text-lg text-ink">{issue.title}</p>
                            {issue.nextActionForUser && (
                              <p className="meta mt-1.5 text-judgment">
                                {issue.nextActionForUser}
                              </p>
                            )}
                            {/*
                              一号位进议题研究的第一步永远是读报告，所以每条在办议题都
                              写明研究到哪了。
                            */}
                            {issue.state !== "Decided" &&
                              issue.state !== "Monitoring" &&
                              issue.state !== "Closed" &&
                              issue.state !== "Dismissed" && (
                                <ResearchRow research={issue.research} />
                              )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
          );
        }}
      </AsyncBoundary>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 这一行研究状态。三档，各说各的话。
 *
 * 原来它读的是 `issue.researchReady` 一个布尔，于是**「没人在跑」被渲染成「进行中」**：
 * 一颗呼吸的点代表一件没有任何人在做的事，而一号位会一直等它。数据层早就把这三档
 * 分开了（`IssueResearchStatus`，它的 `idle` 那一档就是为这件事加的），这一页只是一直
 * 没接上去。
 *
 * 在跑的那一档写出走到第几步、已经跑了多久。那颗呼吸的点保留 —— 它说的是「有东西在
 * 动」，那行字说的是「动到哪了」，两件事。
 */
function ResearchRow({ research }: { research: IssueSummary["research"] }) {
  if (research.state === "done") {
    return (
      <p className="meta mt-1.5 flex items-center gap-1 text-confirmed">
        <Check className="size-3" aria-hidden />
        深度研究已完成
      </p>
    );
  }

  if (research.state === "idle") {
    return (
      <p className="meta mt-1.5 flex items-center gap-1.5 text-ink-faint">
        <span aria-hidden className="size-1.5 rounded-full bg-hairline-strong" />
        深度研究未开始
      </p>
    );
  }

  /*
   * 排着队那一档。**点不呼吸**，理由同 `research-line.tsx`：这一轮一次调用都还没发，
   * 而这一屏可能有几行同时在等 —— 每行都跳一个点，说的是「六件事都在动」，那是假的。
   */
  if (research.state === "queued") {
    return (
      <p className="meta mt-1.5 flex items-center gap-1.5 text-ink-faint">
        <span aria-hidden className="size-1.5 rounded-full bg-hairline-strong" />
        深度研究
        <ResearchStepLine queuePosition={research.queuePosition} fallback="排队中" />
      </p>
    );
  }

  return (
    <p className="meta mt-1.5 flex items-center gap-1.5 text-factual">
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-factual opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-factual" />
      </span>
      {/*
       * 「深度研究」四个字留在外面，不进那道扫光。这一行是清单里的一行，他得先认出
       * 这说的是哪件事，再读它到哪一步了 —— 名词跟着一起呼吸的话，扫的是整行，
       * 而这一屏可能有六行同时在扫。
       */}
      深度研究
      <ResearchStepLine step={research.step} startedAt={research.startedAt} fallback="进行中" />
    </p>
  );
}

/** 三个来源各有几件。一行小字，但它是这一页可信度的全部 —— 每条都答得出怎么进来的。 */
function OriginLine({ issues }: { issues: IssueSummary[] }) {
  if (issues.length === 0) return null;
  const counts = (["signal", "manual", "derived"] as const).map((o) => ({
    origin: o,
    n: issues.filter((i) => i.origin === o).length,
  }));

  return (
    <p className="meta flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ink-faint">
      <span>来源</span>
      {counts.map((c) => (
        <span key={c.origin} className={cn(c.n > 0 && "text-ink-muted")}>
          {ORIGIN_LABEL[c.origin]} {c.n}
        </span>
      ))}
    </p>
  );
}

function IssuesSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-28" />
      <span className="skeleton mt-2.5 block h-5 w-[56%]" />
      <div className="mt-8 space-y-6">
        {[2, 3].map((n, s) => (
          <div key={s}>
            <span className="skeleton block h-2.5 w-20" />
            <div className="mt-2.5 space-y-1.5">
              {Array.from({ length: n }, (_, i) => (
                <div key={i} className="rounded-lg border border-hairline px-4 py-3.5">
                  <span className="skeleton block h-2.5 w-32" />
                  <span className="skeleton mt-2 block h-4 w-[76%]" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
