-- 会话纪要（conversationDigests.ts）：一段对话一行。一段 = 两次发言间隔不到 12 小时、也没跨过北京时间凌晨 4 点的一串问答。
-- 215 已被 PR #56 的 215_wechat_bindings 占用，这里用 216。
-- source = chat：首页的一段 Chat 对话（source_ref = Chat 的 conversationId，from_position 恒为 0，viewer_role 是那段的视角）；
-- source = tianshu：天枢页面对话的一段（source_ref = conversations.id，from_position / to_position 是这一段第一条、最后一条消息的 sequence，viewer_role 为空）。
-- covered_to：纪要已覆盖到的位置（Chat 的 position 或天枢的 sequence），增量更新从它之后接着写。
-- status：ready 已覆盖到最新；stale 有新内容待写（还没写过时 digest 为空串）；hidden 原对话已隐藏，不进目录、查不到。
-- next_attempt_at：生成失败后下次再试的时间（不丢内容，只是晚一点）。
CREATE TABLE conversation_digests (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  viewer_role TEXT CHECK (viewer_role IN ('ceo', 'member')),
  source TEXT NOT NULL CHECK (source IN ('chat', 'tianshu')),
  source_ref TEXT NOT NULL,
  from_position BIGINT NOT NULL DEFAULT 0,
  to_position BIGINT NOT NULL DEFAULT 0,
  scope TEXT NOT NULL,
  scope_label TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  covered_to BIGINT NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 40),
  digest TEXT NOT NULL DEFAULT '' CHECK (char_length(digest) <= 1600),
  keywords TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'stale' CHECK (status IN ('ready', 'stale', 'hidden')),
  model TEXT,
  generated_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  CHECK ((source = 'chat') = (viewer_role IS NOT NULL)),
  UNIQUE (source, source_ref, from_position)
);
CREATE INDEX conversation_digests_owner ON conversation_digests (owner_id, ended_at DESC);
CREATE INDEX conversation_digests_due ON conversation_digests (ended_at) WHERE status = 'stale';
