"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { MissionCard, OutcomeScreen } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 目标与任务。一棵树，三层：
 *
 *   公司总 Outcome  →  业务域（域 Outcome · DRI · 判断）  →  Mission（真里程碑）
 *
 * 这一页回答的是一号位每周都要问一次的那句话：我定下的那件事，往下拆到谁手上、拆成了
 * 什么。所以三层之间必须是同一条线连下来的 —— 三张并列的卡片答不了这个问题。
 *
 * 几条克制：
 *
 * - **连线是发丝线，没有箭头。** 层级已经由缩进说清了；箭头会让人误读成流程顺序，而这
 *   棵树是归属关系，不是先后关系。
 * - **Mission 归 DRI，一号位能看能裁。** 有承诺时，Mission 层显示一行条数（「本期承诺
 *   的 N 条」），逐条裁决入口在域那一行下方。无承诺时才显示种子里的示例
 *   Mission —— 这不是「两套渲染」，而是如实反映这一期有没有真实承诺。
 * - **状态是文字，不是进度条。** 「第 60 天评审会初定方向」是承诺，「67%」是幻觉：那个
 *   分母没人算得出来。同理没有百分比、没有健康度、没有红黄绿灯。
 * - **不做可平移缩放的画布。** 一棵四叉五叶的树用不上；而且窄屏上手势画布是灾难。这一
 *   页在 380px 上照样从头读到尾。
 *
 * 域一级默认全展开 —— 开屏就是全貌，收起是他自己的动作。收起之后那一行仍写着「N 条
 * Mission」，不然折叠等于把东西藏了。
 */

/** 三种 Mission 状态，三个词。颜色是冗余编码，词才是内容。 */
const STATUS_WORD: Record<MissionCard["status"], { word: string; dot: string }> = {
  confirmed: { word: "已确认", dot: "bg-confirmed" },
  running: { word: "进行中", dot: "bg-factual" },
  pending: { word: "待定", dot: "bg-ink-faint" },
};

export function OutcomesView() {
  const resource = useResource<OutcomeScreen>("outcomes", () => api.getOutcomes());

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<OutcomesSkeleton />}>
        {(screen) => <Tree screen={screen} />}
      </AsyncBoundary>
    </Panel>
  );
}

