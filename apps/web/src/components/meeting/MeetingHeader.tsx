"use client";

/**
 * 会议页的页头（clark `detail-header/meeting.tsx`，C-08）：
 *
 * - `MeetingSlotLabel`：页头胶囊里标题前面那一段，这场会的计划时段。日子是一小段灰字，时段是这一排最醒目的字：
 *   「今天 14:00–15:30」。它站在眉题的位置，会议页不再另写眉题。
 * - `MeetingClock`：页头右边单独一颗胶囊（`data-header-end`）。会前写「开始会议」；按下去换成计时（「会议中」和走着的
 *   分:秒）；点计时弹出一小块，里面是「这场会开完了」。开完之后写「已开完」和几点，不能再按。
 * - `MeetingHeaderActions`：把上面两样和页头右边那一样（会开完了是「会前预审 ｜ 会议记录」两段切换）按页头的约定排好。
 * - `MeetingStatus`：材料上面一行灰字：谁主持、几人参会这类事实，再加这一刻的一件事。
 * - `feishuLive`：在飞书约上的会跟着飞书会议真实开始和结束（会开到哪一步、入会和改期入口在进度线 MeetingProgress 上）。
 *
 * 「开始会议」同时开始录音（useMeetingRecorder），计时只是这一页的状态；「这场会开完了」停下录音、交给服务端转写，
 * 并写进后台（meeting.end）。天枢没有会中 Co-Agent，所以不写「Co-Agent 在听」，写的是录没录上。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { Check, ChevronDown, Radio } from "lucide-react";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import type { TMeetingCardPayload } from "@warmap/contracts";
import s from "@/styles/meeting-header.module.css";

export type MeetingPhase = "idle" | "live" | "ended";

/** 一场会的计划时段：公司时区的 `HH:mm`，二十四小时制。 */
export interface MeetingSlot {
  startsAt: string;
  endsAt: string;
}

/** 开完了压过一切；这一页上按过「开始会议」就是在开；否则还没开始。 */
export function meetingPhase(startedAt: number | undefined, ended: boolean): MeetingPhase {
  if (ended) return "ended";
  return startedAt === undefined ? "idle" : "live";
}

