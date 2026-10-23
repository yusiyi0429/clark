"use client";

/**
 * Mission 详情卡右边的三栏：已完成 · N / 本周 M/D–M/D / 之后。每栏按日期排，没日期的在后。
 * 卡片只写标题和一行小字：有截止写截止日，本周、之后没截止有开始写「M/D 起」，已完成只写截止日；逾期的日期加粗（不染色）。
 * 「全部」视图下小字前面加它属于哪个 Mission（missionOf），不属于任何 Mission 的写「不属于 Mission」。
 * 进行中的卡右上角写最近一次动静（今天写 HH:MM，更早写 M/D）；停滞的（idleDays）改写「N 天没动」，小点换琥珀色、标题降一档。
 */
import type { THomePlanActivity } from "@warmap/contracts";
import { activityTime, shortDate, type Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

type Column = THomePlanActivity["column"];
const COLUMNS: Column[] = ["done", "week", "later"];

/** 排序用的日期：「之后」看哪天开始，其余看截止。 */
const sortDate = ({ item, column }: THomePlanActivity) => (column === "later" ? item.startDate ?? item.dueDate : item.dueDate ?? item.startDate);
const byDate = (a: THomePlanActivity, b: THomePlanActivity) => (sortDate(a) ?? "9999").localeCompare(sortDate(b) ?? "9999");

function ActivityCard({ activity, mission, today, onNavigate }: { activity: THomePlanActivity; mission: string | null; today: string; onNavigate: Navigate }) {
  const { item, column } = activity;
  const href = `/me/tasks/${encodeURIComponent(item.id)}`;
  const date = item.dueDate ? shortDate(item.dueDate) : column !== "done" && item.startDate ? `${shortDate(item.startDate)} 起` : null;
  return (
    <button type="button" className={s.activity} data-activity={item.id} data-idle={activity.idleDays ? true : undefined} data-origin={href} onClick={(event) => onNavigate(href, event.currentTarget)}>
      <span className={s.cardTop}>
        <span className={s.title}>{item.title}</span>
        {item.status === "in_progress" && (
          <span className={s.signal} data-signal>{activity.idleDays ? `${activity.idleDays} 天没动` : activityTime(activity.lastActivityAt, today)}</span>
        )}
      </span>
      {(mission || date) && (
        <small>
          {mission}
          {mission && date ? " · " : null}
          {date && <span data-overdue={activity.overdue || undefined}>{date}</span>}
        </small>
      )}
    </button>
  );
}

export function ActivityColumns({ activities, today, weekStart, weekEnd, missionOf, onNavigate }: {
  activities: THomePlanActivity[];
  today: string;
  weekStart: string;
  weekEnd: string;
  /** 「全部」视图下卡片小字前面写的 Mission；聚焦某个 Mission 时不传。 */
  missionOf?: (activity: THomePlanActivity) => string | null;
  onNavigate: Navigate;
}) {
  return (
    <div className={s.columns}>
      {COLUMNS.map((column) => {
        const cards = activities.filter((activity) => activity.column === column).sort(byDate);
        const title = column === "done" ? `已完成 · ${cards.length}` : column === "week" ? `本周 ${shortDate(weekStart)}–${shortDate(weekEnd)}` : "之后";
        return (
          <section key={column} className={s.column} data-column={column} aria-label={title}>
            <h3>{title}</h3>
            {cards.length
              ? cards.map((activity) => <ActivityCard key={activity.item.id} activity={activity} mission={missionOf?.(activity) ?? null} today={today} onNavigate={onNavigate} />)
              : <span className={s.empty}>—</span>}
          </section>
        );
      })}
    </div>
  );
}
