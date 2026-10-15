-- 新建对话：当前对话归档（不删除，能回看、能切回去继续）。
-- 主对话 = 这个人在这个页面最早一条未删除、未归档的会话；已有会话 archived_at 为空，行为不变。
-- 回答末尾那行「本轮因上游异常改由备用模型完成」之类的说明随消息存下（recovery_note：{ text, detail }）。
-- 只加可空列和索引，不回填、不改已有行，可在已有库上重复执行。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS recovery_note jsonb;
CREATE INDEX IF NOT EXISTS conversations_owner_scope_active_idx
  ON conversations (owner_id, scope, created_at, id)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
