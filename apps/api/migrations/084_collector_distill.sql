-- 采集器服务端整理（D-02）。
-- collector_items.summary 是本机脱敏、裁剪后上传的原文片段：只有本人能看，收到 14 天后清空（raw_purged_at），
-- 行本身留下作出处（时间、来源、仓库名、链接）。distill_status：pending 等整理，done 已整理成进展。
ALTER TABLE collector_items ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE collector_items ADD COLUMN raw_purged_at TIMESTAMPTZ;
ALTER TABLE collector_items ADD CONSTRAINT collector_items_raw_purged CHECK ((summary IS NULL) = (raw_purged_at IS NOT NULL));
ALTER TABLE collector_items ADD COLUMN distill_status TEXT NOT NULL DEFAULT 'pending' CHECK (distill_status IN ('pending', 'done'));
ALTER TABLE collector_items ADD COLUMN distill_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collector_items ADD COLUMN distill_error TEXT;
CREATE INDEX collector_items_distill_pending ON collector_items (person_id, received_at) WHERE distill_status = 'pending' AND summary IS NOT NULL;

-- 整理结果：统一模型结合本人的 Mission、Task，把原文整理成一条条进展。
-- placement：task 已归到 Task（置信度 ≥ 0.75，同时写进这件执行事项的进展 task_progress_id）；
-- pending_attach 待挂靠（0.5–0.75，task_id 是候选）；pending_replan 待改计划（< 0.5 或没有对得上的 Task）。
-- item_ids 是出处（collector_items.id），原文清空后照样能追到时间、来源和仓库。
CREATE TABLE collector_progress (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  source TEXT NOT NULL,
  repo TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL CHECK (ended_at >= started_at),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  placement TEXT NOT NULL CHECK (placement IN ('task', 'pending_attach', 'pending_replan')),
  confidence NUMERIC(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  task_id UUID REFERENCES tasks (id) ON DELETE SET NULL,
  mission_id TEXT REFERENCES missions (id) ON DELETE SET NULL,
  item_ids UUID[] NOT NULL CHECK (cardinality(item_ids) > 0),
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  task_progress_id UUID REFERENCES task_progress (id) ON DELETE SET NULL,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX collector_progress_person_time ON collector_progress (person_id, started_at DESC);

-- 上手时本人同意采集：没同意的人，上报的工作段一律不收（心跳照收，只有设备和来源状态）。撤回同意时清空这个人的全部原文，整理结果保留。
CREATE TABLE collector_consents (
  person_id TEXT PRIMARY KEY,
  granted BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
