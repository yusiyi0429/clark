"use client";

/**
 * 成员首页的 Mission 卡片（照样稿 home-layout-v4，外观跟首页其他卡片一致）：Mission 行、本月时间轴、Task 行、Activity 三栏。
 * - 只展示 plan，取数在 useHomePlan；计划点的加、拖、删在 usePlanMarks（先画上再发请求）。
 * - 按 Mission 归组一律看 activity.missionId（任务卡没确认时 item.mission 为空）。
 * - 当前范围（全部或聚焦的 Mission）一个 Task 都没有时不出 Task 行，三栏列这个范围里的所有 Activity（10 月本体里还没有 Task）。
 * - 同一时间最多一个浮层（ⓘ、加点、删点），开合与 Esc 由 ts-design Popover 管；它对着的 Task、Mission、计划点重取后不在了，浮层就关掉。
 */
import { useEffect, useRef, useState } from "react";
import type { THomePlanActivity, THomePlanResponse } from "@warmap/contracts";
import { ActivityColumns } from "./ActivityColumns";
import { DayTimeline } from "./DayTimeline";
import { AddMarkPopover, DeleteMarkPopover, type MarkDraft } from "./MarkPopovers";
import { MissionRow } from "./MissionRow";
import { OTHER, TaskRow, hasInfo } from "./TaskRow";
import { isPending, usePlanMarks } from "./usePlanMarks";
import type { Navigate } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

type Popover = { kind: "info" } | ({ kind: "add" } & MarkDraft) | { kind: "delete"; id: string };

export function MissionPlanCard({ plan, onNavigate }: { plan: THomePlanResponse; onNavigate: Navigate }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [popover, setPopover] = useState<Popover | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  /** 加点、删点浮层挂在那一天的格子下面。 */
  const dayRef = useRef<Element | null>(null);
  const planMarks = usePlanMarks(plan.marks);

  // 跨月重取后原来聚焦的 Mission 可能不在了，就回到「全部」。
  const focus = plan.missions.some((mission) => mission.missionId === picked) ? picked : null;
  const colorOf = (missionId: string) => plan.missions.find((mission) => mission.missionId === missionId)?.color ?? "var(--ink-faint)";

  const tasks = focus ? plan.tasks.filter((task) => task.missionId === focus) : plan.tasks;
  const scope = focus ? plan.activities.filter((activity) => activity.missionId === focus) : plan.activities;
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const isOther = ({ item }: THomePlanActivity) => !item.planTaskId || !taskIds.has(item.planTaskId);
  const others = scope.filter(isOther).length;
  // 重取后选中的 Task 不在了，或「其他」变成 0（胶囊没了），就当没选。
  const selected = taskId === OTHER ? (tasks.length > 0 && others > 0 ? OTHER : null) : taskId !== null && taskIds.has(taskId) ? taskId : null;
  const shown = selected === null ? scope : scope.filter((activity) => (selected === OTHER ? isOther(activity) : activity.item.planTaskId === selected));

  // 浮层只算真画得出来的；对着的东西不在了，把状态也清掉。
  const infoOpen = popover?.kind === "info" && tasks.some((task) => task.taskId === selected && hasInfo(task));
  const adding = popover?.kind === "add" && plan.missions.some((mission) => mission.missionId === popover.missionId) ? popover : null;
  const deleting = popover?.kind === "delete" ? planMarks.marks.find((mark) => mark.id === popover.id) ?? null : null;
  const open = infoOpen || adding !== null || deleting !== null;
  useEffect(() => {
    if (popover && !open) setPopover(null);
  }, [popover, open]);

  const close = () => setPopover(null);
  const choose = (missionId: string | null) => {
    setPicked(missionId);
    setTaskId(null);
    close();
  };
  /** 开加点、删点的浮层：先找到那一天的格子，上一次没存上的那句错收起来。 */
  const openMark = (next: Exclude<Popover, { kind: "info" }>, date: string) => {
    dayRef.current = cardRef.current?.querySelector(`[data-view="days"] [data-day="${date}"]`) ?? cardRef.current;
    planMarks.clearError();
    setPopover(next);
  };
  const submitMark = () => {
    const label = adding?.label.trim();
    if (!adding || !label) return;
    close();
    planMarks.add(adding.missionId, adding.date, label);
  };

  return (
    <section ref={cardRef} className={s.card} aria-label="本月 Mission" data-focus={focus ?? undefined}>
      <MissionRow plan={plan} focus={focus} onChoose={choose} onNavigate={onNavigate} />

      <div className={s.timeline}>
        <DayTimeline
          days={plan.days}
          today={plan.today}
          weekStart={plan.weekStart}
          weekEnd={plan.weekEnd}
          // 回退显示上个月时，本周不在这个月里。
          showWeek={!plan.fallbackFrom}
          gates={plan.gates}
          marks={planMarks.marks}
          colorOf={colorOf}
          focus={focus}
          onAddMark={plan.missions.length ? (date) => openMark({ kind: "add", date, missionId: focus ?? plan.missions[0].missionId, label: "" }, date) : undefined}
          onMoveMark={planMarks.move}
          onDeleteMark={(id) => {
            const mark = planMarks.marks.find((item) => item.id === id);
            if (mark && !isPending(id)) openMark({ kind: "delete", id }, mark.date);
          }}
        />
        {adding && (
          <AddMarkPopover draft={adding} missions={focus === null ? plan.missions : null} anchor={dayRef}
            onChange={(draft) => setPopover({ ...draft, kind: "add" })} onSubmit={submitMark} onClose={close} />
        )}
        {deleting && (
          <DeleteMarkPopover mark={deleting} anchor={dayRef} onClose={close}
            onDelete={() => {
              close();
              planMarks.remove(deleting.id);
            }} />
        )}
        {planMarks.error && <p className={s.error} role="alert">{planMarks.error}</p>}
      </div>

      {tasks.length > 0 && (
        <TaskRow tasks={tasks} selected={selected} others={others} dots={focus === null} colorOf={colorOf} infoOpen={infoOpen}
          onPick={(id) => {
            setTaskId(selected === id ? null : id);
            close();
          }}
          onInfo={(next) => setPopover(next ? { kind: "info" } : null)} />
      )}

      <ActivityColumns activities={shown} weekStart={plan.weekStart} weekEnd={plan.weekEnd}
        barOf={(activity) => (focus === null && activity.missionId ? colorOf(activity.missionId) : null)} onNavigate={onNavigate} />
    </section>
  );
}
