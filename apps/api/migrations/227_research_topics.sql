-- V2 调研专题（researchTopics.ts）：在本机由 Claude Code 跑，版本由本机经同步报上来。只归档，不删；对话全文只在本机，云端不存。
-- plan_task_id、mission_id 可空：专题可以不挂 Task。
CREATE TABLE research_topics (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  plan_task_id TEXT,
  mission_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_version_at TIMESTAMPTZ,
  CHECK ((plan_task_id IS NULL) = (mission_id IS NULL))
);
CREATE INDEX research_topics_owner ON research_topics (owner_id, status, updated_at DESC);

-- 专题的一版：number 从 1 起连续；client_id 是本机给的去重键（同步条目的幂等键）；feishu_url 是存进飞书以后的地址。
CREATE TABLE topic_versions (
  id UUID PRIMARY KEY,
  topic_id UUID NOT NULL REFERENCES research_topics (id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (number >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('outline', 'draft')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  body TEXT NOT NULL CHECK (char_length(body) <= 200000),
  note TEXT CHECK (char_length(note) <= 200),
  feishu_url TEXT,
  client_id TEXT NOT NULL,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (topic_id, number),
  UNIQUE (topic_id, client_id)
);
