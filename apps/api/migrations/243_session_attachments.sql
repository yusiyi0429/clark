-- 新首页 14.5：子会话（卡、专题）的附件存在云端，本机按 id 取回存进 Task 的工作区。文件在 MEETING_MATERIAL_STORAGE_DIR 下 session-attachments/<owner>/<id>。
CREATE TABLE session_attachments (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  card_id UUID,
  topic_id UUID,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document', 'code')),
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK ((card_id IS NULL) <> (topic_id IS NULL))
);
CREATE INDEX session_attachments_owner ON session_attachments (owner_id, created_at DESC);
