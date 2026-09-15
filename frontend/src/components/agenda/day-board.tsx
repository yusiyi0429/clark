"use client";

import { useMemo } from "react";

import {
  domainsOfSlot,
  fullDayLabel,
  halfLabel,
  HALVES,
  nextDay,
  prevDay,
  slotIdOf,
  slotPast,
} from "@/lib/data/agenda";
import type { DayHalf, DomainSummary, IssueSummary, MeetingSlot } from "@/lib/data/types";
import { cn } from "@/lib/utils";
import { useClock } from "./clock";
import { meetStyle } from "./tone";

/**
 * 日程 —— 编排会议那一页的右半边。**一次只看一天，一天只分两格。**
 *
 * ## 为什么只有上午和下午
 *
 * 一号位在这一屏上做的决定是「这件事排在哪一天的哪一段」。几点开始是助理后面才落实的事，
 * 把它塞进来，等于让他在排十件议题的时候连做十次「14:00 还是 14:30」——十次都不是他的
 * 决定。粒度降到两格之后，这一整页就只剩一个动作：把一张卡拖到一个格子里。
 *
 * ## 一天一屏，不是一个月的格子
 *
 * 月视图要他先找到今天在哪儿。这一页给一天，左右翻 —— 翻页的代价是一次点击，而找一天
 * 的代价是一次搜索。
 *
 * ## 拖着还没松手的时候
 *
 * 落区自己亮起来（`.drop-zone[data-over]`），而不是画一条插入线：**落点是一块面积，
 * 不是两行之间的一条缝**。格子里已经排了议题的话，那几张卡就在格子里摆着 —— 他松手之前
 * 就看得见「这一段会把这几件一起谈」。
 */
