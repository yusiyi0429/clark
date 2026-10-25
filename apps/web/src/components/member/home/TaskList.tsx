"use client";

/**
 * Mission 详情卡左边的 Task 列：每个 Task 一张小卡——名字、「已完成 a / b」、最近的未完成截止日、一条细进度线。
 * 选中的卡浮起来；它有完成定义或验收标准时右上角一个 ⓘ，点开小浮层（ts-design Popover，和会议页的编辑浮层同一个样子）。
 * 最后一项「未归入 Task」（N 为 0 不出）：这个 Mission 下没挂 Task、或挂的 Task 不在这个 Mission 里的执行事项。
 * 卡片窄时（见样式）整列变成详情卡顶上一排可横滑的小卡。
 */
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { THomePlanActivity, THomePlanTask } from "@warmap/contracts";
import { shortDate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

/** 「未归入 Task」那一项。 */
export const LOOSE = "loose";

export const hasInfo = (task: THomePlanTask) => task.doneDefinition !== null || task.criteria.length > 0;

/** 一个 Task 下的进度：已完成几件、一共几件、没做完的里最早的截止日。 */
function taskProgress(activities: THomePlanActivity[]) {
  const done = activities.filter((activity) => activity.column === "done").length;
  const due = activities.flatMap(({ item, column }) => (column !== "done" && item.dueDate ? [item.dueDate] : [])).sort()[0] ?? null;
  return { done, total: activities.length, due };
}

export function TaskList({ tasks, activitiesOf, loose, selected, infoOpen, onPick, onInfo }: {
  tasks: THomePlanTask[];
  activitiesOf: (taskId: string) => THomePlanActivity[];
  /** 未归入 Task 的件数。 */
  loose: number;
  selected: string;
  infoOpen: boolean;
  onPick: (taskId: string) => void;
  onInfo: (open: boolean) => void;
}) {
  return (
    <div className={s.tasks} data-task-list role="group" aria-label="Task">
      {tasks.map((task) => {
        const chosen = selected === task.taskId;
        const { done, total, due } = taskProgress(activitiesOf(task.taskId));
        return (
          <div key={task.taskId} className={s.task} data-selected={chosen || undefined}>
            <button type="button" className={s.taskHit} data-task={task.taskId} aria-pressed={chosen} onClick={() => onPick(task.taskId)}>
              <span className={s.taskName}>{task.name}</span>
              <span className={s.taskMeta}>
                <span>已完成 {done} / {total}</span>
                {due ? <span>{shortDate(due)}</span> : null}
              </span>
              <span className={s.bar} aria-hidden="true"><span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} /></span>
            </button>
            {chosen && hasInfo(task) && (
              <Popover isOpen={infoOpen} onOpenChange={onInfo}>
                <Button variant="ghost" size="sm" isIconOnly className={s.info} data-info aria-label="做到什么算完">i</Button>
                <Popover.Content placement="bottom start" className={s.float}>
                  <TianshuPortalTheme>
                    <Popover.Dialog className={`${s.dialog} ${s.infoDialog}`} aria-label={task.name}>
                      {task.doneDefinition && <div className={s.infoPart}><b>做到什么算完</b><p>{task.doneDefinition}</p></div>}
                      {task.criteria.length > 0 && <div className={s.infoPart}><b>验收标准</b><ol>{task.criteria.map((line, index) => <li key={index}>{line}</li>)}</ol></div>}
                    </Popover.Dialog>
                  </TianshuPortalTheme>
                </Popover.Content>
              </Popover>
            )}
          </div>
        );
      })}
      {loose > 0 && (
        <div className={s.task} data-loose data-selected={selected === LOOSE || undefined}>
          <button type="button" className={s.taskHit} data-task={LOOSE} aria-pressed={selected === LOOSE} onClick={() => onPick(LOOSE)}>
            <span className={s.taskMeta}><span className={s.taskName}>未归入 Task</span><span>{loose} 件</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
