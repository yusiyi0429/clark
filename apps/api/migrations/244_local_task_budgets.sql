-- 本机报的预算用了多少（同步条目 budget，本机契约 LocalTaskBudgetView）：一件 Task 一份，不挂 Task 的专题一个会话一份；同一份以 updatedAt 最新为准。
-- 先存下来（Task 行「预算 80%」、等你「加 50% 继续」以后读它）。subject_key 是 task:<taskId> 或 session:<sessionId>。
CREATE TABLE local_task_budgets (
  owner_id TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  view JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, subject_key)
);
