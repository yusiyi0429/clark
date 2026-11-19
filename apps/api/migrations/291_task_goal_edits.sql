-- 本人在本月页就地改的 Task 名字和完成标准（11/19 DRI 根据地，设计稿路 A）：天枢里先生效、标「未进本体」，天枢不写本体。
-- 按 taskId 另存；读 Task 的那一个来源外面包一层套上（taskGoalEdits.ts）。name / criteria 为 NULL 是那一样没改；和本体一样时整条撤掉。
-- world_name / world_criteria 是改的时候本体里的原文（留痕）；页面上「原」那一行照本体现在的原文写。
CREATE TABLE task_goal_edits (
  task_id TEXT PRIMARY KEY,
  name TEXT,
  criteria JSONB CHECK (criteria IS NULL OR jsonb_typeof(criteria) = 'array'),
  world_name TEXT NOT NULL,
  world_criteria JSONB NOT NULL CHECK (jsonb_typeof(world_criteria) = 'array'),
  edited_by TEXT NOT NULL,
  edited_at TIMESTAMPTZ NOT NULL,
  CHECK (name IS NOT NULL OR criteria IS NOT NULL)
);
