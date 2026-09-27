"use client";
import type { CSSProperties } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import s from "./round-clock.module.css";

/** clark countdown.tsx；截止仍以服务端为准，数字不出现负数，不以颜色表达紧迫。 */
export function roundClockText(round: Pick<TMissionRoundSummary, "phase" | "closesAt">, now: number): string {
  if (round.phase === "draft") return "本轮未开放";
  if (round.phase === "confirmed") return "已确定";
  const left = round.closesAt ? Date.parse(round.closesAt) - now : 0;
  if (round.phase !== "open" || left <= 0) return "已截止";
  const minutes = Math.floor(left / 60_000);
  if (minutes === 0) return "不到 1 分";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分` : `${minutes} 分`;
}
export function RoundClock({ round, now, tone = "paper" }: { round: TMissionRoundSummary; now: number; tone?: "paper" | "glass" }) {
  const text = roundClockText(round, now);
  const left = round.closesAt ? Date.parse(round.closesAt) - now : 0;
  const opened = round.phase === "open" && left > 0;
  const at = monthDayTime(round.closesAt);
  return <time className={s.clock} data-tone={tone} data-closed={!opened || undefined} dateTime={round.closesAt ?? undefined} aria-label={`${text}${opened ? `，截止于 ${at}` : ""}`} title={at ? `截止于 ${at}` : "本轮还未开放讨论"}>
    {opened ? <span className={s.track} style={{ "--share": Math.max(0, Math.min(1, left / 172_800_000)) } as CSSProperties} aria-hidden /> : null}
    <span className={s.figure}>{text}</span>
    {opened && round.round > 1 ? <span className={s.note}>第 {round.round} 轮</span> : null}
    {tone === "glass" ? <span className={s.note}>{opened ? `${left < 21_600_000 ? "最后 6 小时 · " : ""}${at} 截止` : round.phase === "closed" ? "汇总中" : round.phase === "reviewing" ? `等${round.approver ? "你" : round.deciderName}拍板` : ""}</span> : null}
  </time>;
}
