-- 团队来件就是原请求和逐人成员行。未投递成功的目标只对发送人可见。
ALTER TABLE requests
  ADD COLUMN team_kind TEXT CHECK (team_kind IN ('share','question')),
  ADD COLUMN team_client_id UUID,
  ADD COLUMN team_fingerprint TEXT,
  ADD COLUMN team_source_url TEXT,
  ADD COLUMN team_due_at TIMESTAMPTZ,
  ADD CONSTRAINT team_request_identity CHECK (
    (team_kind IS NULL AND team_client_id IS NULL AND team_fingerprint IS NULL AND team_source_url IS NULL AND team_due_at IS NULL) OR
    (team_kind IS NOT NULL AND team_client_id IS NOT NULL AND team_fingerprint IS NOT NULL AND kind='relay' AND sent_at IS NOT NULL
      AND (team_due_at IS NULL OR team_kind='question'))),
  DROP CONSTRAINT requests_body_check,
  ADD CONSTRAINT requests_body_check CHECK (char_length(body) <= 20000 AND (body <> '' OR team_kind IS NOT DISTINCT FROM 'share'));
CREATE UNIQUE INDEX requests_team_operation ON requests(initiator_id, team_client_id) WHERE team_kind IS NOT NULL;
ALTER TABLE request_recipients ADD COLUMN team_delivery_error TEXT;

CREATE TABLE team_delivery_replies (
  id UUID PRIMARY KEY,
  seq BIGSERIAL NOT NULL,
  request_id UUID NOT NULL,
  recipient_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('answered','needs_info','clarification')),
  body TEXT NOT NULL CHECK (char_length(body) <= 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id, recipient_id) REFERENCES request_recipients(request_id, person_id) ON DELETE CASCADE,
  UNIQUE (request_id, author_id, client_id),
  UNIQUE (request_id, id)
);
CREATE INDEX team_reply_person_history ON team_delivery_replies(request_id, recipient_id, seq);

-- 原文件引用不阻止来源变更或删除；打开时以分享者当前原件读取权和指定 SHA-256 再核对。
-- 直接上传的文件名不参与寻址，内容保存在材料卷的 team-deliveries/<id>。
CREATE TABLE team_delivery_attachments (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  reply_id UUID,
  shared_by TEXT NOT NULL,
  source_attachment_id UUID,
  position INTEGER NOT NULL CHECK (position >= 0),
  file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 31457280),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (request_id, reply_id) REFERENCES team_delivery_replies(request_id, id) ON DELETE CASCADE
);
CREATE INDEX team_attachments_by_message ON team_delivery_attachments(request_id, reply_id, position);
