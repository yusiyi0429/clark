-- 项目对话在本人电脑上跑（设计稿 17.2 第 38 条，契约 projectLocalTurns.ts）。
-- 项目钥匙：本机项目会话挂天枢 MCP 用，只对这个人、这个项目、这台电脑有效（personal_tokens.client = local_project）。
ALTER TABLE personal_tokens DROP CONSTRAINT personal_tokens_client_check;
ALTER TABLE personal_tokens ADD CONSTRAINT personal_tokens_client_check CHECK (client IN ('codex', 'claude', 'other', 'collector', 'local', 'local_project'));
CREATE TABLE local_project_keys (
  token_id UUID PRIMARY KEY REFERENCES personal_tokens (id),
  owner_id TEXT NOT NULL,
  device_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX local_project_keys_device ON local_project_keys (owner_id, device_id, project_id);

-- 本机跑的一轮：开始时占住这个项目对话（同一时间只一轮 running），结束后写进 Chat（recorded_at）。id 就是 Chat 里那一轮的 id。
-- expired：超过租期没心跳，放开了；released：本机没跑成，不写进 Chat。
CREATE TABLE project_local_turns (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  client_turn_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message TEXT NOT NULL,
  agent TEXT NOT NULL,
  model_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed', 'released', 'expired')),
  answer TEXT,
  error_code TEXT,
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ,
  UNIQUE (owner_id, client_turn_id)
);
CREATE UNIQUE INDEX project_local_turns_one_running ON project_local_turns (project_id) WHERE status = 'running';

-- 云端那一轮本该在本机跑、没跑成改在云端（ConversationMessageRequest.fallback）：记在这一轮的模型那一行上。
ALTER TABLE chat_turn_models ADD COLUMN fallback TEXT CHECK (fallback IN ('local_unavailable', 'local_quota'));
ALTER TABLE chat_turn_models ALTER COLUMN provider DROP NOT NULL, ALTER COLUMN model DROP NOT NULL;
