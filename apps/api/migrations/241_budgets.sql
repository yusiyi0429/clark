-- 新首页 11.3：预算（只存和读；到了怎么降档、怎么停是本机程序的事）。
-- person_settings.budget：本人新 Task 的缺省预算（没有 = 自动）。task_budgets：每人每件 Task 单独设的预算。
ALTER TABLE person_settings ADD COLUMN budget JSONB;
CREATE TABLE task_budgets (
  owner_id TEXT NOT NULL,
  plan_task_id TEXT NOT NULL,
  budget JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, plan_task_id)
);
