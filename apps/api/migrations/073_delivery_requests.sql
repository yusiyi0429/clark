-- 送达通道（⑨ 传话，以后 ③ 信息收集、影响卡、补充请求共用）：发起人一句话 → Agent 起草 → 发起人预览后发出，
-- 接收人在天枢里收到待办卡，卡上问答，完成由人标记。person_id 一类列对应 company-people seed，不建外键。
-- version 只跟着标题和说明变：发出时校验，保证发出去的就是预览时那一版；答案补进说明时加一。
CREATE TABLE requests (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('relay', 'collection', 'impact', 'supplement')),
  initiator_id TEXT NOT NULL,
  -- 发起人的原话；重新起草时可改。
  prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  -- 发出前 Agent 问发起人的歧义问题：[{question, answer|null}]。
  clarifications JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Agent 建议的接收人 personId；发出时由发起人确定最终名单。
  candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'done')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CHECK ((status = 'draft') = (sent_at IS NULL))
);
CREATE INDEX requests_initiator_idx ON requests (initiator_id, created_at DESC);

CREATE TABLE request_recipients (
  request_id UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  done_by TEXT,
  done_at TIMESTAMPTZ,
  PRIMARY KEY (request_id, person_id),
  CHECK ((status = 'done') = (done_by IS NOT NULL AND done_at IS NOT NULL))
);
CREATE INDEX request_recipients_person_idx ON request_recipients (person_id);

-- 卡上问答：一问一答成对，带答案草稿和「已补进说明」，不复用 thread_messages（那是没有配对的群聊流）。
CREATE TABLE request_questions (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  asker_id TEXT NOT NULL,
  question TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  answer TEXT CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 2000),
  answer_draft TEXT CHECK (answer_draft IS NULL OR char_length(answer_draft) BETWEEN 1 AND 2000),
  answered_at TIMESTAMPTZ,
  merged_into_body BOOLEAN NOT NULL DEFAULT FALSE,
  -- request.ask 的幂等键：同一次提问重放不再插一条。
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX request_questions_request_idx ON request_questions (request_id, created_at);

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done'));
ALTER TABLE notifications DROP CONSTRAINT notifications_object_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_object_type_check
  CHECK (object_type IN ('task', 'meeting', 'issue', 'request'));
