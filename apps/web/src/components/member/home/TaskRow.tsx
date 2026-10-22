"use client";

/**
 * Mission 卡片的 Task 行：胶囊只写名字（「全部」视图下前面加 Mission 色点），末尾「其他 N」（N 为 0 不出）。
 * 选中的 Task 有完成定义或验收标准时后面出 ⓘ，点开小浮层（ts-design Popover，和会议页的编辑浮层同一个样子）。
 */
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { THomePlanTask } from "@warmap/contracts";
import { tone } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

/** 「其他」胶囊：没挂 Task，或挂的 Task 不在当前范围里。 */
export const OTHER = "other";

export const hasInfo = (task: THomePlanTask) => task.doneDefinition !== null || task.criteria.length > 0;

export function TaskRow({ tasks, selected, others, dots, colorOf, infoOpen, onPick, onInfo }: {
  tasks: THomePlanTask[];
  selected: string | null;
  others: number;
  /** 「全部」视图：胶囊前加 Mission 色点。 */
  dots: boolean;
  colorOf: (missionId: string) => string;
  infoOpen: boolean;
  onPick: (taskId: string) => void;
  onInfo: (open: boolean) => void;
}) {
  return (
    <div className={s.tasks} data-task-row role="group" aria-label="Task">
      {tasks.map((task) => {
        const chosen = selected === task.taskId;
        return (
          <div key={task.taskId} className={s.task} data-selected={chosen || undefined}>
            <button type="button" className={s.taskName} data-task={task.taskId} aria-pressed={chosen} onClick={() => onPick(task.taskId)}>
              {dots && <i className={s.dot} style={tone(colorOf(task.missionId))} aria-hidden />}
              {task.name}
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
      {others > 0 && (
        <div className={s.task} data-selected={selected === OTHER || undefined}>
          <button type="button" className={s.taskName} data-task={OTHER} aria-pressed={selected === OTHER} onClick={() => onPick(OTHER)}>
            其他<span className={s.count}>{others}</span>
          </button>
        </div>
      )}
    </div>
  );
}
