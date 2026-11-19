-- Task 的「原」验收时间点（本人 11/19 定）：没单独定日子的 Task，天枢第一次读到它时把当时最近的 Mission 节点记下来，之后不往后滚，
-- 过了没交就留在那一段显示「已过 N 天」。基准日：这个 Mission 第一次有 Task 被记下时（上线前就有的那批），取 Mission 进天枢的日子（missions.created_at）；
-- 之后才出现的 Task 取第一次读到的那天。本人改的日子在 task_due_dates（唯一一份），这里只是「原」，不算本人改过。
CREATE TABLE task_planned_due_dates (
  task_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  due_date TEXT NOT NULL CHECK (due_date ~ '^\d{4}-\d{2}-\d{2}$'),
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX task_planned_due_dates_mission ON task_planned_due_dates (mission_id);
