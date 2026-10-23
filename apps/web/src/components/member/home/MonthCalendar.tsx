"use client";

/**
 * 成员首页的月历卡：只管画和把点击交出去，不取数。
 *
 * - 标题「M 月」，右边小字「还剩 N 个工作日」（本月从今天数到月末）；current=false（回退显示上个月）时不写，也不画本周。
 * - 7 列，周一起；工作日按 days 上的节假日日历（调休上班日照常），休息日字更浅；过去的日子淡灰；今天一圈细框；本周那一行垫浅底。
 * - 日期下面：签定关口是小菱形，计划点是小空心圆，颜色是所属 Mission 的颜色；聚焦某个 Mission 时其他 Mission 的淡掉。
 * - 点日期加计划点；点计划点改名或删；签定关口只读、不接点击。哪个回调没传，对应的操作就关掉。
 */
import type { CSSProperties } from "react";
import type { THomePlanDay, THomePlanGate, THomePlanMark } from "@warmap/contracts";
import { shortDate, tone } from "./planFormat";
import c from "@/styles/month-calendar.module.css";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

type MonthCalendarProps = {
  period: string;
  days: THomePlanDay[];
  today: string;
  weekStart: string;
  weekEnd: string;
  /** 显示的是本月；false（回退显示上个月）时不画本周、不写「还剩 N 个工作日」。默认 true。 */
  current?: boolean;
  gates: THomePlanGate[];
  marks: THomePlanMark[];
  colorOf: (missionId: string) => string;
  /** 聚焦的 Mission；null 是「全部」。 */
  focus: string | null;
  onAddMark?: (date: string) => void;
  onEditMark?: (id: string) => void;
};

/**
 * 本月还剩几个工作日：从今天（今天是工作日就算上）数到月末。
 * 工作日直接用 days 上按中国工作日历算好的标记（休息日、调休上班日），前端不另存假期表。
 */
export function workdaysLeftThisMonth(days: THomePlanDay[], today: string): number {
  return days.filter((day) => day.workday && day.date >= today).length;
}

/** 周一 = 0 … 周日 = 6。 */
const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function MonthCalendar({ period, days, today, weekStart, weekEnd, current = true, gates, marks, colorOf, focus, onAddMark, onEditMark }: MonthCalendarProps) {
  const dimmed = (missionId: string) => (focus !== null && missionId !== focus) || undefined;
  const week = current ? days.filter((day) => day.date >= weekStart && day.date <= weekEnd).map((day) => day.date) : [];
  return (
    <>
      <header className={c.head}>
        <h2>{Number(period.slice(5, 7))} 月</h2>
        {current && <small>还剩 {workdaysLeftThisMonth(days, today)} 个工作日</small>}
      </header>
      <div className={c.weekdays} aria-hidden="true">{WEEKDAYS.map((name) => <span key={name}>{name}</span>)}</div>
      <ol className={c.days} aria-label="本月">
        {days.map((day, index) => {
          const number = Number(day.date.slice(8, 10));
          const name = `${Number(day.date.slice(5, 7))}月${number}日`;
          const state = day.date === today ? "today" : day.date < today ? "past" : "future";
          const inWeek = week.includes(day.date);
          const onDayGates = gates.filter((gate) => gate.date === day.date);
          const onDayMarks = marks.filter((mark) => mark.date === day.date);
          return (
            <li key={day.date} className={c.day} data-day={day.date} data-state={state} data-workday={day.workday}
              data-week={inWeek ? (day.date === week[0] ? "first" : day.date === week.at(-1) ? "last" : "mid") : undefined}
              data-week-only={inWeek && week.length === 1 ? true : undefined}
              style={index === 0 ? ({ gridColumnStart: weekdayOf(day.date) + 1 } as CSSProperties) : undefined}
              aria-label={`${name}${state === "today" ? " 今天" : ""} ${day.workday ? "工作日" : "休息日"}`}>
              {onAddMark && <button type="button" className={c.hit} aria-label={`加计划点 ${name}`} onClick={() => onAddMark(day.date)} />}
              <span className={c.num} aria-hidden="true">{number}</span>
              {onDayGates.length + onDayMarks.length > 0 && (
                <span className={c.marks}>
                  {onDayGates.map((gate, at) => (
                    <span key={`gate-${at}`} className={c.gate} data-kind="gate" data-dim={dimmed(gate.missionId)} role="img"
                      aria-label={`签定关口 ${shortDate(gate.date)} ${gate.label}`} title={`${shortDate(gate.date)} ${gate.label}`} style={tone(colorOf(gate.missionId))} />
                  ))}
                  {onDayMarks.map((mark) => (
                    <button key={mark.id} type="button" className={c.mark} data-kind="mark" data-mark={mark.id} data-dim={dimmed(mark.missionId)}
                      aria-label={`计划点 ${shortDate(mark.date)} ${mark.label}`} title={`${shortDate(mark.date)} ${mark.label}`} style={tone(colorOf(mark.missionId))}
                      disabled={!onEditMark} onClick={() => onEditMark?.(mark.id)} />
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
