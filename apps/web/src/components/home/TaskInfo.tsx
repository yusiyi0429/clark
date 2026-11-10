"use client";

/**
 * Task 详情（新首页设计第 1、3 节：点 Task 标题右边的信息图标，在展示区看）：属于哪个 Mission、验收时间点、完成定义，
 * 下面是 V1 的 Task 面板原样嵌进来（约定、对表、交一版、请认可人看、交付），不另画一份。
 * 文档类页面（5.4.7）：data-type-scale="doc"，正文列 --doc-measure（600），辅助字 13/20。
 * key 换 Task 时重来（面板里选中的版本、写到一半的现状不带过去）；checkOnOpen 打开时对一次表。
 */
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { HOME_HREF, infoHref, taskHref } from "@/lib/home/derive";
import { useViewChrome } from "./view";
import { TaskBudget } from "./TaskBudget";
import h from "@/styles/home.module.css";

import { ICON } from "./StateIcon";

export function TaskInfo({ task, mission, gate, go, foreign = false }: {
  task: Pick<THomePlanTask, "taskId" | "name" | "doneDefinition">;
  mission: string | null;
  gate: string | null;
  go: (href: string) => void;
  /** 别人的 Task（只读，没有管线）：返回回到上一页（没有就回首页），标题就是 Task 名，不带「/ 详情」。 */
  foreign?: boolean;
}) {
  const chrome = useViewChrome();
  const where = [mission, gate].filter(Boolean).join(" · ");
  const back = () => (foreign ? (window.history.length > 1 ? window.history.back() : go(HOME_HREF)) : go(taskHref(task.taskId)));
  return (
    <div className={h.infoView} data-type-scale="doc" data-testid="task-info-view">
      <header className={h.viewHead}>
        <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={back}><ArrowLeft {...ICON} /></button>
        <h1 className={h.viewTitle} tabIndex={-1}>
          {foreign ? task.name : <><button type="button" className={h.crumb} onClick={() => go(taskHref(task.taskId))}>{task.name} / </button><span className={h.ellipsis}>详情</span></>}
        </h1>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>
          {where || task.doneDefinition ? (
            <div className={h.infoLead}>
              {where ? <span>{where}</span> : null}
              {task.doneDefinition ? <p>{task.doneDefinition}</p> : null}
            </div>
          ) : null}
          {/* 预算（11.3）：本人的 Task 才能改；别人的只读详情不放。 */}
          {foreign ? null : <TaskBudget key={task.taskId} taskId={task.taskId} />}
          <TaskDeliverable key={task.taskId} task={{ taskId: task.taskId }} checkOnOpen />
        </div>
      </div>
    </div>
  );
}

/**
 * 不在本人计划和树上的 Task（请你认可、飞书「请 X 看」、之前月份了结了的）：只读详情（9.8、9.10）。
 * 名字读约定接口的 taskName（同老的 PlanTaskScreen）；能不能改由服务端的 canEdit 定。看不到（403、404）才是「没有这件 Task」。
 * redirect：从管线地址进来的，地址换成详情（别人的 Task 没有管线）。
 */
export function ForeignTaskInfo({ taskId, go, redirect = false, onMount }: { taskId: string; go: (href: string) => void; redirect?: boolean; onMount?: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (redirect) window.history.replaceState(null, "", infoHref(taskId));
    onMount?.();
    // 只在进来时做一次。
  }, []);
  useEffect(() => {
    let live = true;
    void fetch(`/api/plan-tasks/${encodeURIComponent(taskId)}/agreement`).then(async (response) => {
      if (!live) return;
      if (response.status === 403 || response.status === 404) { setHidden(true); return; }
      const body = await response.json().catch(() => null) as { taskName?: string } | null;
      if (live && response.ok && body?.taskName) setName(body.taskName);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [taskId]);
  if (hidden) return <div className={h.missing}><p>没有这件 Task</p></div>;
  return <TaskInfo task={{ taskId, name: name ?? "", doneDefinition: null }} mission={null} gate={null} go={go} foreign />;
}
