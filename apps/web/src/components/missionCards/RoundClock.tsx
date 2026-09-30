"use client";
import type { CSSProperties } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { cycleClock, useMonthlyCycle } from "@/lib/monthlyCycle";
import s from "./round-clock.module.css";

/** clark countdown.tsx；截止仍以服务端为准，数字不出现负数。属于当前月度周期的轮次改显示周期总倒计时（超时标红）。 */
export function roundClockText(round: Pick<TMissionRoundSummary, "phase" | "closesAt">, now: number): string {
  if (round.phase === "drafting") return "Co-Agent 正在起草";
  if (round.phase === "draft") return "待下发本人确认";
  if (round.phase === "confirmed") return "已确定";
  if (round.phase === "reviewing") return "任务组合核对";
  // 本人准备未设独立截止时，沿用月度周期计时。
  if (round.phase === "open" && !round.closesAt) return "待本人确认";
  const left = round.closesAt ? Date.parse(round.closesAt) - now : 0;
  if (round.phase !== "open" || left <= 0) return "本人确认时间已到";
  const minutes = Math.floor(left / 60_000);
  if (minutes === 0) return "不到 1 分";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分` : `${minutes} 分`;
}
export function RoundClock({ round, now, tone = "paper" }: { round: TMissionRoundSummary; now: number; tone?: "paper" | "glass" }) {
  const { cycle, now: cycleNow } = useMonthlyCycle();
  // 当前任务属于月度周期时，显示周期的统一截止。
  if (cycle && cycle.nextPeriod === round.period && round.phase !== "drafting" && round.phase !== "draft") {
    const clock = cycleClock(cycle, cycleNow);
    const phase = round.phase === "open" ? "本人确认准备中" : round.phase === "closed" ? "仍有本人未确认" : round.phase === "reviewing" ? "Co-Agent 核对与 DRI 确认组合" : "已确定";
    return <time className={s.clock} data-tone={tone} data-overdue={clock.overdue && !clock.done || undefined} dateTime={cycle.deadlineAt} aria-label={`${Number(cycle.nextPeriod.slice(5))} 月任务卡签发 ${clock.text}，${phase}`} title={`72 小时目标：${monthDayTime(cycle.deadlineAt)}`}>
      <span className={s.figure}>{clock.text}</span>
      <span className={s.note}>{phase}</span>
    </time>;
  }
  if (tone === "paper" && !round.closesAt) return null;
  const text = roundClockText(round, now);
  const left = round.closesAt ? Date.parse(round.closesAt) - now : 0;
  const opened = round.phase === "open" && left > 0;
  const at = monthDayTime(round.closesAt);
  return <time className={s.clock} data-tone={tone} data-closed={!opened || undefined} dateTime={round.closesAt ?? undefined} aria-label={`${text}${opened ? `，截止于 ${at}` : ""}`} title={at ? `截止于 ${at}` : "本人确认尚未下发"}>
    {opened ? <span className={s.track} style={{ "--share": Math.max(0, Math.min(1, left / 172_800_000)) } as CSSProperties} aria-hidden /> : null}
    <span className={s.figure}>{text}</span>
    {tone === "glass" ? <span className={s.note}>{opened ? `${left < 21_600_000 ? "最后 6 小时 · " : ""}${at} 截止` : round.phase === "closed" ? "待本人继续确认" : round.phase === "reviewing" ? "待战场 DRI 确认组合" : ""}</span> : null}
  </time>;
}
