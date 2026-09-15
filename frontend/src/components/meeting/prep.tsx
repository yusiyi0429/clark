"use client";

import { Bot, Check, FileText, UserRound } from "lucide-react";
import { BriefView } from "@/app/_views/brief-view";
import type { IssueMeeting, MeetingIntakeItem } from "@/lib/data/types";

/**
 * 会前准备。
 *
 * 两块，上下：**收了什么**，然后**出了什么**。
 *
 * 顺序就是这套机制本身：会前报告不是凭空写的，它是材料、CEO Agent 的意见和 DRI 的
 * 反馈都到齐之后才出的。把「文档已收集」摆在报告上面，读报告的人一眼就知道这份东西
 * 站在什么之上；反过来先给报告，那一行收集清单就只是脚注。
 */
export function MeetingPrepPane({
  issueId,
  meeting,
}: {
  issueId: string;
  meeting: IssueMeeting;
}) {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-hairline bg-surface px-6 py-5">
        <p className="flex items-center gap-2 text-md font-medium text-confirmed">
          <Check className="size-4" aria-hidden />
          文档已收集
        </p>
        <ul className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {meeting.intake.map((it, i) => (
            <IntakeRow key={i} item={it} />
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-hairline bg-surface px-6 py-6">
        <BriefView id={issueId} bare />
      </section>
    </div>
  );
}

const ICON = {
  material: FileText,
  agent: Bot,
  dri: UserRound,
} as const;

function IntakeRow({ item }: { item: MeetingIntakeItem }) {
  const Icon = ICON[item.kind];
  return (
    <li className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
      <Icon className="mt-[3px] size-3.5 shrink-0 text-ink-faint" aria-hidden />
      <span className="min-w-0">{item.label}</span>
    </li>
  );
}
