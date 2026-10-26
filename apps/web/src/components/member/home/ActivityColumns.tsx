"use client";

/**
 * Mission 详情卡右边的两栏：本周 M/D–M/D / 之后。每栏按日期排，没日期的在后。
 * 已完成的不占栏：两栏下面一行很淡的「已完成 · N」，点开才列出（只有本月完成的，服务端已经筛好）。
 * 卡片只写标题和一行小字：有截止写截止日，本周、之后没截止有开始写「M/D 起」，已完成只写截止日；逾期的日期加粗（不染色）。
 * 「全部」视图下小字前面加它属于哪个 Mission（missionOf），不属于任何 Mission 的写「不属于 Mission」。
 * 进行中的卡右上角写最近一次动静（今天写 HH:MM，更早写 M/D）；停滞的（idleDays）改写「N 天没动」，小点换琥珀色、标题降一档。
 * 没完成的卡右下角一个「完成」，点一下变「确认」，再点才完成（几秒内不点或点别处就退回「完成」）；外部工具提交了验收的，「完成」深一档。
 */
import { useEffect, useRef, useState } from "react";
import type { THomePlanActivity } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { activityTime, shortDate, type Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

type Column = THomePlanActivity["column"];
const COLUMNS: Column[] = ["week", "later"];
/** 点了「完成」之后这么久不点「确认」就退回。 */
const ARM_MS = 4_000;

/** 排序用的日期：「之后」看哪天开始，其余看截止。 */
const sortDate = ({ item, column }: THomePlanActivity) => (column === "later" ? item.startDate ?? item.dueDate : item.dueDate ?? item.startDate);
const byDate = (a: THomePlanActivity, b: THomePlanActivity) => (sortDate(a) ?? "9999").localeCompare(sortDate(b) ?? "9999");

type DoneState = "idle" | "armed" | "busy" | "failed";

/** 「完成 → 确认」：两下才完成。完成后发 member-tasks-changed，首页计划重读，卡片挪进已完成。 */
function DoneButton({ activity }: { activity: THomePlanActivity }) {
  const { item } = activity;
  const [state, setState] = useState<DoneState>("idle");
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (state !== "armed" && state !== "failed") return;
    const timer = window.setTimeout(() => setState("idle"), ARM_MS);
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setState("idle"); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setState("idle"); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [state]);

  const complete = async () => {
    setState("busy");
    try {
      const { data } = await browserApi.POST("/api/me/tasks/{id}/complete", { params: { path: { id: item.id } }, body: { version: item.version } });
      window.dispatchEvent(new Event("member-tasks-changed"));
      // 成功时卡片随重读挪走；没成（多半是刚被改过）就停在「重试」，计划已经换成最新的。
      if (!data) setState("failed");
    } catch {
      setState("failed");
    }
  };

  const label = state === "idle" ? "完成" : state === "failed" ? "重试" : "确认";
  return (
    <button ref={ref} type="button" className={s.done} data-done={state} data-awaiting={item.awaitingAcceptance || undefined} disabled={state === "busy"}
      aria-label={state === "idle" ? `完成「${item.title}」` : `确认完成「${item.title}」`}
      onClick={() => { if (state === "idle") setState("armed"); else if (state !== "busy") void complete(); }}>
      {label}
    </button>
  );
}

function ActivityCard({ activity, mission, today, onNavigate }: { activity: THomePlanActivity; mission: string | null; today: string; onNavigate: Navigate }) {
  const { item, column } = activity;
  const href = `/me/tasks/${encodeURIComponent(item.id)}`;
  const date = item.dueDate ? shortDate(item.dueDate) : column !== "done" && item.startDate ? `${shortDate(item.startDate)} 起` : null;
  const completable = item.status === "not_started" || item.status === "in_progress";
  return (
    <div className={s.activity}>
      <button type="button" className={s.open} data-activity={item.id} data-idle={activity.idleDays ? true : undefined} data-origin={href} onClick={(event) => onNavigate(href, event.currentTarget)}>
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
      {completable ? <DoneButton activity={activity} /> : null}
    </div>
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
  const [doneOpen, setDoneOpen] = useState(false);
  const card = (activity: THomePlanActivity) => <ActivityCard key={activity.item.id} activity={activity} mission={missionOf?.(activity) ?? null} today={today} onNavigate={onNavigate} />;
  const done = activities.filter((activity) => activity.column === "done").sort(byDate);
  return (
    <div className={s.activityBoard}>
      <div className={s.columns}>
        {COLUMNS.map((column) => {
          const cards = activities.filter((activity) => activity.column === column).sort(byDate);
          const title = column === "week" ? `本周 ${shortDate(weekStart)}–${shortDate(weekEnd)}` : "之后";
          return (
            <section key={column} className={s.column} data-column={column} aria-label={title}>
              <h3>{title}</h3>
              {cards.length ? cards.map(card) : <span className={s.empty}>—</span>}
            </section>
          );
        })}
      </div>
      {done.length ? (
        <div className={s.doneArea}>
          <button type="button" className={s.doneToggle} data-done-toggle aria-expanded={doneOpen} onClick={() => setDoneOpen((open) => !open)}>
            已完成 · {done.length}
          </button>
          {doneOpen ? <section className={s.column} data-column="done" aria-label="已完成">{done.map(card)}</section> : null}
        </div>
      ) : null}
    </div>
  );
}
