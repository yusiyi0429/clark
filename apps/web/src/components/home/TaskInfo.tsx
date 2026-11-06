"use client";

/**
 * Task 详情（新首页设计第 1、3 节：点 Task 标题右边的信息图标，在展示区看）：是什么、验收时间点、完成标准和约定（每条用什么证明、谁来认，这次不包括什么）、
 * 交付物（V1 的交付面板原样嵌进来，「我的事项」那一折不出）。以前在右栏的 Task 视图挪到这里。
 */
import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { THomePlanResponse, THomePlanTask } from "@warmap/contracts";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { gateOf, gateText } from "@/components/board/MonthLanes";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { taskHref } from "@/lib/home/derive";
import { useViewChrome } from "./view";
import d from "@/styles/task-deliverable.module.css";
import h from "@/styles/home.module.css";

type Agreement = components["schemas"]["TaskAgreementResponse"];
const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export function TaskInfo({ plan, task, board, go }: { plan: THomePlanResponse; task: THomePlanTask; board: TaskBoard | null; go: (href: string) => void }) {
  const chrome = useViewChrome();
  const [agreement, setAgreement] = useState<Agreement | null>(null);
  useEffect(() => {
    let alive = true;
    setAgreement(null);
    void browserApi.GET("/api/plan-tasks/{taskId}/agreement", { params: { path: { taskId: task.taskId } } })
      .then(({ data }) => { if (alive && data) setAgreement(data as Agreement); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.taskId]);
  const mission = plan.missions.find((entry) => entry.missionId === task.missionId) ?? null;
  const gate = gateText(gateOf(plan, task.missionId));
  const criteria = agreement?.criteria.length ? agreement.criteria
    : (board?.criteria ?? task.criteria.map((text, index) => ({ index: index + 1, text }))).map((entry) => ({ ...entry, proof: null, acceptor: null }));
  return (
    <div className={h.infoView} data-testid="task-info-view">
      <header className={h.viewHead}>
        {chrome.lead}
        <span className={h.viewTitle}>{task.name}</span>
        <button type="button" className={h.icon} aria-label="详情" title="详情" aria-pressed onClick={() => go(taskHref(task.taskId))}><Info {...ICON} /></button>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>
          <div className={h.infoLead}>
            {mission ? <span className={h.faint}>{mission.title}</span> : null}
            <h1>{task.name}</h1>
            {gate ? <span className={h.faint}>{gate}</span> : null}
            {task.doneDefinition ? <p>{task.doneDefinition}</p> : null}
          </div>
          {criteria.length ? (
            <section aria-label="完成标准" className={h.infoSec}>
              <p className={h.sectionTitle}>完成标准</p>
              <ol className={h.crits}>
                {criteria.map((criterion) => (
                  <li key={criterion.index}>
                    <span className={h.critNo}>{criterion.index}</span>
                    <span>
                      {criterion.text}
                      {criterion.proof || criterion.acceptor ? (
                        <small>{[criterion.proof ? `证明：${criterion.proof}` : null, criterion.acceptor ? `${criterion.acceptor.name} 来认` : null].filter(Boolean).join(" · ")}</small>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
              {agreement?.exclusions.length ? <p className={h.faint}>不包括：{agreement.exclusions.join("；")}</p> : null}
            </section>
          ) : null}
          <section aria-label="交付物" className={h.infoSec}>
            <p className={h.sectionTitle}>交付物{board?.pending.length ? <span>v{board.nextVersion} 在攒 {board.pending.length} 样</span> : null}</p>
            <div data-board-deliverable>
              <style>{`[data-board-deliverable] .${d.fold}{display:none}`}</style>
              <TaskDeliverable task={task} activities={null} activityCount={0} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
