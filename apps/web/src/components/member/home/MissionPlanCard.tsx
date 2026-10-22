"use client";

/**
 * 成员首页的 Mission 卡片（照样稿 home-layout-v4）：Mission 行、本月时间轴、Task 行、Activity 三栏。
 * - 只展示 plan，取数在 useHomePlan。按 Mission 归组一律看 activity.missionId（任务卡没确认时 item.mission 为空）。
 * - 当前范围（全部或聚焦的 Mission）一个 Task 都没有时不出 Task 行，三栏列这个范围里的所有 Activity（10 月本体里还没有 Task）。
 * - 计划点的加、拖、删在这里发请求：先在本地改好，存好后发 HOME_PLAN_CHANGED 让 useHomePlan 重取；失败退回，时间轴下写一句。
 *   本地改动只盖在发请求时那份 plan.marks 上，重取回来的新 plan 一到就作废。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";
import type { THomePlanActivity, THomePlanMark, THomePlanResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { StartTaskButton } from "@/components/tours/StartTaskButton";
import { DayTimeline } from "./DayTimeline";
import { HOME_PLAN_CHANGED } from "./useHomePlan";
import s from "@/styles/mission-plan-card.module.css";

type Navigate = (href: string, origin?: Element | null) => void;
type Column = THomePlanActivity["column"];
type Popover = { kind: "info" } | { kind: "add"; date: string; missionId: string; label: string } | { kind: "delete"; id: string };
type Saved = { error?: unknown; response: Response };

/** 「其他」胶囊：没挂 Task，或挂的 Task 不在当前范围里。 */
const OTHER = "other";
const COLUMNS: Column[] = ["done", "week", "later"];

const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const tone = (color: string) => ({ "--c": color }) as CSSProperties;
/** 卡片那行小字的日期：「之后」写哪天开始，其余写截止。 */
const dateOf = ({ item, column }: THomePlanActivity) => (column === "later" ? item.startDate ?? item.dueDate : item.dueDate ?? item.startDate);
const byDate = (a: THomePlanActivity, b: THomePlanActivity) => (dateOf(a) ?? "9999").localeCompare(dateOf(b) ?? "9999");

