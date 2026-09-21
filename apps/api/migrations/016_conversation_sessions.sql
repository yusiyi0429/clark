-- 会话化：scope 不再与 Conversation 一对一；同一 scope 允许多个会话行，
-- 最早的未删除会话即 legacy /messages 路由的默认会话（老数据原样成为默认会话）。
-- 附件元数据内嵌在 user 消息行（attachments jsonb），不建新业务表。
ALTER TABLE conversations DROP CONSTRAINT conversations_scope_key;
ALTER TABLE conversations ADD COLUMN title text;
ALTER TABLE conversations ADD COLUMN deleted_at timestamptz;
ALTER TABLE conversation_messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX conversations_scope_active_idx ON conversations (scope, created_at, id) WHERE deleted_at IS NULL;
