"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { ClosureCheck } from "@/components/meeting/closure-check";
import { MeetingPrepPane } from "@/components/meeting/prep";
import { Panel } from "@/components/panel";
import { api } from "@/lib/data/client";
import type { IssueMeeting } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 会议 —— 一件议题的那一场。
 *
 * 一场会只有两头：**进去之前**要读的那份会前报告，和**散会之后**要核的那几条。中间
 * 隔的是会本身。
 *
 * 这一页不选业务域：会议与议题强绑定，域是议题自己的属性，在这里再选一次等于允许
 * 屏幕上出现「A 域的会 + B 域的议题」这种对不上的组合。
 */

export type MeetingStage = "pre" | "post";

export function MeetingsView({
  issueId,
  stage,
}: {
  issueId: string;
  stage: MeetingStage;
}) {
  const res = useResource<IssueMeeting>(`issue-meeting:${issueId}`, () =>
    api.getIssueMeeting(issueId),
  );

  return (
    <Panel width="full" className="pt-5 pb-8">
      <AsyncBoundary resource={res} skeleton={<MeetingSkeleton />}>
        {(m) => (
          <div className="mx-auto w-full max-w-[1200px]">
            <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1">
                <p className="meta text-ink-faint">{m.issue.id}</p>
                {/* 页面标题一律 `text-lg`（17px），见 `PanelHead`。这一页不进纸，所以自己写。 */}
                <h1 className="report mt-1 text-lg leading-relaxed text-ink">
                  {m.issue.title}
                </h1>
              </div>

              <nav aria-label="会议两挡" className="flex-none">
                <div className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface p-1">
                  <StageTab href={`/meetings?issue=${issueId}`} active={stage === "pre"}>
                    会前准备
                  </StageTab>
                  <StageTab
                    href={`/meetings?issue=${issueId}&stage=post`}
                    active={stage === "post"}
                  >
                    会后确认
                  </StageTab>
                </div>
              </nav>
            </header>

            <div className="mt-6">
              {stage === "pre" ? (
                <MeetingPrepPane issueId={issueId} meeting={m} />
              ) : (
                <ClosureCheck meeting={m} onChange={() => void res.mutate()} />
              )}
            </div>
          </div>
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function StageTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2 rounded-full px-5 text-base transition-colors duration-fast ease-swift",
        active
          ? "bg-solid font-medium text-solid-fg"
          : "text-ink-muted hover:bg-neutral-wash hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

function MeetingSkeleton() {
  return (
    <div aria-live="polite" className="mx-auto w-full max-w-[1200px]">
      <span className="skeleton block h-2.5 w-24" />
      <span className="skeleton mt-2.5 block h-5 w-[62%]" />
      <span className="skeleton mt-8 block h-16 w-full rounded-xl" />
      <span className="skeleton mt-4 block h-4 w-[86%]" />
      <span className="skeleton mt-2 block h-4 w-[74%]" />
    </div>
  );
}
