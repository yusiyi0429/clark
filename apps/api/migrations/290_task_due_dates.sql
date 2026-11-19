-- Task 的验收时间点（天枢里存的，本人在本月页、项目详情改，或伙伴改）：按 Task 存，不要求挂项目，只有这一份。
-- 原来存在挂接 project_goals.due_date 上（迁移 261），没挂项目的 Task 存不了；搬过来以后删掉老列。没存的按 Mission 的节点算。
CREATE TABLE task_due_dates (
  task_id TEXT PRIMARY KEY,
  due_date TEXT NOT NULL CHECK (due_date ~ '^\d{4}-\d{2}-\d{2}$')
);
INSERT INTO task_due_dates(task_id,due_date) SELECT task_id,due_date FROM project_goals WHERE due_date IS NOT NULL;
ALTER TABLE project_goals DROP COLUMN due_date;
