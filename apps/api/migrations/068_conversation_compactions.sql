-- 对话历史的后台压缩快照（conversationCompaction.ts）：一轮答完后在后台写摘要，下一轮开始时换进模型历史，一号位不等。
-- 每份快照记「覆盖到哪一条」：first_kept_entry_id（从这一条起原样保留）、covered_entry_id（折进摘要的最后一条）、
-- leaf_entry_id（做快照时的最后一条）、covered_turns / kept_turns；base_compaction_id 是它建立在哪一条压缩记录之上（滚动增量）。
-- 状态：running（在做，带租约）→ ready（就绪，等下一轮换入）→ applied（已换进 runtime_entries）；
-- 失败 failed（含租约过期）；换入前已过期或被更新的快照取代 superseded。
-- 只新增表与索引，不改已有表，可在已有库上重复执行。
CREATE TABLE IF NOT EXISTS conversation_compactions (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  pi_session_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'ready', 'applied', 'failed', 'superseded')),
  trigger_kind text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  base_compaction_id text,
  first_kept_entry_id text NOT NULL,
  covered_entry_id text NOT NULL,
  leaf_entry_id text NOT NULL,
  covered_entries integer NOT NULL,
  covered_turns integer NOT NULL,
  kept_turns integer NOT NULL,
  tokens_before integer NOT NULL,
  tokens_source text NOT NULL,
  history_tokens_folded integer NOT NULL,
  history_tokens_kept integer NOT NULL,
  history_tokens_after integer,
  summary text,
  summary_tokens integer,
  model text,
  usage jsonb,
  error text,
  duration_ms integer,
  lease_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  applied_at timestamptz
);

-- 同一条会话同一时刻只做一份（多个进程也一样）。
CREATE UNIQUE INDEX IF NOT EXISTS conversation_compactions_running_idx
  ON conversation_compactions (conversation_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS conversation_compactions_conversation_idx
  ON conversation_compactions (conversation_id, started_at DESC);
