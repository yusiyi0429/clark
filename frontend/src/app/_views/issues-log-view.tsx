"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import type { IssueLogEntry, TimelineEventKind } from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 战略议题 · 去向记录。
 *
 * 全部议题的组织动作摊成一条流水：状态迁移、深研完成、交接分发、判断回传、决策
 * 固化。列表页答「现在都在哪」，这一页答「都是怎么走到那的」—— 全程数据落库可
 * 回放，这是那句承诺的账本形态。
 */

const KIND_LABEL: Record<TimelineEventKind, { text: string; tone: string }> = {
  state: { text: "状态", tone: "text-ink-muted" },
  signal: { text: "信号", tone: "text-factual" },
  talk: { text: "对谈", tone: "text-ink-faint" },
  deep: { text: "深研", tone: "text-factual" },
  handoff: { text: "交接", tone: "text-judgment" },
  judgment: { text: "判断", tone: "text-judgment" },
  decision: { text: "决策", tone: "text-confirmed" },
  trigger: { text: "布控", tone: "text-confirmed" },
};

export function IssuesLogView() {
  const resource = useResource<IssueLogEntry[]>("issues-log", () => api.listIssueLog());

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<LogSkeleton />}>
        {(entries) => (
          <>
            <PanelHead
              eyebrow={`战略议题 · 去向记录 · ${entries.length} 条`}
              title="每件议题的每一步，都在这儿。"
              actions={
                <Link
                  href="/issues"
                  className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
                >
                  回战略议题 →
                </Link>
              }
            />

            {entries.length === 0 ? (
              <PanelEmpty title="还没有记录。" />
            ) : (
              /*
               * 一块面装一份流水，不是一条条浮着的卡片。
               *
               * 没有 `space-y`：行贴着行，两行之间那条从内容左沿起画的发丝线由
               * `.row` 自己负责，留了缝这条线就没有中缝可贴。
               */
              <ul className="card mt-7 overflow-hidden">
                {entries.map((e, i) => (
                  /*
                   * `row row-link concentric` 挂在 `<li>` 上而不是里面那个 `<Link>`：
                   * 缝里那条发丝线是 `.row + .row` 画的，只认**相邻兄弟**，
                   * 挂到 `<Link>` 上每一行就各自被 `<li>` 包着，谁也不是谁的兄弟，
                   * 线一条都不出。内边距仍归 `<Link>`，整行照旧整块可点。
                   */
                  <li
                    key={`${e.issueId}-${e.at}-${i}`}
                    className="stagger row row-link concentric"
                    style={{ "--i": i } as React.CSSProperties}
                  >
                    <Link href={`/issues/${e.issueId}`} className="block px-3.5 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="meta tabular-nums text-ink-faint">
                          {formatStamp(e.at)}
                        </span>
                        <span className={cn("meta font-medium", KIND_LABEL[e.kind].tone)}>
                          {KIND_LABEL[e.kind].text}
                        </span>
                        <span className="meta text-ink-faint">{e.issueId}</span>
                        {e.actor ? (
                          <span className="meta text-ink-faint">{e.actor}</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-base leading-relaxed text-ink">{e.headline}</p>
                      <p className="meta mt-0.5 clamp-2 text-ink-faint">{e.issueTitle}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function LogSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-44" />
      <span className="skeleton mt-2.5 block h-5 w-[48%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-7 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3">
            <span className="skeleton block h-2.5 w-56" />
            <span className="skeleton mt-2 block h-4 w-[70%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
