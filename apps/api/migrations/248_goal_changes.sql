-- 新首页 16.4 月中：本月挂在项目上的 Task 在本体里改了（名字、验收标准）或取消了，项目不动；和它有关、还没做完的子会话还在时，项目对话里出选项框「停掉 / 留着」。
-- project_goals.criteria 是验收标准的快照（为空是还没记过，第一次读到时记下、不算改动）。
ALTER TABLE project_goals ADD COLUMN criteria JSONB;

CREATE TABLE project_goal_changes (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('changed', 'cancelled')),
  sessions JSONB NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  answer TEXT CHECK (answer IN ('stop', 'keep')),
  answered_at TIMESTAMPTZ,
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX project_goal_changes_project ON project_goal_changes (project_id, detected_at);
-- 取消只出一次。
CREATE UNIQUE INDEX project_goal_changes_cancelled ON project_goal_changes (task_id) WHERE change = 'cancelled';
