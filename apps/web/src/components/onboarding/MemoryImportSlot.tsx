"use client";

/**
 * 上手最后一页「导入的记忆」标签的插槽。
 *
 * 接口约定（另一条工作流做的导入确认组件按这个接进来，替换下面的占位实现，WelcomeFlow 不用改）：
 * - 组件名与导出：本文件导出 `MemoryImportPanel`，props 为 `MemoryImportPanelProps`。
 * - 只列不确定的和有冲突的记忆（前端交互说明 10a 第 4 步、记忆导入设计 4.5）；有把握的默认处理，不进这个列表。
 * - `confirmed`：上手流程保存的「这个标签确认过」，切换标签、前后翻页都不丢。组件据此显示已确认的样子。
 * - `onConfirmedChange(true)`：本人在这个标签里点了确认、并且已经提交成功之后调用，标签随即打勾；
 *   确认之后本人又改了勾选、需要重新确认时调用 `onConfirmedChange(false)`。三个标签都打勾，「完成」才能点。
 * - `localMemoryFiles`：采集器盘点到的本机记忆文件数（/api/me/collector/status 的 inventory.memoryFiles），没连上采集器时为 null。
 * - 组件自己读写导入数据（接口由导入工作流定），不依赖上手流程的其他状态；外层已经是玻璃卡片的宽度，组件不再套卡片。
 * - 不写说明句：用数字、状态标签和勾选表达。
 */
import { Check } from "lucide-react";
import c from "./setup.module.css";

export type MemoryImportPanelProps = {
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  localMemoryFiles: number | null;
};

/** 占位实现：导入确认组件接进来之前，只显示本机盘点到的记忆文件数，确认即打勾。 */
export function MemoryImportPanel({ confirmed, onConfirmedChange, localMemoryFiles }: MemoryImportPanelProps) {
  return <div data-slot="memory-import">
    <div className={c.stat}><span>本机记忆文件</span><strong>{localMemoryFiles ?? "—"}</strong></div>
    <div className={c.listFoot}>
      <span className={c.count}>待你看 0</span>
      {confirmed ? <span className={c.done}><Check size={16} strokeWidth={3} aria-hidden="true" />已确认</span>
        : <button type="button" className={c.action} onClick={() => onConfirmedChange(true)}>确认</button>}
    </div>
  </div>;
}
