-- 项目转交（契约 projectTransfers.ts，设计《新首页》16.7）。天枢自己的数据，不写本体。

-- 一份转交：preparing 准备交接 → sent 发出 → accepted 接手 / declined 不接；没接之前原负责人随时撤回（withdrawn）。
-- 一个项目同时只有一份没了结的（preparing 或 sent）。接手了的就是负责人的交接记录：from_id 是以前的负责人（只读看项目）。
-- note 是交接说明（[{ title, lines }]）；check_result 是本机程序的交接检查原样（LocalHandoverCheck）；running / check_choice 是准备时本人的两个选择。
CREATE TABLE project_transfers (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL CHECK (to_id <> from_id),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'sent', 'accepted', 'declined', 'withdrawn')),
  note JSONB,
  include_history BOOLEAN NOT NULL DEFAULT false,
  running TEXT CHECK (running IN ('wait', 'stop')),
  check_choice TEXT CHECK (check_choice IN ('wait', 'skip')),
  check_result JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX project_transfers_open ON project_transfers (project_id) WHERE status IN ('preparing', 'sent');
CREATE INDEX project_transfers_to ON project_transfers (to_id, status);
CREATE INDEX project_transfers_from ON project_transfers (from_id, status);

-- 接手以后管线先不自己开子会话，等接手人先说一句：接手时记下，接手人在项目对话里发了第一句就清掉。
ALTER TABLE projects ADD COLUMN quiet_since TIMESTAMPTZ;

-- 项目对话接了 Chat 时一人一段：交接以后原负责人那段留着只读，接手人另开一段（Chat 的段按人分）。
ALTER TABLE project_pipelines DROP CONSTRAINT project_pipelines_pkey;
ALTER TABLE project_pipelines ADD PRIMARY KEY (project_id, owner_id);
