-- 本月页「+ 添一件」（11/19 DRI 根据地第 4 步）：本人在自己的 Mission 下新建的 Task，只在天枢里（天枢自己的 id，标「未进本体」，天枢不写本体）。
-- 和本体读回来的 Task 走同一个来源（taskGoalEdits.ts 那一层）：能挂项目、拆卡、进复盘。名字、标准就地改直接改这里（没有本体原文，不出「恢复」）。
-- 不要了在去向里选「已取消」，不删。
CREATE TABLE added_tasks (
  task_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions (id),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  criteria JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(criteria) = 'array'),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX added_tasks_mission ON added_tasks (mission_id);
