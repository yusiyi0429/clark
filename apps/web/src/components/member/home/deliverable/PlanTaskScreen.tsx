"use client";

/**
 * 别人的 Task（飞书「请 X 看」的链接，认可人、Mission 负责人、战场负责人、CEO 点进来）：二级页里只放这个 Task 的交付物面板，
 * 打开就对一次表；能不能改由服务端的 canEdit 定，这里不另做一套。标题读约定接口的 taskName；看不到就一句话。
 * 成员走 /me/plan-tasks/[taskId]，CEO 走 /plan-tasks/[taskId]；对话沿用全局（同成员战场详情）。
 */
import { useEffect, useState } from "react";
import type { Card } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { TaskDeliverable } from "./TaskDeliverable";
import d from "@/styles/task-deliverable.module.css";

const EMPTY_CARDS: Card[] = [];

export function PlanTaskScreen({ taskId }: { taskId: string }) {
  const workspace = useWorkspace();
  const [name, setName] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
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
  useRegisterDetail({ scope: "global", label: name ?? "Task", mark: null, cards: EMPTY_CARDS });
  return (
    <div className={d.screen}>
      <DetailFrame title={name ?? ""} subtitle="Task" onBack={workspace.close}>
        <div className={d.screenBody}>
          {hidden ? <p className={d.screenEmpty} role="status">这个 Task 不存在或当前不可见。</p> : <TaskDeliverable task={{ taskId }} checkOnOpen />}
        </div>
      </DetailFrame>
    </div>
  );
}
