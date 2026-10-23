"use client";

/**
 * 成员首页主区（第六版，样稿 home-layout-v9）：顶行三张同高卡「月历 · Mission · 快捷」，下面 Mission 详情卡。
 * - 只展示 plan，取数在 useHomePlan；计划点的加、改名、删在 usePlanMarks（先画上再发请求）。快捷卡（actions）由外面给，plan 还没读到时也先出。
 * - 按 Mission 归组一律看 activity.missionId（任务卡没确认时 item.mission 为空）。
 * - 选中的 Task 默认是：有本周事项的第一个 Task，没有就第一个 Task，没有 Task 就「未归入 Task」；重取后选中的不在了也回到默认。
 * - 同一时间最多一个浮层（ⓘ、加点、改点），开合与 Esc 由 ts-design Popover 管；它对着的 Task、Mission、计划点重取后不在了，浮层就关掉。
 * - 版式按主区宽度（容器查询，见样式）：宽时顶行三张并排；窄一些时快捷变成一排小方块放最上面；再窄就一列。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { THomePlanActivity, THomePlanMark, THomePlanResponse } from "@warmap/contracts";
import { AddMarkPopover, EditMarkPopover, type MarkDraft } from "./MarkPopovers";
import { MissionDetail } from "./MissionDetail";
import { MissionList } from "./MissionList";
import { MonthCalendar } from "./MonthCalendar";
import { LOOSE, TaskList, hasInfo } from "./TaskList";
import { isPending, usePlanMarks } from "./usePlanMarks";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

type Popover = { kind: "info" } | ({ kind: "add" } & MarkDraft) | { kind: "edit"; id: string; label: string };

const NO_MARKS: THomePlanMark[] = [];

export function HomePlan({ plan, actions, onNavigate }: { plan: THomePlanResponse | null; actions: ReactNode; onNavigate: Navigate }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const calendarRef = useRef<HTMLElement | null>(null);
  /** 加点、改点浮层挂在那一天的格子下面。 */
  const dayRef = useRef<Element | null>(null);
  const planMarks = usePlanMarks(plan?.marks ?? NO_MARKS);

  const missions = plan?.missions ?? [];
  // 跨月重取后原来聚焦的 Mission 可能不在了，就回到「全部」。
  const mission = missions.find((item) => item.missionId === picked) ?? null;
  const focus = mission?.missionId ?? null;
  const tasks = mission && plan ? plan.tasks.filter((task) => task.missionId === focus) : [];
  const scope = !plan ? [] : focus ? plan.activities.filter((activity) => activity.missionId === focus) : plan.activities;
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const isLoose = ({ item }: THomePlanActivity) => !item.planTaskId || !taskIds.has(item.planTaskId);
  const loose = scope.filter(isLoose);
  const activitiesOf = (id: string) => (id === LOOSE ? loose : scope.filter((activity) => activity.item.planTaskId === id));
  const fallback = (tasks.find((task) => activitiesOf(task.taskId).some((activity) => activity.column === "week")) ?? tasks[0])?.taskId ?? LOOSE;
  const selected = taskId !== null && (taskIds.has(taskId) || (taskId === LOOSE && loose.length > 0)) ? taskId : fallback;
  const shown = tasks.length ? activitiesOf(selected) : scope;
  const selectedTask = tasks.find((task) => task.taskId === selected) ?? null;

  // 浮层只算真画得出来的；对着的东西不在了，把状态也清掉。
  const infoOpen = popover?.kind === "info" && selectedTask !== null && hasInfo(selectedTask);
  const adding = popover?.kind === "add" && missions.some((item) => item.missionId === popover.missionId) ? popover : null;
  const editing = popover?.kind === "edit" ? planMarks.marks.find((mark) => mark.id === popover.id) ?? null : null;
  const open = infoOpen || adding !== null || editing !== null;
  useEffect(() => {
    if (popover && !open) setPopover(null);
  }, [popover, open]);

  const close = () => setPopover(null);
  const choose = (missionId: string | null) => {
    setPicked(missionId);
    setTaskId(null);
    close();
  };
  /** 开加点、改点的浮层：先找到那一天的格子，上一次没存上的那句错收起来。 */
  const openMark = (next: Exclude<Popover, { kind: "info" }>, date: string) => {
    dayRef.current = calendarRef.current?.querySelector(`[data-day="${date}"]`) ?? calendarRef.current;
    planMarks.clearError();
    setPopover(next);
  };
  const submitAdd = () => {
    const label = adding?.label.trim();
    if (!adding || !label) return;
    close();
    planMarks.add(adding.missionId, adding.date, label);
  };
  const submitEdit = () => {
    const label = popover?.kind === "edit" ? popover.label.trim() : "";
    if (!editing || !label) return;
    close();
    if (label !== editing.label) planMarks.rename(editing.id, label);
  };
  const missionOf = ({ item, missionId }: THomePlanActivity) =>
    missionId === null ? "不属于 Mission" : missions.find((entry) => entry.missionId === missionId)?.title ?? item.mission?.title ?? null;

  return (
    <div className={s.plan}><div className={s.board}>
      <div className={`${s.card} ${s.quick}`}>{actions}</div>
      {plan && <>
        <section ref={calendarRef} className={`${s.card} ${s.calendar}`} aria-label="月历">
          <MonthCalendar
            period={plan.period}
            days={plan.days}
            today={plan.today}
            weekStart={plan.weekStart}
            weekEnd={plan.weekEnd}
            current={!plan.fallbackFrom}
            gates={plan.gates}
            marks={planMarks.marks}
            colorOf={(missionId) => missions.find((item) => item.missionId === missionId)?.color ?? "var(--ink-faint)"}
            focus={focus}
            onAddMark={missions.length ? (date) => openMark({ kind: "add", date, missionId: focus ?? missions[0].missionId, label: "" }, date) : undefined}
            onEditMark={(id) => {
              const mark = planMarks.marks.find((item) => item.id === id);
              if (mark && !isPending(id)) openMark({ kind: "edit", id, label: mark.label }, mark.date);
            }}
          />
          {planMarks.error && <p className={s.markError} role="alert"><CircleAlert size={14} aria-hidden />{planMarks.error}</p>}
          {adding && (
            <AddMarkPopover draft={adding} missions={focus === null ? missions : null} anchor={dayRef}
              onChange={(draft) => setPopover({ ...draft, kind: "add" })} onSubmit={submitAdd} onClose={close} />
          )}
          {editing && popover?.kind === "edit" && (
            <EditMarkPopover mark={editing} label={popover.label} anchor={dayRef} onClose={close}
              onChange={(label) => setPopover({ ...popover, label })} onSubmit={submitEdit}
              onDelete={() => {
                close();
                planMarks.remove(editing.id);
              }} />
          )}
        </section>
        <section className={`${s.card} ${s.missions}`} aria-label="本月 Mission">
          <MissionList plan={plan} focus={focus} onChoose={choose} />
        </section>
        <MissionDetail
          mission={mission}
          taskName={tasks.length ? selectedTask?.name ?? "未归入 Task" : null}
          tasks={tasks.length ? (
            <TaskList tasks={tasks} activitiesOf={activitiesOf} loose={loose.length} selected={selected} infoOpen={infoOpen}
              onPick={(id) => {
                setTaskId(id);
                close();
              }}
              onInfo={(next) => setPopover(next ? { kind: "info" } : null)} />
          ) : null}
          activities={shown}
          today={plan.today}
          weekStart={plan.weekStart}
          weekEnd={plan.weekEnd}
          missionOf={focus === null ? missionOf : undefined}
          onNavigate={onNavigate}
        />
      </>}
    </div></div>
  );
}
