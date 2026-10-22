-- 成员首页的计划点：本人在自己 Mission 下标的日子，只存天枢本地，不写本体。
-- 一个人在一个 Mission 下最多 20 个、名字最多 10 个字（上限在 planMarks.ts 里检查，名字长度这里兜底）。
CREATE TABLE plan_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  date DATE NOT NULL,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plan_marks_owner_mission_idx ON plan_marks (owner_id, mission_id);

-- 执行事项挂到本体 Task 上的编号（首页计划的 Task 行用）。
ALTER TABLE tasks ADD COLUMN plan_task_id TEXT;
