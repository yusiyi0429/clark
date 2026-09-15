"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { StateBadge } from "@/components/state-badge";
import { PROBE_ROUTE_LABEL, ROUTE_LABEL, api } from "@/lib/data/client";
import type { DecisionEntry, QuickDecision } from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 页面5 会后确认 —— 五个环节的最后一格。
 *
 * 会已经开完了，事已经拍了。散会那一刻 Agent 就把七要素草案装配好了，一号位在这里只
 * 做一件事：把它确认掉。**这一页的主语是「待确认」** —— 已确认的那些沉到下面，是凭据，
 * 不是这一页存在的理由。
 *
 * 所以没有筛选器、没有统计图、也没有归档视图。会后半小时之内点完那几份，这一页就该是
 * 空的。
 *
 * 决策进这一页有两条路：开会（Closure，大卡）和议题研究里对候选决策的**直接确认**
 * （小卡一节）。小卡不假装是 Closure —— 它没有七要素，它有的是「确认那一下写回了
 * 什么」，这也是它全部需要证明的东西。
 */
export function DecisionsView({ bare = false }: { bare?: boolean } = {}) {
  const resource = useResource<DecisionEntry[]>("decisions", () => api.listDecisions());
  const quickRes = useResource<QuickDecision[]>("decisions:quick", () =>
    api.listQuickDecisions(),
  );
  const unwritten = resource.data?.filter((d) => d.draft.writeBack === null).length ?? 0;
  /* 会议页把它嵌在两挡滑块下面，那一层已经有页容器了 —— 不要套两层。 */
  const Shell = bare ? BareShell : Panel;

  return (
    <Shell>
      <AsyncBoundary resource={resource} skeleton={<DecisionsSkeleton />}>
        {(entries) => (
          <>
            <PanelHead
              className={bare ? "pb-0" : undefined}
              eyebrow={bare ? undefined : `会后确认 · 待确认 ${unwritten} 件`}
              title={
                unwritten > 0
                  ? `${unwritten} 件等您确认。`
                  : "拍过的都已经确认过了。"
              }
            />

            <QuickDecisions items={quickRes.data ?? []} />

            {entries.length === 0 ? (
              <PanelEmpty title="现在没有要确认的决定。">
                <Link
                  href="/issues"
                  className="meta text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
                >
                  去议题列表 →
                </Link>
              </PanelEmpty>
            ) : (
              <Lists entries={entries} />
            )}
          </>
        )}
      </AsyncBoundary>
    </Shell>
  );
}

/**
 * 议题研究里直接确认的那几张小卡。
 *
 * 没上会 —— 认知修订、布控靶点这类，读完研究就该定；定了照样全程留痕、照样可重开。
 * 空则整节不渲染：它是第二条路的凭据，不是这一页的主体。
 */
