"use client";

/**
 * 本月页（/me/month，原型 v8.4 topbar + monthSec + 胶囊）：月份翻页、今日日程条，下面一张「本月」卡放 Mission → Task 泳道，底部伙伴胶囊。
 * 959 及以下换成手机的样子：Mission 一张卡、Task 一行。
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import { useBuddy } from "@/components/buddy/useBuddy";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { DayStrip, useDayEvents } from "./DayStrip";
import { MonthLanes, PhoneMonth } from "./MonthLanes";
import { MonthCapsule } from "./MonthCapsule";
import type { CardItem } from "@/lib/board/cards";
import s from "@/styles/v2-month.module.css";

const shift = (period: string, step: number) => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + step, 1)).toISOString().slice(0, 7);
const monthLabel = (period: string) => `${Number(period.slice(5, 7))} 月`;

export function MonthPage() {
  const { plan, error, refresh } = useHomePlan();
  const { buddy } = useBuddy();
  const local = useLocalRunner();
  const events = useDayEvents();
  const handheld = useHandheld();
  const [offset, setOffset] = useState(0);
  const period = plan ? shift(plan.period, offset) : null;
  const shown = plan && offset === 0 ? plan : null;
  const running = shown ? shown.activities.filter(({ item }) => (item as CardItem).card?.stage === "doing" || local.sessions.some((session) => session.subject.cardId === item.id && (session.status === "running" || session.status === "starting"))).length : 0;
  const taskCount = shown?.tasks.length ?? 0;
  const missionCount = shown ? new Set(shown.tasks.map((task) => task.missionId)).size : 0;

  return (
    <div className={s.page} data-testid="month-page">
      <div className={s.topbar}>
        <div className={s.monthNav}>
          <button type="button" className={s.navButton} aria-label="上个月" onClick={() => setOffset((value) => value - 1)} disabled={!plan}><ChevronLeft size={14} aria-hidden /></button>
          <b className={s.monthName}>{period ? monthLabel(period) : "本月"}</b>
          <button type="button" className={s.navButton} aria-label="下个月" onClick={() => setOffset((value) => value + 1)} disabled={!plan}><ChevronRight size={14} aria-hidden /></button>
        </div>
        <DayStrip events={events} compact={handheld} />
      </div>
      {error ? <div className={s.error} role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>重试</button></div> : null}
      {handheld ? (
        shown ? <PhoneMonth plan={shown} sessions={local.sessions} /> : plan ? <p className={s.emptyMonth}>{period ? monthLabel(period) : ""}没有 Task</p> : null
      ) : (
        <section className={s.month} aria-label="本月">
          <div className={s.secHead}>
            <b>{offset === 0 ? "本月" : period ? monthLabel(period) : ""}</b>
            {shown ? <span className={s.sub}>{missionCount} 个 Mission · {taskCount} 个 Task</span> : null}
            <span className={s.grow} />
            {running ? <span className={s.live}><span className={s.pulse} aria-hidden />{running} 件进行中</span> : null}
          </div>
          <div className={s.scroll}>
            {shown ? (taskCount ? <MonthLanes plan={shown} sessions={local.sessions} /> : <p className={s.emptyMonth}>这个月还没有 Task</p>)
              : plan ? <p className={s.emptyMonth}>{period ? monthLabel(period) : ""}没有 Task</p> : <div className={s.loading} aria-busy />}
          </div>
        </section>
      )}
      <MonthCapsule buddy={buddy} />
    </div>
  );
}
