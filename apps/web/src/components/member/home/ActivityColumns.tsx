"use client";

/**
 * Mission 卡片的三栏：已完成 · N / 本周 M/D–M/D / 之后，右上角是「开启执行事项」。
 * 卡片 = 标题 + 一行小字：本周、之后写「你＋协作人 · 截止日」（没截止写「开始日 起」；有哪个写哪个），已完成只写截止日；逾期的日期标红。
 * 「全部」视图下卡片左边是 Mission 色条（行内 --bar）。每栏按日期排，没日期的在后。
 */
import type { CSSProperties } from "react";
import type { THomePlanActivity } from "@warmap/contracts";
import { StartTaskButton } from "@/components/tours/StartTaskButton";
import { shortDate, type Navigate } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

type Column = THomePlanActivity["column"];
const COLUMNS: Column[] = ["done", "week", "later"];

/** 排序用的日期：「之后」看哪天开始，其余看截止。 */
const sortDate = ({ item, column }: THomePlanActivity) => (column === "later" ? item.startDate ?? item.dueDate : item.dueDate ?? item.startDate);
const byDate = (a: THomePlanActivity, b: THomePlanActivity) => (sortDate(a) ?? "9999").localeCompare(sortDate(b) ?? "9999");

function ActivityCard({ activity, bar, onNavigate }: { activity: THomePlanActivity; bar: string | null; onNavigate: Navigate }) {
  const { item, column } = activity;
  const href = `/me/tasks/${encodeURIComponent(item.id)}`;
  const who = column !== "done" && item.collaborators.length > 0 ? `你＋${item.collaborators.map((person) => person.name).join("、")}` : null;
  // 有截止写截止；本周、之后没截止但有开始，写「M/D 起」。已完成只写截止。
  const date = item.dueDate ? shortDate(item.dueDate) : column !== "done" && item.startDate ? `${shortDate(item.startDate)} 起` : null;
  return (
    <button type="button" className={s.activity} data-activity={item.id} data-origin={href}
      style={bar ? ({ "--bar": bar } as CSSProperties) : undefined} onClick={(event) => onNavigate(href, event.currentTarget)}>
      <span className={s.title}>{item.title}</span>
      {(who || date) && (
        <small>
          {who}
          {who && date ? " · " : null}
          {date && <span data-overdue={activity.overdue || undefined}>{date}</span>}
        </small>
      )}
    </button>
  );
}

export function ActivityColumns({ activities, weekStart, weekEnd, barOf, onNavigate }: {
  activities: THomePlanActivity[];
  weekStart: string;
  weekEnd: string;
  /** 卡片左边色条的颜色；null 不画（聚焦某个 Mission 时、独立事项）。 */
  barOf: (activity: THomePlanActivity) => string | null;
  onNavigate: Navigate;
}) {
  return (
    <div className={s.board}>
      <div className={s.start}><StartTaskButton onNavigate={onNavigate} /></div>
      <div className={s.columns}>
        {COLUMNS.map((column) => {
          const cards = activities.filter((activity) => activity.column === column).sort(byDate);
          const title = column === "done" ? `已完成 · ${cards.length}` : column === "week" ? `本周 ${shortDate(weekStart)}–${shortDate(weekEnd)}` : "之后";
          return (
            <section key={column} className={s.column} data-column={column} aria-label={title}>
              <h3>{title}</h3>
              {cards.length
                ? cards.map((activity) => <ActivityCard key={activity.item.id} activity={activity} bar={barOf(activity)} onNavigate={onNavigate} />)
                : <span className={s.empty}>—</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