export function elapsed(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

const clockOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
const dateKey = (date: Date) => date.toLocaleDateString("en-CA", { timeZone: COMPANY_TIMEZONE });

/** 后台给的开始、结束时刻 → 页头上的 `14:00`–`15:30`。 */
export function meetingSlot(scheduledAt: string, endsAt: string): MeetingSlot {
  return { startsAt: clockOf(scheduledAt), endsAt: clockOf(endsAt) };
}

/** 页头上的日子：今天、明天、后天、昨天；再远写这场会的日子（「9 月 22 日」）。按公司时区的日历日算。 */
export function meetingDayWord(scheduledAt: string, now: Date = new Date()): string {
  const day = Date.parse(dateKey(new Date(scheduledAt)));
  const today = Date.parse(dateKey(now));
  const offset = Math.round((day - today) / 86_400_000);
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  if (offset === 2) return "后天";
  if (offset === -1) return "昨天";
  const [, month, date] = dateKey(new Date(scheduledAt)).split("-").map(Number);
  return `${month} 月 ${date} 日`;
}

/** 公司时区的月/日 时:分（记下开完那一刻用）；认不出来的写成空。 */
export function localClock(at: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** 过了预约结束这么久还没收到飞书会议开始，算没开成。 */
export const MISSED_AFTER_MS = 30 * 60_000;

/**
 * 在飞书约上的会（booked）跟着飞书会议真实开始和结束，不按预约时间：waiting 还没开（到了预约时间也是）、live 开着、
 * ended 开完了（收到结束、主持人点了结束、或已进会后流程）、missed 没开成（过了预约结束 30 分钟还没开始，也没找到妙记）。
 * 不在飞书约上的会为 null，照旧按预约时间算。
 */
export type FeishuLive = "waiting" | "live" | "ended" | "missed";

export function feishuLive(
  payload: Pick<TMeetingCardPayload, "status" | "endsAt" | "endedAt" | "startedAt" | "minutesStatus" | "transcriptCandidate" | "feishuEvent">,
  now: number,
): FeishuLive | null {
  if (payload.status !== "scheduled" || payload.feishuEvent?.status !== "booked") return null;
  if (payload.endedAt || payload.transcriptCandidate || (payload.minutesStatus ?? "none") !== "none") return "ended";
  if (payload.startedAt) return "live";
  return now >= Date.parse(payload.endsAt) + MISSED_AFTER_MS ? "missed" : "waiting";
}

/** 同上，每 30 秒重算一次：过了预约结束 30 分钟自己变成没开成。 */
export function useFeishuLive(payload: Parameters<typeof feishuLive>[0]): FeishuLive | null {
  return feishuLive(payload, useNow(30_000));
}

/**
 * 这场会在时间线上的哪一段，全站一个颜色（页头时间段、整页、通知栏黑卡的左条）：橙＝即将开、红＝进行中、灰＝已结束。
 * 已结束沿用 `meetingPhase`（后台记了开完、时间已过（hasEnded，含「待确认／待导入记录」）、已开完、已复核）；已取消也归这一段。
 * 没结束的：这一页按过「开始会议」，或者已经到了开始时刻，就是进行中；否则即将开。
 * 在飞书约上的会（`live` 不为空）以飞书会议真的开始为准：到点没开、没开成都还在即将开这一段。
 */
export type MeetingTimeline = "upcoming" | "live" | "ended";

export function meetingTimeline(phase: MeetingPhase, scheduledAt: string, now: number, cancelled = false, live: FeishuLive | null = null): MeetingTimeline {
  if (phase === "ended" || cancelled) return "ended";
  if (phase === "live") return "live";
  return live === null && Date.parse(scheduledAt) <= now ? "live" : "upcoming";
}

/** 即将开的相对时间：今天写「还有 3 小时」「还有 20 分钟」；不是今天写明天、后天、日期（公司时区的日历日）。 */
export function meetingCountdown(scheduledAt: string, now: Date): string {
  const word = meetingDayWord(scheduledAt, now);
  if (word !== "今天") return word;
  const ms = Date.parse(scheduledAt) - now.getTime();
  if (ms < 3_600_000) return `还有 ${Math.max(1, Math.ceil(ms / 60_000))} 分钟`;
  return `还有 ${Math.floor(ms / 3_600_000)} 小时`;
}

const monthDay = (iso: string) => new Date(iso).toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE, month: "numeric", day: "numeric" });

/** 时间段前面那几个字：「还有 3 小时」／「未开始」（到点飞书会议还没开）／「没开成」／「会议中」／「已结束 · 10/8」。 */
export function meetingTimelineLabel(timeline: MeetingTimeline, scheduledAt: string, now: Date, cancelled = false, live: FeishuLive | null = null): string {
  if (live === "missed") return "没开成";
  if (timeline === "upcoming") return Date.parse(scheduledAt) <= now.getTime() ? "未开始" : meetingCountdown(scheduledAt, now);
  if (timeline === "live") return "会议中";
  return `${cancelled ? "已取消" : "已结束"} · ${monthDay(scheduledAt)}`;
}

/** 这一刻（毫秒），每 `every` 毫秒走一次；首帧就是渲染那一刻。 */
export function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}

/** 页头时间段要用的阶段与那几个字；即将开的每 30 秒重算一次，到点自己变成进行中（在飞书约上的会等飞书会议真的开始）。 */
export function useMeetingTimeline({ phase, scheduledAt, cancelled = false, live = null }: { phase: MeetingPhase; scheduledAt: string; cancelled?: boolean; live?: FeishuLive | null }) {
  const now = useNow(30_000);
  const timeline = meetingTimeline(phase, scheduledAt, now, cancelled, live);
  return { timeline, label: meetingTimelineLabel(timeline, scheduledAt, new Date(now), cancelled, live) };
}

/** 开会以来过了几秒。时刻由定时器取，不在渲染里取；没在开会就不跑。 */
function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [startedAt]);
  return startedAt !== undefined && now !== null ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

