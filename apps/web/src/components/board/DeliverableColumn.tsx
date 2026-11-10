"use client";

/**
 * 看板最右一列交付物（第 11.2 节）：上面一行「v2 准备中 N 项」和「出 v2」，下面嵌现有的交付物面板（TaskDeliverable，V1 在改，这里只嵌不改）。
 * 面板底部「我的事项」那一折在看板上就是看板本身，这里不显示（只藏，不改面板）。
 */
import { useState } from "react";
import type { THomePlanTask } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { shipPending } from "@/lib/board/cloud";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { showWorkspaceToast } from "@/lib/toast";
import s from "@/styles/v2-board.module.css";
import d from "@/styles/task-deliverable.module.css";

export function DeliverableColumn({ task, board, onChanged }: { task: THomePlanTask; board: TaskBoard; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const next = `v${board.nextVersion}`;
  const ship = async () => {
    setBusy(true);
    try {
      await shipPending(task.taskId);
      showWorkspaceToast({ text: `${next} 已建好，参考评审开始` });
      window.dispatchEvent(new Event("member-tasks-changed"));
      onChanged();
    } catch (error) {
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.deliv} data-testid="deliverable-column">
      <h4>交付物</h4>
      {board.pending.length ? (
        <div className={s.pending}>
          <div className={s.pendingHead}><span className={s.tag} data-tone="ver">{next} 准备中</span><span className={s.faint}>{board.pending.length} 项</span></div>
          <ul>{board.pending.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
          <HeroButton variant="secondary" size="sm" onPress={() => void ship()} isDisabled={busy}>{busy ? "正在出…" : `出 ${next}`}</HeroButton>
        </div>
      ) : null}
      {/* 只藏交付物面板里的「我的事项」一折：看板上它就是左边四列。 */}
      <style>{`[data-board-deliverable] .${d.fold}{display:none}`}</style>
      <div data-board-deliverable>
        <TaskDeliverable key={task.taskId} task={task} activities={null} activityCount={0} />
      </div>
    </div>
  );
}