function QuickDecisions({ items }: { items: QuickDecision[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-7">
      <h2 className="meta mb-2.5 text-ink-faint">
        议题研究里直接确认 · {items.length}
      </h2>
      {/*
        * 一块面装这一节，不是一条条浮着的小卡。
        *
        * 没有 `space-y`：行贴着行，两行之间那条从内容左沿起画的发丝线由 `.row`
        * 自己负责，留了缝这条线就没有中缝可贴。
        */}
      <ul className="card overflow-hidden">
        {/*
          * `row row-link concentric` 挂在 `<li>` 上而不是里面那个 `<Link>`：缝里那条
          * 发丝线是 `.row + .row` 画的，只认**相邻兄弟** —— 挂到 `<Link>` 上每一行
          * 就各自被 `<li>` 包着，谁也不是谁的兄弟，线一条都不出。内边距仍归 `<Link>`。
          */}
        {items.map((q) => (
          <li key={q.decisionId} className="row row-link concentric">
            <Link href={`/issues/${q.issueId}`} className="block px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <span className="meta text-ink-faint">{q.decisionId}</span>
                <span className="meta text-ink-faint">{formatStamp(q.at)}</span>
                <span className="meta text-ink-faint">来自 {q.issueId}</span>
              </div>
              <p className="report mt-1 text-md text-ink">{q.nodeText}</p>
              <p className="meta mt-1.5 text-confirmed">
                {PROBE_ROUTE_LABEL[q.route]} · 写回 {q.updatedObjects.length} 个对象
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 两段。待确认的那几份在上面，已确认的沉到一条发丝线以下。
 *
 * 不做成一个可切换的筛选器：待确认那一段清空之后，这一页自己就退成一份凭据清单，
 * 不需要他再点一次「只看待确认」。
 */
function Lists({ entries }: { entries: DecisionEntry[] }) {
  const open = entries.filter((e) => e.draft.writeBack === null);
  const done = entries.filter((e) => e.draft.writeBack !== null);

  return (
    <>
      {open.length > 0 && (
        /* 一块面装这一段。没有 `space-y` —— 行贴着行，缝里那条发丝线由 `.row` 画。 */
        <ul className="card mt-7 overflow-hidden">
          {open.map((entry, i) => (
            <li
              key={entry.issue.id}
              className="stagger row row-link concentric"
              style={{ "--i": i } as React.CSSProperties}
            >
              <Row entry={entry} />
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <section className={cn(open.length > 0 ? "mt-9 border-t border-hairline pt-5" : "mt-7")}>
          <h2 className="meta text-ink-faint">已确认 {done.length} 件</h2>
          <ul className="card mt-3 overflow-hidden">
            {done.map((entry, i) => (
              <li
                key={entry.issue.id}
                className="stagger row row-link concentric"
                style={{ "--i": i } as React.CSSProperties}
              >
                <Row entry={entry} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * 一份 Closure 草案。
 *
 * 待确认的顶着 judgment 色的左边，并且把会后过了多久写在上面 —— 会后半小时之内确认掉
 * 是这个环节的规矩，这个数字就是那条规矩在屏幕上的样子。它不是催办红点：它是一句可
 * 核对的事实。**所以没上会的那些不写这个数字**：那一条路上没有「散会」这个时刻，
 * 写一个 0 就是把一句可核对的事实换成了一个读得出错的数字。
 *
 * 已确认的那些写清楚走了哪一条分流，以及那次写回动了几个对象。四条路的后果完全不同，
 * 只写「已完成」等于把最关键的那一个字省掉了。
 */
function Row({ entry }: { entry: DecisionEntry }) {
  const { issue, draft } = entry;
  const written = draft.writeBack;

  return (
    <Link
      href={`/decisions/${issue.id}`}
      className={cn(
        /* `row row-link concentric` 在外面那个 `<li>` 上 —— 缝里那条发丝线只认相邻兄弟。 */
        "block px-3.5 py-3.5",
        written === null && "border-l-2 border-l-judgment",
      )}
    >
      <div className="flex items-center gap-2.5">
        <StateBadge state={issue.state} />
        <span className="meta text-ink-faint">{issue.id}</span>
        {draft.sourceMeetingId ? (
          <span className="meta text-ink-faint">{draft.sourceMeetingId}</span>
        ) : null}
      </div>

      <p className="report mt-1 text-lg text-ink">{issue.title}</p>

      {written === null ? (
        <p className="meta mt-1.5 text-judgment">
          待确认
          {draft.minutesSinceMeeting !== null ? ` · 会后 ${draft.minutesSinceMeeting} 分钟` : ""}
          {draft.revises.length > 0
            ? ` · 确认后将翻版 ${draft.revises.map((r) => r.judgmentId).join("、")}`
            : ""}
        </p>
      ) : (
        <p className="meta mt-1.5 text-confirmed">
          {ROUTE_LABEL[written.route]} · 写回 {written.updatedObjects.length} 个对象
          {written.triggersArmed > 0 ? ` · 布控 ${written.triggersArmed} 条重开条件` : ""}
        </p>
      )}
    </Link>
  );
}

/** 嵌进别的页面时的空壳：只保留一条阅读宽度，不再加第二层页边距。 */
function BareShell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[780px]">{children}</div>;
}

function DecisionsSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-2.5 block h-5 w-[48%]" />
      <span className="skeleton mt-2 block h-3 w-[72%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-7 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3.5">
            <span className="skeleton block h-2.5 w-36" />
            <span className="skeleton mt-2 block h-4 w-[78%]" />
            <span className="skeleton mt-2 block h-2.5 w-44" />
          </div>
        ))}
      </div>
    </div>
  );
}
