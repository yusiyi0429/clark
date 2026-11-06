"use client";

/**
 * Task 详情（新首页设计第 1、3 节：点 Task 标题右边的信息图标，在展示区看）：属于哪个 Mission、验收时间点、完成定义，
 * 下面是 V1 的 Task 面板原样嵌进来（约定、对表、交一版、请认可人看、交付），不另画一份。
 * key 换 Task 时重来（面板里选中的版本、写到一半的现状不带过去）；checkOnOpen 打开时对一次表。
 */
import { ArrowLeft } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { taskHref } from "@/lib/home/derive";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";

import { ICON } from "./StateIcon";

export function TaskInfo({ task, mission, gate, go }: {
  task: Pick<THomePlanTask, "taskId" | "name" | "doneDefinition">;
  mission: string | null;
  gate: string | null;
  go: (href: string) => void;
}) {
  const chrome = useViewChrome();
  const where = [mission, gate].filter(Boolean).join(" · ");
  return (
    <div className={h.infoView} data-testid="task-info-view">
      <header className={h.viewHead}>
        <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => go(taskHref(task.taskId))}><ArrowLeft {...ICON} /></button>
        <h1 className={h.viewTitle} tabIndex={-1}><button type="button" className={h.crumb} onClick={() => go(taskHref(task.taskId))}>{task.name} / </button>详情</h1>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>
          {where || task.doneDefinition ? (
            <div className={h.infoLead}>
              {where ? <span className={h.faint}>{where}</span> : null}
              {task.doneDefinition ? <p>{task.doneDefinition}</p> : null}
            </div>
          ) : null}
          <TaskDeliverable key={task.taskId} task={{ taskId: task.taskId }} checkOnOpen />
        </div>
      </div>
    </div>
  );
}
