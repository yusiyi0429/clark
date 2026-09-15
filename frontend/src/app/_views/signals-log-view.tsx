"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { CodeText } from "@/components/provenance/code-ref";
import { api } from "@/lib/data/client";
import type { CardDisposition, SignalLogEntry } from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 潜在议题 · 处置记录。
 *
 * 每个被发现的信号最终去了哪，一条不落：启动深研的、指派出去的、待定的、搁置的。
 * 潜在议题那一屏只留未处置的 —— 历史不占今天的注意力，但历史必须有账。
 */

const DISPOSITION_LABEL: Record<CardDisposition, { text: string; tone: string }> = {
  discuss: { text: "深度研究", tone: "text-confirmed" },
  watch: { text: "待定", tone: "text-ink-muted" },
  dismiss: { text: "搁置", tone: "text-ink-faint" },
};

export function SignalsLogView() {
  const resource = useResource<SignalLogEntry[]>("signals-log", () => api.listSignalLog());

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<LogSkeleton />}>
        {(entries) => (
          <>
            <PanelHead
              eyebrow={`潜在议题 · 处置记录 · ${entries.length} 条`}
              title="每个被发现的信号，最终去了哪。"
              actions={
                <Link
                  href="/signals"
                  className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
                >
                  回潜在议题 →
                </Link>
              }
            />

            {entries.length === 0 ? (
              <PanelEmpty title="还没有处置记录。" />
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
                    key={e.card.id}
                    className="stagger row row-link concentric"
                    style={{ "--i": i } as React.CSSProperties}
                  >
                    <Link
                      href={
                        e.disposition === "discuss" ? `/issues/${e.issueId}` : "/archive"
                      }
                      className="block px-3.5 py-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="meta tabular-nums text-ink-faint">
                          {formatStamp(e.at)}
                        </span>
                        <span
                          className={cn(
                            "meta font-medium",
                            DISPOSITION_LABEL[e.disposition].tone,
                          )}
                        >
                          {e.assigneeName
                            ? `深度研究 · 指派 ${e.assigneeName}`
                            : DISPOSITION_LABEL[e.disposition].text}
                        </span>
                        <span className="meta text-ink-faint">{e.issueId}</span>
                        <span className="meta text-ink-faint">
                          抓取于 {formatStamp(e.card.createdAt)}
                        </span>
                      </div>
                      <p className="report mt-1 text-md leading-relaxed text-ink">
                        <CodeText text={e.card.what[0]?.text ?? e.issueTitle} />
                      </p>
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
      <span className="skeleton mt-2.5 block h-5 w-[52%]" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-7 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3">
            <span className="skeleton block h-2.5 w-56" />
            <span className="skeleton mt-2 block h-4 w-[82%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
