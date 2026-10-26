"use client";

/**
 * Mission 详情卡右边的两栏：本周 M/D–M/D / 之后。每栏按日期排，没日期的在后。
 * 已完成的不占栏：两栏下面一行很淡的「已完成 · N」，点开才列出（只有本月完成的，服务端已经筛好）。
 * 卡片只写标题和一行小字：有截止写截止日，本周、之后没截止有开始写「M/D 起」，已完成只写截止日；逾期的日期加粗（不染色）。
 * 「全部」视图下小字前面加它属于哪个 Mission（missionOf），不属于任何 Mission 的写「不属于 Mission」。
 * 进行中的卡右上角写最近一次动静（今天写 HH:MM，更早写 M/D）；停滞的（idleDays）改写「N 天没动」，小点换琥珀色、标题降一档。
 * 没完成的卡右下角一个「验收」，当场弹出简化的验收弹窗（AcceptDialog quick）：对照完成标准、看一眼交付结果，勾不勾都行，点「验收完成」；
 * 外部工具提交了验收的，「验收」深一档。读不到事项时直接去二级页验收。
 */
import { useState } from "react";
import type { THomePlanActivity, TMaterialView } from "@warmap/contracts";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { AcceptDialog } from "@/components/tasks/AcceptDialog";
import { activityTime, shortDate, type Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

type Column = THomePlanActivity["column"];
type Detail = components["schemas"]["TaskDetailResponse"];
type Accepting = { detail: Detail; materials: TMaterialView[]; origin: Element | null };
const COLUMNS: Column[] = ["week", "later"];

/** 排序用的日期：「之后」看哪天开始，其余看截止。 */
const sortDate = ({ item, column }: THomePlanActivity) => (column === "later" ? item.startDate ?? item.dueDate : item.dueDate ?? item.startDate);
const byDate = (a: THomePlanActivity, b: THomePlanActivity) => (sortDate(a) ?? "9999").localeCompare(sortDate(b) ?? "9999");
const taskHref = (id: string) => `/me/tasks/${encodeURIComponent(id)}`;

/** 验收弹窗要的：事项详情（完成标准、外部工具的提交）和这件事的材料。 */
async function readAcceptance(id: string): Promise<{ detail: Detail; materials: TMaterialView[] } | null> {
  const [{ data }, materials] = await Promise.all([
    browserApi.GET("/api/me/tasks/{id}", { params: { path: { id } } }),
    fetch(`/api/materials/task/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? ((await response.json()) as { materials: TMaterialView[] }).materials : []),
  ]);
  return data ? { detail: data, materials } : null;
}

function ActivityCard({ activity, mission, today, busy, onNavigate, onAccept }: { activity: THomePlanActivity; mission: string | null; today: string;
  busy: boolean; onNavigate: Navigate; onAccept: (origin: Element) => void }) {
  const { item, column } = activity;
  const href = taskHref(item.id);
  const date = item.dueDate ? shortDate(item.dueDate) : column !== "done" && item.startDate ? `${shortDate(item.startDate)} 起` : null;
  const acceptable = item.status === "not_started" || item.status === "in_progress";
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
      {acceptable ? (
        <button type="button" className={s.accept} data-accept={item.id} data-awaiting={item.awaitingAcceptance || undefined} disabled={busy}
          aria-label={`验收「${item.title}」`} onClick={(event) => onAccept(event.currentTarget)}>
          验收
        </button>
      ) : null}
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
  const [accepting, setAccepting] = useState<Accepting | null>(null);
  /** 正在读验收弹窗要的东西的那件事。 */
  const [loading, setLoading] = useState<string | null>(null);

  const accept = async (id: string, origin: Element | null) => {
    setLoading(id);
    try {
      const read = await readAcceptance(id);
      if (read) setAccepting({ ...read, origin });
      else onNavigate(`${taskHref(id)}?accept=1`, origin);
    } catch {
      onNavigate(`${taskHref(id)}?accept=1`, origin);
    } finally {
      setLoading(null);
    }
  };

  const card = (activity: THomePlanActivity) => <ActivityCard key={activity.item.id} activity={activity} mission={missionOf?.(activity) ?? null} today={today}
    busy={loading === activity.item.id} onNavigate={onNavigate} onAccept={(origin) => void accept(activity.item.id, origin)} />;
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
      {accepting ? (
        <AcceptDialog key={accepting.detail.task.id} detail={accepting.detail} materials={accepting.materials}
          onClose={() => setAccepting(null)}
          onDone={async () => setAccepting(null)}
          onStale={() => void accept(accepting.detail.task.id, accepting.origin)}
          quick={{ onFull: () => { const { detail, origin } = accepting; setAccepting(null); onNavigate(`${taskHref(detail.task.id)}?accept=1`, origin); } }} />
      ) : null}
    </div>
  );
}
