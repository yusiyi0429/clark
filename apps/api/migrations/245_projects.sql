-- 项目常驻，每月目标挂在项目上（契约 projects.ts，设计《新首页》第 16 节）。天枢自己的数据，不写本体。

-- 项目：一件一直做下去的事，没有「完成」，不做了就归档（archived_at）。这次只做个人项目（owner_id）。
-- origin_mission_id：上线迁移按哪张 Mission 建的（本人建的为空）；那张 Mission 下后来才读到的 Task 自动挂到这里。
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  origin_mission_id TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX projects_owner ON projects (owner_id);

-- 挂接：一件 Task 只挂一个项目。period、mission_*、task_name 是挂上时的快照（目标历史在本体读不到时照样能写）。
-- 本人取下来（DELETE …/goals/:taskId）时 project_id 置空、source 记 owner：这件留给本人在「本月」里选，不再自动挂。
-- linked_at 是挂上的时间：项目对话里「{月} 月目标：{Task 名}」那条分隔线的位置。
CREATE TABLE project_goals (
  task_id TEXT PRIMARY KEY,
  project_id UUID REFERENCES projects (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  mission_id TEXT NOT NULL,
  mission_title TEXT,
  task_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto', 'owner', 'migration')),
  linked_at TIMESTAMPTZ NOT NULL,
  CHECK (project_id IS NOT NULL OR source = 'owner')
);
CREATE INDEX project_goals_project ON project_goals (project_id, period);

-- 项目对话接了 Chat 服务时的对应：Chat 里那段对话的 id（同 237 的 task_pipelines，那张表留着当历史）。没接 Chat 时是 scope 为 project:<id> 的天枢对话。
CREATE TABLE project_pipelines (
  project_id UUID PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 卡（和自己做的事项）、专题、交付版本在哪个项目里：挂着 Task 的跟着 Task 挂的项目（挂上、移走时一起改）；不挂 Task 的活直接记项目。
ALTER TABLE tasks ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE SET NULL;
ALTER TABLE research_topics ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE SET NULL;
ALTER TABLE deliverable_versions ADD COLUMN project_id UUID REFERENCES projects (id) ON DELETE SET NULL;

-- 上线迁移（16.5）每人做一次：本人第一次读新首页时按「看得见的 Mission」建项目、挂 Task、并对话；report 记做了什么（前后对照用）。
CREATE TABLE project_bootstraps (
  person_id TEXT PRIMARY KEY,
  done_at TIMESTAMPTZ NOT NULL,
  report JSONB NOT NULL
);
