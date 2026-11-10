-- V2 本机程序在云端的那一侧（localDevices.ts、localSync.ts）：本机只单向上报，云端从不指挥本机。
-- 和 10/29 下线的本机采集器不是一回事：本机程序只跑本人点了「开始」的卡和专题，只报这次执行的结果。

-- 设备令牌：个人令牌加一种 local 客户端，只能调 /api/local-runner/* 和只读的 /mcp/me；不占每人 5 把的名额，不在设置页列。
ALTER TABLE personal_tokens DROP CONSTRAINT personal_tokens_client_check;
ALTER TABLE personal_tokens ADD CONSTRAINT personal_tokens_client_check CHECK (client IN ('codex', 'claude', 'other', 'collector', 'local'));

-- 本人的一台电脑：id 是本机程序自己的 deviceId，按 (owner_id, id) 一人一行；同一台电脑再配对换令牌（token_id 指向新的那把）。
-- app_version 是同步时报的本机程序版本。吊销时 revoked_at 有值、令牌一起吊销。
CREATE TABLE local_devices (
  owner_id TEXT NOT NULL,
  id UUID NOT NULL,
  token_id UUID NOT NULL REFERENCES personal_tokens (id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  os TEXT NOT NULL CHECK (os IN ('win32', 'darwin', 'linux')),
  app_version TEXT,
  last_sync_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id)
);
CREATE UNIQUE INDEX local_devices_token ON local_devices (token_id);

-- 一次本机执行（一个本机会话，id 是本机的 sessionId）的摘要，本机是唯一写入方。kind=card 挂执行事项，kind=topic 挂专题。
-- state 照本机的会话状态；state_seq、plan_seq 是写入它们的那一条的本机序号，序号更小的晚到了直接丢掉。
-- plan：计划条目整份替换；timeline：里程碑（状态变化、交出产出、交回），最多 50 条；last_activity：最近一条动静 {at, text}。
-- tokens：累计用量 {input, output, cacheRead, cacheWrite}；cost_usd：本机给的估价累计，一次都没给过为空。
-- running_at：第一次报 running 的时间，和 started_at 一起算开工耗时。
CREATE TABLE local_runs (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  task_id UUID REFERENCES tasks (id) ON DELETE CASCADE,
  topic_id UUID REFERENCES research_topics (id) ON DELETE CASCADE,
  executor TEXT NOT NULL DEFAULT 'claude_code',
  title TEXT,
  model_label TEXT,
  state TEXT NOT NULL DEFAULT 'starting' CHECK (state IN ('starting', 'running', 'waiting_permission', 'idle', 'exited', 'failed')),
  state_seq BIGINT NOT NULL DEFAULT 0,
  plan JSONB NOT NULL DEFAULT '[]',
  plan_seq BIGINT NOT NULL DEFAULT 0,
  last_activity JSONB,
  timeline JSONB NOT NULL DEFAULT '[]',
  tokens JSONB NOT NULL DEFAULT '{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}',
  cost_usd NUMERIC,
  started_at TIMESTAMPTZ NOT NULL,
  running_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  last_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'card') = (task_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL))
);
CREATE INDEX local_runs_task ON local_runs (task_id, started_at DESC) WHERE task_id IS NOT NULL;
CREATE INDEX local_runs_topic ON local_runs (topic_id, started_at DESC) WHERE topic_id IS NOT NULL;
CREATE INDEX local_runs_owner ON local_runs (owner_id, started_at DESC);

-- 本机传上来的东西：artifact 是执行方点名交出的文件（存在材料卷的 local-outputs/ 下，extracted_text 给验收和评审读），
-- evidence 是证据（说明、日志片段、链接、改动摘要，只有文字和链接）。同名再交一份就是新的一行。client_id 是同步条目的幂等键。
CREATE TABLE local_outputs (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES local_runs (id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks (id) ON DELETE CASCADE,
  topic_id UUID REFERENCES research_topics (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('artifact', 'evidence')),
  evidence_kind TEXT CHECK (evidence_kind IN ('note', 'log', 'link', 'diff_summary')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  file_name TEXT,
  mime TEXT,
  size_bytes INTEGER CHECK (size_bytes >= 0),
  sha256 TEXT,
  storage_key TEXT,
  url TEXT,
  text TEXT CHECK (char_length(text) <= 8000),
  extracted_text TEXT,
  client_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK ((kind = 'artifact') = (storage_key IS NOT NULL)),
  CHECK ((kind = 'evidence') = (evidence_kind IS NOT NULL))
);
CREATE INDEX local_outputs_run ON local_outputs (run_id, created_at);
CREATE INDEX local_outputs_task ON local_outputs (task_id, created_at DESC) WHERE task_id IS NOT NULL;

-- 收过的同步条目（幂等键 <deviceId>:<sessionId>:<序号>）：重复的直接回 accepted，不再生效一次。
CREATE TABLE local_sync_items (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