export function DayBoard({
  date,
  today,
  slots,
  issues,
  domains,
  over,
  onDate,
  onZoneRef,
  onEndMeeting,
  onInvite,
  busy,
}: {
  date: string;
  today: string;
  /** 全部会议。这一页只画 `date` 那两格，但颜色要按全局时间序取。 */
  slots: MeetingSlot[];
  /** 全部在办议题 —— 格子里那几张卡的标题从这里取。 */
  issues: IssueSummary[];
  domains: DomainSummary[];
  /** 此刻手指压在哪一格上（拖动中）。没在拖就是 null。 */
  over: DayHalf | null;
  onDate: (next: string) => void;
  /** 把两个落区的 DOM 交出去 —— 拖动那一层要拿它们的位置判落点。 */
  onZoneRef: (half: DayHalf, el: HTMLElement | null) => void;
  onEndMeeting: (slotId: string) => void;
  onInvite: (slotId: string) => void;
  busy: boolean;
}) {
  const clock = useClock();

  /* 颜色按时间序取，和议题栏、会后那一栏同一个口径。 */
  const seqOf = useMemo(() => {
    const ordered = [...slots].sort((a, b) =>
      `${a.date}-${a.half}`.localeCompare(`${b.date}-${b.half}`),
    );
    const m = new Map(ordered.map((s, i) => [s.id, i] as const));
    return (slotId: string) => m.get(slotId) ?? 0;
  }, [slots]);

  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i] as const)), [issues]);
  const domainName = useMemo(() => {
    const m = new Map(domains.map((d) => [d.id, d.name] as const));
    return (id: string) => m.get(id) ?? id;
  }, [domains]);

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-10 items-center gap-2 px-1">
        <Step label="前一天" onClick={() => onDate(prevDay(date))}>
          ‹
        </Step>
        <h2 className="text-md font-medium text-ink">
          {fullDayLabel(date)}
          {date === today ? (
            <span className="meta ml-2 text-ink-faint">今天</span>
          ) : date === nextDay(today) ? (
            <span className="meta ml-2 text-ink-faint">明天</span>
          ) : null}
        </h2>
        <Step label="后一天" onClick={() => onDate(nextDay(date))}>
          ›
        </Step>
        {date !== today && (
          <button
            type="button"
            onClick={() => onDate(today)}
            className="meta ml-auto rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
          >
            回到今天
          </button>
        )}
      </header>

      <div className="scroll-slim min-h-0 space-y-3 overflow-y-auto p-2">
        {HALVES.map((half) => {
          const slot = slots.find((s) => s.id === slotIdOf(date, half));
          /*
           * 这一格过去了没有。**过去了的不收东西，也不给动。**
           *
           * 他在这一页上做的事是「安排接下来」。一格已经过去的时间不是一个可以往里放东西
           * 的地方 —— 往里放，得到的是一件立刻显示成「等你确认会后要点」的议题，而那场会
           * 上根本没谈过它（数据层也会挡，见 `scheduleIssue`）。
           *
           * 服务端那一帧 `clock` 是 null，按「还没过去」画：差的是几毫秒，而反过来（按
           * 「过去了」画）会让今天的日程在首屏闪一下灰。
           */
          const past = clock ? slotPast({ date, half }, clock) : false;
          const list = (slot?.issueIds ?? [])
            .map((id) => byId.get(id))
            .filter(Boolean) as IssueSummary[];
          const attending = slot
            ? domainsOfSlot(slot, (id) => byId.get(id)?.domainId).map(domainName)
            : [];
          return (
            <section
              key={half}
              /* 过去了的那一格不注册落区 —— 拖动那一层靠这张表做命中判定，表里没有它，
                 就不可能落进去，也不会亮。挡在这里而不是挡在松手那一刻，是因为「亮起来了
                 却放不进去」比「压根不亮」难懂得多。 */
              ref={(el) => onZoneRef(half, past ? null : el)}
              data-over={!past && over === half}
              style={slot ? meetStyle(seqOf(slot.id)) : { ["--meet" as string]: "var(--meet-b)" }}
              className={cn(
                "drop-zone concentric min-h-[8rem] rounded-xl border p-2",
                /* 虚线边是「这里可以放东西」。过去了的那一格放不了，所以它没有边。 */
                past ? "border-transparent" : "border-dashed border-hairline",
                slot && "border-solid border-transparent",
              )}
            >
              <header className="flex items-baseline gap-2 px-1.5 pb-2">
                <span className="text-sm font-medium text-ink">{halfLabel(half)}</span>
                {attending.length > 0 && (
                  <span className="meta min-w-0 truncate text-ink-faint">
                    {attending.join(" · ")}
                  </span>
                )}
                {slot ? (
                  <span className="ml-auto flex shrink-0 items-center gap-3">
                    {/*
                      * 过去了的那一场只剩一句「已结束」。
                      *
                      * `参会范围` 没了：改不了谁参加过一场已经开完的会。`标记会议结束`
                      * 也没了 —— 它现在只有一个用处，就是「会提前散了，别等到点」，
                      * 而到点之后按它没有任何意义。剩下要办的事——交纪要在秘书那一侧
                      * 的 `/sec/debriefs`，会后归一号位的执行项在首页右栏的动态面板
                      * （`DynamicPanel`，相二把原来那叠 `DebriefColumn` 撤了）。
                      */}
                    {past || slot.endedAt ? (
                      <span className="meta text-ink-faint">已结束</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onInvite(slot.id)}
                          className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted disabled:opacity-40"
                        >
                          参会范围
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onEndMeeting(slot.id)}
                          className="meta rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink disabled:opacity-40"
                        >
                          标记会议结束
                        </button>
                      </>
                    )}
                  </span>
                ) : null}
              </header>

              {list.length === 0 ? (
                /* 空格子里什么都不写。虚线边本身就是「这里可以放东西」，再加一句
                   「把议题拖到这里」是把一个画法说过的事再说一遍。 */
                <div className="h-12" />
              ) : (
                <div className="space-y-1.5">
                  {list.map((issue) => (
                    <div
                      key={issue.id}
                      className="meet-face dither concentric rounded-lg px-3 py-2"
                      style={slot ? meetStyle(seqOf(slot.id)) : undefined}
                    >
                      <span className="meta block [color:var(--meet-fg-dim)]">{issue.id}</span>
                      <span className="clamp-2 block text-sm leading-relaxed [color:var(--meet-fg)]">
                        {issue.title}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Step({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-md text-md text-ink-faint transition-colors duration-fast hover:bg-wash-hover hover:text-ink"
    >
      {children}
    </button>
  );
}
