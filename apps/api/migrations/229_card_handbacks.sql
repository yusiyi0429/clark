-- V2 卡的交回和 Agent 验收（cardAcceptance.ts）：一次交回一行，验收结果也记在这一行，写法照 deliverable_versions（一个版本一次评审）。
-- criteria：交回那一刻卡的完成标准（快照）；claims：执行方逐条写的 [{index, result, evidence}]；output_ids：这次交回算进去的产出和证据。
-- status / run_token / started_at / finished_at / error：验收作业；result：{criteria:[{index, verdict, reason, evidence, fix}], beyondScope[], headline}。
-- outcome：pass | fail；return_text：没过时发回执行方的那段话（固定格式拼，不调模型）；returned_at：网页已经把它送到本机。
-- overruled_*：本人推翻这次验收。
CREATE TABLE card_handbacks (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  run_id UUID REFERENCES local_runs (id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  criteria JSONB NOT NULL DEFAULT '[]',
  claims JSONB NOT NULL DEFAULT '[]',
  summary TEXT CHECK (char_length(summary) <= 4000),
  output_ids JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  run_token UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT,
  result JSONB,
  outcome TEXT CHECK (outcome IN ('pass', 'fail')),
  return_text TEXT,
  returned_at TIMESTAMPTZ,
  overruled_at TIMESTAMPTZ,
  overruled_by TEXT,
  overrule_reason TEXT CHECK (char_length(overrule_reason) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (task_id, client_id),
  UNIQUE (task_id, attempt)
);
CREATE INDEX card_handbacks_pending ON card_handbacks (status) WHERE status IN ('queued', 'running');

-- 攒着、等进下一版交付物的东西：一张验收通过的卡（handback_id），或调研专题的一版（topic_version_id），二选一。
-- 卡验收通过时自动加一行，推翻就删掉；专题的一版本人点「放进下一版」才加。version_id 为空就还在「准备中」。
CREATE TABLE deliverable_pending_items (
  id UUID PRIMARY KEY,
  plan_task_id TEXT NOT NULL,
  handback_id UUID UNIQUE REFERENCES card_handbacks (id) ON DELETE CASCADE,
  topic_version_id UUID UNIQUE REFERENCES topic_versions (id) ON DELETE CASCADE,
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  version_id UUID REFERENCES deliverable_versions (id),
  CHECK ((handback_id IS NULL) <> (topic_version_id IS NULL))
);
CREATE INDEX deliverable_pending_task ON deliverable_pending_items (plan_task_id, added_at) WHERE version_id IS NULL;
