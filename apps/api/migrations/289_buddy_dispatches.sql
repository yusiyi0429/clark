-- 回退 SQL：
--   DROP TABLE buddy_dispatches;
--   DROP INDEX projects_one_scratch;
--   ALTER TABLE projects DROP COLUMN scratch;
-- 「随手」项目：每人最多一个，一次性的活都开在它里面（本人 11/18）。
ALTER TABLE projects ADD COLUMN scratch boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX projects_one_scratch ON projects (owner_id) WHERE scratch;
-- 伙伴在主线派出去的活：kind = topic 开了哪个会话（topic_id），kind = project 转给了哪个项目的对话（topic_id 为空）。
-- 读历史时在那一轮上画小条；会话做完一轮时主线出一行。
-- title 是会话那时的名字：会话被真删（topic_id 置空）以后小条照它显示。
-- 项目被删（project_id 置空）时这一行留着：project_ref 是派活时的项目 id（卡上的 projectId 照它），project_name 是那时的项目名。
CREATE TABLE buddy_dispatches (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'project')),
  run_id TEXT,
  conversation_id TEXT,
  project_id UUID REFERENCES projects (id) ON DELETE SET NULL,
  project_ref UUID NOT NULL,
  project_name TEXT NOT NULL,
  topic_id UUID REFERENCES research_topics (id) ON DELETE SET NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, request_key)
);
CREATE INDEX buddy_dispatches_run ON buddy_dispatches (owner_id, run_id);
CREATE INDEX buddy_dispatches_topic ON buddy_dispatches (topic_id) WHERE topic_id IS NOT NULL;