export function MissionPlanCard({ plan, onNavigate }: { plan: THomePlanResponse; onNavigate: Navigate }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [overlay, setOverlay] = useState<{ base: THomePlanMark[]; marks: THomePlanMark[] } | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const open = popover !== null;
  useEffect(() => {
    if (!open) return;
    // 在工作区的 window 监听之前接住 Esc，免得连详情页一起关掉。
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setPopover(null);
    };
    const outside = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) setPopover(null);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  // 跨月重取后原来聚焦的 Mission 可能不在了，就回到「全部」。
  const focused = plan.missions.find((mission) => mission.missionId === picked) ?? null;
  const focus = focused?.missionId ?? null;
  const colorOf = (missionId: string) => plan.missions.find((mission) => mission.missionId === missionId)?.color ?? "#8a93a3";
  const marks = overlay?.base === plan.marks ? overlay.marks : plan.marks;

  const tasks = focus ? plan.tasks.filter((task) => task.missionId === focus) : plan.tasks;
  const scope = focus ? plan.activities.filter((activity) => activity.missionId === focus) : plan.activities;
  const taskIds = new Set(tasks.map((task) => task.taskId));
  // 重取后选中的 Task 不在了（或整个 Task 行没了），就当没选。
  const selected = tasks.length > 0 && (taskId === OTHER || taskIds.has(taskId ?? "")) ? taskId : null;
  const isOther = ({ item }: THomePlanActivity) => !item.planTaskId || !taskIds.has(item.planTaskId);
  const shown = selected === null ? scope : scope.filter((activity) => (selected === OTHER ? isOther(activity) : activity.item.planTaskId === selected));

  const choose = (missionId: string | null) => {
    setPicked(missionId);
    setTaskId(null);
    setPopover(null);
  };
  const pickTask = (id: string) => {
    setTaskId((current) => (current === id ? null : id));
    setPopover(null);
  };

  /** 先在本地改成 next 再发请求：存好通知重取，失败退回。 */
  const save = async (next: THomePlanMark[], send: () => Promise<Saved>) => {
    setOverlay({ base: plan.marks, marks: next });
    setMarkError(null);
    const fail = (message?: string) => {
      setOverlay(null);
      setMarkError(message ?? "没存上，请重试");
    };
    try {
      const { error, response } = await send();
      if (response.ok) window.dispatchEvent(new Event(HOME_PLAN_CHANGED));
      else fail((error as { message?: string } | undefined)?.message);
    } catch {
      fail();
    }
  };
  const addMark = () => {
    if (popover?.kind !== "add") return;
    const { date, missionId } = popover;
    const label = popover.label.trim();
    if (!label) return;
    setPopover(null);
    void save([...marks, { id: `pending-${Date.now()}`, missionId, date, label }],
      () => browserApi.POST("/api/me/plan-marks", { body: { missionId, date, label } }));
  };
  const moveMark = (id: string, date: string) =>
    void save(marks.map((mark) => (mark.id === id ? { ...mark, date } : mark)),
      () => browserApi.PATCH("/api/me/plan-marks/{id}", { params: { path: { id } }, body: { date } }));
  const deleteMark = (id: string) => {
    setPopover(null);
    void save(marks.filter((mark) => mark.id !== id), () => browserApi.DELETE("/api/me/plan-marks/{id}", { params: { path: { id } } }));
  };

  /** 开加点、删点的浮层时，上一次没存上的那句错收起来。 */
  const markPopover = (next: Popover) => {
    setMarkError(null);
    setPopover(next);
  };
  /** 浮层对准那一天的格子。 */
  const anchor = (date: string) => ({ "--x": `${((plan.days.findIndex((day) => day.date === date) + 0.5) / plan.days.length) * 100}%` }) as CSSProperties;
  const deleting = popover?.kind === "delete" ? marks.find((mark) => mark.id === popover.id) : undefined;

  return (
    <section className={s.card} aria-label="本月 Mission" data-focus={focus ?? undefined}>
      <div className={s.missions} role="group" aria-label="Mission">
        <button type="button" className={s.mission} data-mission="all" aria-pressed={focus === null} onClick={() => choose(null)}>
          {plan.fallbackFrom && <span className={s.hint}>{`${Number(plan.fallbackFrom.slice(5, 7))} 月`}</span>}
          <span className={s.name}>全部</span>
        </button>
        {plan.missions.map((mission) => {
          const gate = plan.gates.filter((g) => g.missionId === mission.missionId && g.date >= plan.today).sort((a, b) => a.date.localeCompare(b.date))[0];
          return (
            <button key={mission.missionId} type="button" className={s.mission} data-mission={mission.missionId} aria-pressed={focus === mission.missionId} onClick={() => choose(mission.missionId)}>
              {gate && <span className={s.hint}>{`${shortDate(gate.date)} ${gate.label}`}</span>}
              <span className={s.name}><i className={s.dot} style={tone(mission.color)} aria-hidden />{mission.title}</span>
            </button>
          );
        })}
        {focused?.cardId && (
          <button type="button" className={s.cardLink} data-mission-card onClick={(event) => onNavigate(`/me/mission-cards/${encodeURIComponent(focused.cardId!)}`, event.currentTarget)}>
            Mission 卡 ›
          </button>
        )}
      </div>

      <div className={s.timeline}>
        <DayTimeline
          days={plan.days}
          today={plan.today}
          // 回退显示上个月时，本周不在这个月里：不画本周括线（没有一天落在 "" 到 "" 之间）。
          weekStart={plan.fallbackFrom ? "" : plan.weekStart}
          weekEnd={plan.fallbackFrom ? "" : plan.weekEnd}
          gates={plan.gates}
          marks={marks}
          colorOf={colorOf}
          focus={focus}
          onAddMark={plan.missions.length ? (date) => markPopover({ kind: "add", date, missionId: focus ?? plan.missions[0].missionId, label: "" }) : undefined}
          onMoveMark={moveMark}
          onDeleteMark={(id) => markPopover({ kind: "delete", id })}
        />
        {popover?.kind === "add" && (
          <div ref={popoverRef} className={s.pop} style={anchor(popover.date)} data-mark-pop="add" role="dialog" aria-label={`加计划点 ${shortDate(popover.date)}`}>
            <span className={s.popDate}>{shortDate(popover.date)}</span>
            {focus === null && (
              <div className={s.picks} role="radiogroup" aria-label="Mission">
                {plan.missions.map((mission) => (
                  <button key={mission.missionId} type="button" role="radio" className={s.pick} data-pick={mission.missionId}
                    aria-checked={popover.missionId === mission.missionId} aria-label={mission.title} title={mission.title}
                    style={tone(mission.color)} onClick={() => setPopover({ ...popover, missionId: mission.missionId })} />
                ))}
              </div>
            )}
            <div className={s.nameRow}>
              <input className={s.input} data-mark-name value={popover.label} maxLength={10} placeholder="名字" aria-label="名字" autoFocus
                onChange={(event) => setPopover({ ...popover, label: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  addMark();
                }} />
              <button type="button" className={s.ok} aria-label="加上" disabled={!popover.label.trim()} onClick={addMark}><Check size={14} strokeWidth={2.5} aria-hidden /></button>
            </div>
          </div>
        )}
        {deleting && (
          <div ref={popoverRef} className={s.pop} style={anchor(deleting.date)} data-mark-pop="delete" role="dialog" aria-label={`计划点 ${shortDate(deleting.date)} ${deleting.label}`}>
            <span className={s.popDate}>{`${shortDate(deleting.date)} ${deleting.label}`}</span>
            <button type="button" className={s.delete} data-delete onClick={() => deleteMark(deleting.id)}>删除</button>
          </div>
        )}
        {markError && <p className={s.error} role="alert">{markError}</p>}
      </div>

      {tasks.length > 0 && (
        <div className={s.tasks} data-task-row role="group" aria-label="Task">
          {tasks.map((task) => {
            const chosen = selected === task.taskId;
            const info = chosen && (task.doneDefinition !== null || task.criteria.length > 0);
            const infoOpen = info && popover?.kind === "info";
            return (
              <div key={task.taskId} ref={infoOpen ? popoverRef : undefined} className={s.task} data-selected={chosen || undefined}>
                <button type="button" className={s.taskName} data-task={task.taskId} aria-pressed={chosen} onClick={() => pickTask(task.taskId)}>
                  {focus === null && <i className={s.dot} style={tone(colorOf(task.missionId))} aria-hidden />}
                  {task.name}
                </button>
                {info && (
                  <button type="button" className={s.info} data-info aria-label="做到什么算完" aria-expanded={infoOpen}
                    onClick={() => setPopover((current) => (current?.kind === "info" ? null : { kind: "info" }))}>i</button>
                )}
                {infoOpen && (
                  <div className={`${s.pop} ${s.infoPop}`} role="dialog" aria-label={task.name}>
                    {task.doneDefinition && <><b>做到什么算完</b><p>{task.doneDefinition}</p></>}
                    {task.criteria.length > 0 && <><b>验收标准</b><ol>{task.criteria.map((line, index) => <li key={index}>{line}</li>)}</ol></>}
                  </div>
                )}
              </div>
            );
          })}
          <div className={s.task} data-selected={selected === OTHER || undefined}>
            <button type="button" className={s.taskName} data-task={OTHER} aria-pressed={selected === OTHER} onClick={() => pickTask(OTHER)}>
              其他<span className={s.count}>{scope.filter(isOther).length}</span>
            </button>
          </div>
        </div>
      )}

      <div className={s.board}>
        <div className={s.start}><StartTaskButton onNavigate={onNavigate} /></div>
        <div className={s.columns}>
          {COLUMNS.map((column) => {
            const cards = shown.filter((activity) => activity.column === column).sort(byDate);
            const title = column === "done" ? `已完成 · ${cards.length}` : column === "week" ? `本周 ${shortDate(plan.weekStart)}–${shortDate(plan.weekEnd)}` : "之后";
            return (
              <section key={column} className={s.column} data-column={column} aria-label={title}>
                <h3>{title}</h3>
                {cards.length ? cards.map((activity) => {
                  const { item } = activity;
                  const href = `/me/tasks/${encodeURIComponent(item.id)}`;
                  const date = dateOf(activity);
                  return (
                    <button key={item.id} type="button" className={s.activity} data-activity={item.id} data-origin={href}
                      style={focus === null && activity.missionId ? ({ "--bar": colorOf(activity.missionId) } as CSSProperties) : undefined}
                      onClick={(event) => onNavigate(href, event.currentTarget)}>
                      <span className={s.title}>{item.title}</span>
                      {date ? <small data-overdue={activity.overdue || undefined}>{shortDate(date)}</small>
                        : item.collaborators.length > 0 && <small>{`你＋${item.collaborators.map((person) => person.name).join("、")}`}</small>}
                    </button>
                  );
                }) : <span className={s.empty}>—</span>}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
