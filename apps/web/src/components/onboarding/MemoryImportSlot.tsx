"use client";

/**
 * 上手「确认清单」一步里「记忆文件」那一行展开后的插槽。
 *
 * 接口约定（另一条工作流做的导入确认组件按这个接进来，替换下面的占位实现）：
 * - 组件名与导出：本文件导出 `MemoryImportPanel`，props 为 `MemoryImportPanelProps`。
 * - 只列不确定的和有冲突的记忆（前端交互说明 10a 第 4 步、记忆导入设计 4.5）；有把握的默认处理，不进这个列表。
 * - 本人不用在这里单独点确认：底栏「完成」时按默认导入。确认时有必须本人处理的（例如冲突）时，
 *   再加一个回调告诉摘要，摘要那一行标出待处理、保留展开入口。
 * - `localMemoryFiles`：采集器盘点到的本机记忆文件数（/api/me/collector/status 的 inventory.memoryFiles）。
 * - 组件自己读写导入数据（接口由导入工作流定），不依赖上手流程的其他状态；外层已经是玻璃卡片的宽度，组件不再套卡片。
 * - 不写说明句：用数字、状态标签和勾选表达。
 */
import c from "./setup.module.css";

export type MemoryImportPanelProps = {
  localMemoryFiles: number | null;
};

/** 占位实现：导入确认组件接进来之前，只显示本机盘点到的记忆文件数，没有要提交的。 */
export function MemoryImportPanel({ localMemoryFiles }: MemoryImportPanelProps) {
  return <div data-slot="memory-import">
    <div className={c.stat}><span>本机记忆文件</span><strong>{localMemoryFiles ?? "—"}</strong></div>
  </div>;
}
