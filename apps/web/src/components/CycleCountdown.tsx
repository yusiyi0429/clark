"use client";

/**
 * 通知栏最上面的一条：本月经营周期的总倒计时（72 小时，从个人复盘开始收集到签发下月全部任务卡）。
 * 全员一样；各阶段不另起计时，走到任务卡讨论也不重置。到期后标红，继续累计超时。
 */
import type { CSSProperties } from "react";
import { Card as HeroCard } from "@heroui/react";
import { ContextMark } from "@/components/ContextMark";
import { cycleClock, cycleStageText, useMonthlyCycle } from "@/lib/monthlyCycle";
import n from "@/styles/notifications.module.css";
import c from "./cycle-countdown.module.css";

export function CycleCountdown() {
  const { cycle, now } = useMonthlyCycle();
  if (!cycle) return null;
  const clock = cycleClock(cycle, now);
  const month = Number(cycle.nextPeriod.slice(5));
  const title = clock.done ? `${month} 月任务卡已签发` : `${month} 月任务卡签发`;
  const tone = clock.overdue && !clock.done ? "overdue" : clock.done ? "done" : "running";
  return <HeroCard<"section"> render={(props) => <section {...props} />} className={n.card} data-notice="cycle" aria-label={`${title}：${clock.text}`}>
    <HeroCard.Header<"header"> render={(props) => <header {...props} />} className={`${n.glassHeader} ${c.header}`}>
      <ContextMark kind="monthly" className={n.glyph} />
      <span className={n.identity}>
        <strong>{title}</strong>
        <small>{clock.done ? "目标 72 小时" : `现在：${cycleStageText(cycle)}`}</small>
      </span>
      <span className={c.figure} data-tone={tone}>{clock.text}</span>
      {!clock.done ? <span className={c.track} aria-hidden><span style={{ "--share": clock.share } as CSSProperties} /></span> : null}
    </HeroCard.Header>
  </HeroCard>;
}
