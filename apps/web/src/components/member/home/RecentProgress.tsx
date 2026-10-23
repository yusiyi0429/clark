"use client";

/**
 * 首页最下面的「最近进展」：全部执行事项里各自最新的一条进展，最新在前，最多 5 行。
 * 每行：等宽时间（今天 HH:MM / M/D HH:MM，公司时区）+ 粗体事项名 · 进展的第一行；点一行进那个事项。没有任何进展时不出这张卡。
 */
import type { THomePlanActivity } from "@warmap/contracts";
import { calendarDate, monthDayTime } from "@/lib/companyTime";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

const LIMIT = 5;

/** 有进展的事项按最新进展的时间倒序，取前 5 个。 */
function recentProgress(activities: THomePlanActivity[]) {
  return activities.flatMap(({ item }) => (item.latestProgress ? [{ item, progress: item.latestProgress }] : []))
    .sort((a, b) => Date.parse(b.progress.createdAt) - Date.parse(a.progress.createdAt))
    .slice(0, LIMIT);
}

/** 「今天 13:08」或「10/22 20:26」。 */
const progressTime = (iso: string, today: string) => {
  const time = monthDayTime(iso);
  return calendarDate(iso) === today ? time.replace(/^\S+/, "今天") : time;
};

export function RecentProgress({ activities, today, onNavigate }: { activities: THomePlanActivity[]; today: string; onNavigate: Navigate }) {
  const rows = recentProgress(activities);
  if (!rows.length) return null;
  return (
    <section className={`${s.card} ${s.progress}`} aria-label="最近进展">
      <header className={s.head}><h2>最近进展</h2><small>全部执行事项</small></header>
      <ol className={s.log}>
        {rows.map(({ item, progress }) => {
          const href = `/me/tasks/${encodeURIComponent(item.id)}`;
          return (
            <li key={item.id}>
              <button type="button" data-progress={item.id} data-origin={href} onClick={(event) => onNavigate(href, event.currentTarget)}>
                <time dateTime={progress.createdAt}>{progressTime(progress.createdAt, today)}</time>
                <span className={s.logText}><b>{item.title}</b> · {progress.body.split("\n").find((line) => line.trim())?.trim() ?? progress.body}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
