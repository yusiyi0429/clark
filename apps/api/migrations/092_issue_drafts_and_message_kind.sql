-- 一号位深聊转议题（已定设计第 2 节）与对话留痕。只新增列和表，可在已有库上执行。

-- 对话消息的种类：message 普通问答；carried 转议题时从首页带进议题页的一段（meta.carriedFrom 指回原消息）；
-- trace 首页留痕行「已转到议题 X」（meta 里有 issueId、title、href，点击直达）。carried、trace 不进后台提炼与历史检索。
ALTER TABLE conversation_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'carried', 'trace'));
ALTER TABLE conversation_messages ADD COLUMN meta JSONB CHECK (meta IS NULL OR jsonb_typeof(meta) = 'object');

-- 转议题建议：首页对话里 propose_issue 写一条。draft 是初稿 {title, whyNow, formedIdeas, options[{label, tradeoff}], openQuestions}；
-- start_sequence..end_sequence 是首页对话里相关的那一段（接受时复制进议题页对话）；matched_issue_id 是能对上的已有议题；
-- suggested_location 是 Agent 建议挂的位置（battlefield / company）。接受后 issue_id 是转到的议题，mode 是新建还是接到已有议题。
CREATE TABLE issue_drafts (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  run_id UUID NOT NULL,
  topic TEXT NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 60),
  start_sequence INTEGER NOT NULL CHECK (start_sequence > 0),
  end_sequence INTEGER NOT NULL,
  turns INTEGER NOT NULL CHECK (turns > 0),
  draft JSONB NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  suggested_location JSONB CHECK (suggested_location IS NULL OR jsonb_typeof(suggested_location) = 'object'),
  matched_issue_id UUID REFERENCES issues (id),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'declined')),
  issue_id UUID REFERENCES issues (id),
  mode TEXT CHECK (mode IN ('new', 'existing')),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (end_sequence >= start_sequence),
  CHECK ((status = 'accepted') = (issue_id IS NOT NULL AND mode IS NOT NULL)),
  CHECK ((status = 'proposed') = (decided_at IS NULL))
);
CREATE INDEX issue_drafts_owner ON issue_drafts (owner_id, created_at DESC);

-- 本人拒绝过的话题：同一话题不再建议转议题。
CREATE TABLE issue_suggestion_declines (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  draft_id UUID REFERENCES issue_drafts (id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_id, topic)
);