/**
 * 页头胶囊里标题前面那一段：日子一小段灰字，时段是整排最醒目的字。读屏读「计划时间 今天 14:00 至 15:30」。
 * 给了 `timeline` 时，日子那一段换成这场会的阶段：橙点 + 相对时间（即将开）、红点呼吸 +「会议中」（进行中；走着的用时只在
 * 进度线上那一份）、灰色对勾 +「已结束 · 10/8」（已结束，时段也跟着变灰）。
 */
export function MeetingSlotLabel({ day, slot, timeline, label }: { day: string; slot: MeetingSlot; timeline?: MeetingTimeline; label?: string }) {
  return (
    <span className={s.slot} data-header-lead data-timeline={timeline}>
      <span className={s.sr}>计划时间</span>
      {timeline ? (
        <span className={s.slotState}>
          {timeline === "ended" ? <Check size={13} strokeWidth={2.4} aria-hidden className={s.slotMark} /> : <i className={s.slotDot} aria-hidden />}
          <span className={s.slotWord}>{label}</span>
        </span>
      ) : (
        <span className={s.slotDay}>{day}</span>
      )}
      <span className={s.slotTime}>
        <time>{slot.startsAt}</time>
        <span aria-hidden>–</span>
        <span className={s.sr}>至</span>
        <time>{slot.endsAt}</time>
      </span>
    </span>
  );
}

