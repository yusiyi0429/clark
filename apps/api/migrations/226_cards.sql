-- V2 执行看板（cards.ts / taskCards.ts）：卡就是执行事项，这里给 tasks 加卡的几列；都可空，空就是老事项。
-- executor：claude_code 在本机由 Claude Code 干、交回后 Agent 验收；self 本人自己做、本人验收。
-- model：卡选的模型，只存名字 {id, label, kind: subscription|gateway}，不存钥匙。brief：交代。
-- criterion_index / criterion_text：对本体 Task 的第几条标准（从 1 起）和那条当时的原文；空表示「其他」。
ALTER TABLE tasks
  ADD COLUMN executor TEXT CHECK (executor IN ('claude_code', 'self')),
  ADD COLUMN model JSONB,
  ADD COLUMN brief TEXT CHECK (char_length(brief) BETWEEN 1 AND 4000),
  ADD COLUMN criterion_index INTEGER CHECK (criterion_index >= 1),
  ADD COLUMN criterion_text TEXT;
CREATE INDEX tasks_plan_task_owner ON tasks (plan_task_id, owner_id) WHERE plan_task_id IS NOT NULL;

-- 一次拆卡（后台作业，cardPlanner.ts）：同一个 Task 同时只跑一次；run_token 防旧的一次覆盖新的，running 超过 10 分钟重排。
CREATE TABLE card_plans (
  id UUID PRIMARY KEY,
  plan_task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  hint TEXT CHECK (char_length(hint) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  error TEXT,
  run_token UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX card_plans_one_active ON card_plans (plan_task_id) WHERE status IN ('queued', 'running');
CREATE INDEX card_plans_task ON card_plans (plan_task_id, created_at DESC);

-- 草稿卡：放进看板（accepted，task_id 指向建出来的执行事项）或不要（dismissed）以后不再显示。
-- model_tier 是伙伴建议的档位，本人开工时再落到具体模型。
CREATE TABLE card_drafts (
  id UUID PRIMARY KEY,
  plan_id UUID NOT NULL REFERENCES card_plans (id) ON DELETE CASCADE,
  plan_task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  brief TEXT NOT NULL DEFAULT '' CHECK (char_length(brief) <= 4000),
  done_definition TEXT NOT NULL CHECK (char_length(done_definition) BETWEEN 1 AND 500),
  criterion_index INTEGER CHECK (criterion_index >= 1),
  executor TEXT NOT NULL CHECK (executor IN ('claude_code', 'self')),
  model_tier TEXT NOT NULL CHECK (model_tier IN ('strong', 'normal', 'light')),
  why TEXT CHECK (char_length(why) <= 200),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  task_id UUID REFERENCES tasks (id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (plan_id, position)
);
CREATE INDEX card_drafts_open ON card_drafts (plan_task_id, owner_id) WHERE status = 'open';
