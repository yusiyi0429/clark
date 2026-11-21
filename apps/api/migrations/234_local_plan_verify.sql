-- V2 第 21 节：拆卡和验收改在本机。本机会话多两种：plan（规划员，拆一个本体 Task）、verify（验收员，验一次交回，挂被验的那张卡）。
ALTER TABLE local_runs ADD COLUMN plan_task_id TEXT;
ALTER TABLE local_runs DROP CONSTRAINT local_runs_kind_check;
ALTER TABLE local_runs ADD CONSTRAINT local_runs_kind_check CHECK (kind IN ('card', 'topic', 'plan', 'verify'));
ALTER TABLE local_runs DROP CONSTRAINT local_runs_check;
ALTER TABLE local_runs ADD CONSTRAINT local_runs_subject_check
  CHECK ((kind IN ('card', 'verify')) = (task_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL) AND (kind = 'plan') = (plan_task_id IS NOT NULL));

-- 拆卡记是谁拆的：cloud 是云端作业（开关默认关），local 是本机规划员经同步条目 card_plan 报上来的。
-- 本机的一次规划会话对应一行（run_id），本人说一句让它改、再出一次时 revision 加一，草稿换成最新一次的。summary、steps、risks 是它出的计划。
ALTER TABLE card_plans
  ADD COLUMN source TEXT NOT NULL DEFAULT 'cloud' CHECK (source IN ('cloud', 'local')),
  ADD COLUMN run_id UUID,
  ADD COLUMN revision INTEGER CHECK (revision >= 1),
  ADD COLUMN summary TEXT CHECK (char_length(summary) <= 500),
  ADD COLUMN steps JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN risks JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN model_label TEXT,
  ADD COLUMN role_id UUID,
  ADD COLUMN role_version INTEGER;
CREATE UNIQUE INDEX card_plans_run ON card_plans (run_id) WHERE run_id IS NOT NULL;

-- 验收记是谁验的：cloud 云端作业、local 本机验收员；模型、验收员岗位和版本；本机验收会话的 id。
ALTER TABLE card_handbacks
  ADD COLUMN verifier_source TEXT CHECK (verifier_source IN ('cloud', 'local')),
  ADD COLUMN verifier_model TEXT,
  ADD COLUMN verifier_role_id UUID,
  ADD COLUMN verifier_role_version INTEGER,
  ADD COLUMN verify_run_id UUID;

-- 拆卡登记：伙伴（register_card_split）或 Task 页「拆一下」记下本人要拆这个 Task；网页在本人电脑上开了规划员以后关掉（closed_at）。
-- 同一个人同一个 Task 同时只有一条没关的。
CREATE TABLE card_split_requests (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  plan_task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('buddy', 'web')),
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX card_split_requests_open ON card_split_requests (owner_id, plan_task_id) WHERE closed_at IS NULL;