function Tree({ screen }: { screen: OutcomeScreen }) {
  /**
   * Mission 总数：有承诺时数承诺的条目，无承诺时数种子 Mission。
   * 统计口径和渲染口径必须是同一套。
   */
  const missionTotal = screen.domains.reduce(
    (n, d) => n + (d.commitment ? d.commitment.items : d.missions.length),
    0
  );

  return (
    <>
      <PanelHead
        eyebrow={`${screen.period.label} · 到期 ${formatDay(screen.company.dueOn)} · 还有 ${screen.daysLeft} 天`}
        title="目标与任务"
      />

      {/*
       * 树根。总 Outcome 原文照录，衬线 —— 这是公司自己写下的那句话，不是产品在说话。
       * 底下那条竖线从这句话直接长出来，四个域挂在同一条干上。
       */}
      <section className="border-l-2 border-l-solid pl-4">
        <p className="report text-md leading-relaxed text-ink">
          {screen.company.statement}
        </p>
        <p className="meta mt-2 text-ink-faint">
          {screen.company.id} · {screen.domains.length} 个业务域 · {missionTotal} 条 Mission
        </p>
      </section>

      <ul className="mt-1">
        {screen.domains.map((domain, i) => (
          <DomainBranch
            key={domain.code}
            domain={domain}
            last={i === screen.domains.length - 1}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * 一个业务域。
 *
 * 竖干由这一行自己画：`h-full` 一直画到下一个域，最后一个域只画到自己那条横枝为止 ——
 * 否则树干会从最后一片叶子底下伸出去一截，指向不存在的东西。
 */
function DomainBranch({
  domain,
  last,
}: {
  domain: OutcomeScreen["domains"][number];
  last: boolean;
}) {
  const [open, setOpen] = useState(true);

  /**
   * 收起那一行的条数：有承诺时数承诺的条目，无承诺时数种子 Mission。
   */
  const missionCount = domain.commitment ? domain.commitment.items : domain.missions.length;

  return (
    <li className="relative pl-6">
      <span
        aria-hidden
        className={cn("absolute left-0 top-0 w-px bg-hairline", last ? "h-6" : "h-full")}
      />
      <span aria-hidden className="absolute left-0 top-6 h-px w-5 bg-hairline" />

      <div className="pt-3.5 pb-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex w-full items-baseline gap-2 rounded-[3px] text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "mt-[3px] size-3.5 flex-none text-ink-faint transition-transform duration-base ease-swift",
              open && "rotate-90",
            )}
          />
          <span className="meta flex-none tabular-nums text-ink-faint">{domain.code}</span>
          <span className="min-w-0 text-base font-medium text-ink transition-colors duration-fast group-hover:text-judgment">
            {domain.name}
          </span>
        </button>

        <div className={cn("pl-[22px]", domain.shaking && "border-l-2 border-l-counter")}>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{domain.outcome}</p>

          <p className="meta mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-faint">
            <span className="text-ink-muted">{domain.driName}</span>
            {!domain.commitment && <span>Commitment {domain.commitmentStatus}</span>}
            <Link
              href={domain.href}
              className="rounded-[3px] tabular-nums underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
            >
              判断 {domain.confirmed}/{domain.total} 已确认
            </Link>
            {!open && missionCount > 0 && (
              <span>{missionCount} 条 Mission</span>
            )}
          </p>

          {domain.shaking && (
            <p className="meta mt-1.5 text-counter">{domain.shaking}</p>
          )}

          {/*
           * 本期承诺状态与入口。只在 commitment 非 null 时出现。
           * submitted 那一行是这一页唯一的写入口，要看得见（不是灰的小字）。
           */}
          {domain.commitment && (
            <div className="mt-2">
              {domain.commitment.status === "drafted" && (
                <p className="text-sm text-ink-muted">
                  纲领已下发，等 {domain.driName} 标注
                </p>
              )}
              {domain.commitment.status === "submitted" && (
                <Link
                  href={domain.commitment.href}
                  className="inline-block text-sm text-ink underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:decoration-ink-faint"
                >
                  {domain.driName} 回传了 {domain.commitment.items} 条，其中{" "}
                  {domain.commitment.changed} 条改了提案 → 逐条裁决
                </Link>
              )}
              {domain.commitment.status === "adjudicated" && (
                <Link
                  href={domain.commitment.href}
                  className="inline-block text-sm text-ink underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:decoration-ink-faint"
                >
                  你裁完了，等 {domain.driName} 修订
                </Link>
              )}
              {domain.commitment.status === "effective" && (
                <p className="text-sm text-ink-muted">
                  已生效 · 第 {domain.commitment.rounds} 轮收敛
                </p>
              )}
            </div>
          )}

          {/*
           * Mission 层的显示规则：有承诺时显示一行条数，无承诺时显示种子里的示例。
           * 这不是「两套渲染」，而是如实反映这一期有没有真实承诺。
           */}
          {open && domain.commitment && (
            <div className="mt-3">
              {domain.commitment.status === "drafted" ? (
                <p className="meta text-ink-faint">
                  本期承诺的 {domain.commitment.items} 条，等 {domain.driName} 逐条标注
                </p>
              ) : (
                <p className="meta text-ink-faint">
                  本期承诺的 {domain.commitment.items} 条
                </p>
              )}
            </div>
          )}

          {open && !domain.commitment && domain.missions.length > 0 && (
            <ul className="animate-fade mt-3 space-y-2.5">
              {domain.missions.map((m) => (
                <MissionLeaf key={m.id} mission={m} />
              ))}
            </ul>
          )}

          {open && !domain.commitment && domain.missions.length === 0 && (
            <p className="meta mt-3 text-ink-faint">这个域下面还没有 Mission</p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 一片叶子：一条 Mission 和它那个真里程碑。
 *
 * 里程碑照抄执行计划的原话（「第 60 天评审会初定方向」「M30 可内部演示」），不折算成
 * 日期也不折算成百分比 —— 那两样都要我替 DRI 编一个他没承诺过的数。
 *
 * 这一行不写人名：当下每条 Mission 的 DRI 都是本域 DRI，域那一行已经写了一遍。哪天
 * 出现跨域派给别人的 Mission，再在这里补一个名字。
 */
function MissionLeaf({ mission }: { mission: MissionCard }) {
  const status = STATUS_WORD[mission.status];

  return (
    <li className="relative pl-4">
      <span
        aria-hidden
        className={cn("absolute left-0 top-[7px] size-2 rounded-full", status.dot)}
      />
      <p className="text-sm leading-relaxed text-ink">{mission.name}</p>
      <p className="meta mt-0.5 flex flex-wrap items-baseline gap-x-2 text-ink-faint">
        <span className="tabular-nums">{mission.code}</span>
        <span className="text-ink-muted">{status.word}</span>
        <span>{mission.milestone}</span>
      </p>
    </li>
  );
}

function OutcomesSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-56" />
      <span className="skeleton mt-3 block h-5 w-32" />
      <span className="skeleton mt-6 block h-4 w-full" />
      <span className="skeleton mt-1.5 block h-4 w-[72%]" />
      <div className="mt-8 space-y-7">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="pl-6">
            <span className="skeleton block h-4 w-40" />
            <span className="skeleton mt-2.5 block h-3 w-full" />
            <span className="skeleton mt-1.5 block h-3 w-[58%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