export function MeetingClock({
  phase,
  startedAt,
  endedAt,
  ending,
  caption = "会议中",
  note = "",
  onStart,
  onEnd,
}: {
  phase: MeetingPhase;
  /** 这一页上按下「开始会议」的时刻（毫秒）。 */
  startedAt?: number;
  /** 后台记下的「开完了」时刻。 */
  endedAt?: string | null;
  /** 「这场会开完了」正在提交。 */
  ending?: boolean;
  /** 会中那颗上的小字：录音中／会议中。 */
  caption?: string;
  /** 计时弹出那一小块里录音出的问题；没有就不出现。 */
  note?: string;
  onStart: () => void;
  onEnd: () => void;
}) {
  const seconds = useElapsed(phase === "live" ? startedAt : undefined);
  const [open, setOpen] = useState(false);
  const time = elapsed(seconds);
  const capsule = useRef<HTMLDivElement>(null);
  const previous = useRef(phase);
  const ended = endedAt ? localClock(endedAt) : "";

  // 按下「开始会议」那颗钮就换成了计时：焦点跟过去落在计时上，不掉到页面最前面去。
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = phase;
    if (from === "idle" && phase === "live" && (document.activeElement === document.body || document.activeElement === null)) {
      capsule.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    }
  }, [phase]);

  // 胶囊这一层三个阶段一直是同一个元素：换阶段时只换里面的东西，浅蓝那一层淡出，不重新长一遍。
  return (
    <div ref={capsule} className={s.capsule} data-phase={phase} data-header-end>
      {phase === "idle" ? (
        <Button className={s.press} key="idle" onPress={onStart}>
          <Radio size={17} strokeWidth={2} aria-hidden />
          <span>开始会议</span>
        </Button>
      ) : phase === "live" ? (
        <Popover isOpen={open} onOpenChange={setOpen}>
          <Button className={s.press} key="live" aria-label={`${caption}，已开 ${time}。展开可结束会议`}>
            <span className={s.dot} aria-hidden />
            <span className={s.readout} aria-hidden>
              <span className={s.caption}>{caption}</span>
              <time className={s.time}>{time}</time>
            </span>
            <ChevronDown size={15} aria-hidden className={s.chevron} />
          </Button>
          <Popover.Content placement="bottom end" className={s.popover}>
            <TianshuPortalTheme>
              <Popover.Dialog className={s.dialog} aria-label="会议进行中">
                <Popover.Heading className={s.heading}>
                  会议进行中 · <time className={s.time}>{time}</time>
                </Popover.Heading>
                {note ? <p className={s.note}>{note}</p> : null}
                <Button
                  size="sm"
                  variant="secondary"
                  className={s.end}
                  isDisabled={ending}
                  onPress={() => {
                    setOpen(false);
                    onEnd();
                  }}
                >
                  结束会议
                </Button>
              </Popover.Dialog>
            </TianshuPortalTheme>
          </Popover.Content>
        </Popover>
      ) : (
        <span className={s.still} key="ended">
          <Check size={16} strokeWidth={2} aria-hidden />
          <span className={s.readout}>
            <span className={s.caption}>已结束</span>
            {ended ? <time className={s.time}>{ended}</time> : null}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * 会议页页头里的那几样，按页头的约定排好：标题前面是计划时段，右边是 `children`（会开完了的「会前预审 ｜ 会议记录」两段切换），
 * 页头右边单独一颗开始会议／计时（`clock` 为空时不放，例如已取消的会）。
 */
export function MeetingHeaderActions({ day, slot, clock, children, timeline, label }: {
  day: string; slot: MeetingSlot; clock?: ReactNode; children?: ReactNode;
  /** 这场会的阶段（见 meetingTimeline）；给了就把日子换成阶段那几个字。 */
  timeline?: MeetingTimeline; label?: string;
}) {
  return (
    <>
      <MeetingSlotLabel day={day} slot={slot} timeline={timeline} label={label} />
      {children}
      {clock}
    </>
  );
}

/**
 * 材料上面那一行灰字。`facts` 会前会中都写（谁主持、几人参会）；`now` 是这一刻的一件事（待预审、待导入会议记录）；
 * `children` 跟在会前会中那一行后面（飞书会议的入口）。
 */
export function MeetingStatus({ phase, facts, now, endedAt, children }: { phase: MeetingPhase; facts: (string | undefined)[]; now?: string; endedAt?: string | null; children?: ReactNode }) {
  if (phase === "ended") {
    const at = endedAt ? localClock(endedAt) : "";
    return (
      <p className={s.status} data-phase="ended">
        {["会议已结束", at && `记于 ${at}`, now].filter(Boolean).join(" · ")}
      </p>
    );
  }
  return (
    <p className={s.status} data-phase={phase}>
      {[...facts, now].filter(Boolean).join(" · ")}
      {children ? <> · {children}</> : null}
    </p>
  );
}

/** 等妙记的预计用时：飞书妙记一般会后 1–3 分钟生成（10/22 实测）。 */
export const MINUTES_EXPECTED_MS = 3 * 60_000;
/** 生成会议卡的预计用时（联调时实测校准；10/21 基线：长会单次调用 17–30 秒）。 */
export const CARD_EXPECTED_MS = 60_000;

const spanWords = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
};

/** 阶段已用时：「42 秒 / 约 1 分钟」；超过预计只写已用时；时钟偏差也不出负数。 */
export function phaseElapsedLabel(since: string, now: number, expectedMs: number): string {
  const spent = Math.max(0, now - Date.parse(since));
  return spent > expectedMs ? spanWords(spent) : `${spanWords(spent)} / 约 ${spanWords(expectedMs)}`;
}

/** 阶段已用时，每秒走一次。 */
export function PhaseTimer({ since, expectedMs }: { since: string; expectedMs: number }) {
  const now = useNow(1000);
  // role="timer"：读屏不每秒播报（外面的 role="status" 只报阶段变化）。
  return <time className={s.phaseTime} role="timer" dateTime={since} suppressHydrationWarning>{phaseElapsedLabel(since, now, expectedMs)}</time>;
}

/** 进行中的阶段：呼吸点 + 短标签 + 已用时（会议记录区也用）。 */
export function PhaseLive({ label, since, expectedMs, className }: { label: string; since: string | null; expectedMs: number; className?: string }) {
  return (
    <span className={[s.phase, className].filter(Boolean).join(" ")} role="status">
      <i className={s.phaseDot} aria-hidden />
      <span>{label}</span>
      {since ? <PhaseTimer since={since} expectedMs={expectedMs} /> : null}
    </span>
  );
}
