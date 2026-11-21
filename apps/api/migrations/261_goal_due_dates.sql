-- Task 的验收截止日（天枢里存的，本人或伙伴改）：存在挂接上，跟着 Task 走（换项目不丢）。首页先看本体 Task 自己的（0.3 还没有），再看这里，都没有退回 Mission 的节点。
ALTER TABLE project_goals ADD COLUMN due_date TEXT CHECK (due_date ~ '^\d{4}-\d{2}-\d{2}$');
