"use client";
import type { CSSProperties } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { cycleClock, useMonthlyCycle } from "@/lib/monthlyCycle";
import s from "./round-clock.module.css";

/** clark countdown.tsx；截止仍以服务端为准，数字不出现负数。属于当前月度周期的轮次改显示周期总倒计时（超时标红）。 */
export function roundClockText(round: Pick<TMissionRoundSummary, "phase" | "closesAt">, now: number): string {
  if (round.phase === "drafting") return "Co-Agent 正在起草";
  if (round.phase === "draft") return "待下发审核";
  if (round.phase === "confirmed") return "已确定";
  // 讨论不再自动截止（CEO 手动结束）：开放中没有截止时间就是「审核中」，倒计时看月度周期的总倒计时。
  if (round.phase === "open" && !round.closesAt) return "审核中";
  const left = round.closesAt ? Date.parse(round.closesAt) - now : 0;
  if (round.phase !== "open" || left <= 0) return "审核已结束";
  const minutes = Math.floor(left / 60_000);
  if (minutes === 0) return "不到 1 分";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分` : `${minutes} 分`;
}
export function RoundClock({ round, now, tone = "paper" }: { round: TMissionRoundSummary; now: number; tone?: "paper" | "glass" }) {
  const { cycle, now: cycleNow } = useMonthlyCycle();
  // 这一轮属于正在进行的月度周期：只显示那一个总倒计时，不另起讨论窗口的计时（开放讨论也不重置）。
  if (cycle && cycle.nextPeriod === round.period && round.phase !== "drafting" && round.phase !== "draft") {
    const clock = cycleClock(cycle, cycleNow);
    const phase = round.phase === "open" ? (round.approver ? "审核中 · 全员完成后自动汇总" : "审核中") : round.phase === "closed" ? "汇总中" : round.phase === "reviewing" ? `等${round.approver ? "你" : round.deciderName}拍板` : "已确定";
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
  return <time className={s.clock} data-tone={tone} data-closed={!opened || undefined} dateTime={round.closesAt ?? undefined} aria-label={`${text}${opened ? `，截止于 ${at}` : ""}`} title={at ? `截止于 ${at}` : "审核尚未下发"}>
    {opened ? <span className={s.track} style={{ "--share": Math.max(0, Math.min(1, left / 172_800_000)) } as CSSProperties} aria-hidden /> : null}
    <span className={s.figure}>{text}</span>
    {tone === "glass" ? <span className={s.note}>{opened ? `${left < 21_600_000 ? "最后 6 小时 · " : ""}${at} 截止` : round.phase === "closed" ? "汇总中" : round.phase === "reviewing" ? `等${round.approver ? "你" : round.deciderName}拍板` : ""}</span> : null}
  </time>;
}
