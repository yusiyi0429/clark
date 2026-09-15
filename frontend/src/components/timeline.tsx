"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { formatStamp } from "@/lib/format";
import type { TimelineEvent, TimelineEventKind } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * Context 时间线 —— 这一页的主体，不是"带附件的详情页"。
 *
 * What is open by default is a judgement, not a preference: organisational
 * moves and state transitions lead somewhere, so they are open; process
 * (signals arriving, rounds of talk, research finishing) does not, so it folds.
 * That rule is why this page stays readable as an issue accumulates history.
 */

const KIND: Record<TimelineEventKind, { label: string; dot: string }> = {
  state: { label: "状态迁移", dot: "bg-ink" },
  signal: { label: "Signal", dot: "bg-factual" },
  talk: { label: "对谈", dot: "bg-ink-faint" },
  deep: { label: "深研", dot: "bg-factual" },
  handoff: { label: "交接", dot: "bg-judgment" },
  judgment: { label: "Judgment", dot: "bg-judgment" },
  decision: { label: "Decision", dot: "bg-confirmed" },
  trigger: { label: "Trigger", dot: "bg-counter" },
};

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="relative">
      <span
        aria-hidden
        className="absolute top-2 bottom-2 left-[3.5px] w-px bg-rule"
      />
      {events.map((event) => (
        <TimelineRow key={event.id} event={event} />
      ))}
    </ol>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(event.defaultOpen);
  const kind = KIND[event.kind];
  const expandable = Boolean(event.detail);

  return (
    <li className="relative pb-6 pl-6">
      <span
        aria-hidden
        className={cn(
          "absolute top-[7px] left-0 size-2 rounded-full ring-4 ring-paper",
          kind.dot
        )}
      />

      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <span className="meta text-ink-faint">{formatStamp(event.at)}</span>
        <span className="meta rounded-[3px] bg-neutral-wash px-1.5 text-ink-muted">
          {kind.label}
        </span>
      </div>

      <p className="mt-1 text-[0.9375rem] leading-relaxed text-ink">
        {event.headline}
      </p>

      {event.actor && (
        <p className="meta mt-0.5 text-ink-faint">{event.actor}</p>
      )}

      {expandable &&
        (open ? (
          <p className="mt-2 rounded-md border-l-2 border-rule bg-surface px-3 py-2 text-[0.875rem] leading-[1.75] whitespace-pre-line text-ink-muted">
            {event.detail}
          </p>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            onClick={() => setOpen(true)}
            className="meta mt-1.5 inline-flex items-center gap-1 text-ink-faint transition-colors hover:text-ink-muted"
          >
            展开
            <ChevronDown className="size-3" />
          </button>
        ))}
    </li>
  );
}
