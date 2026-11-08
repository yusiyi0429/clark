-- 设计 18 节第 9 条：伙伴的选项框（动作 ask_user）。一个框一行，跟着出它的那一轮（run_id）画在对话记录里（ConversationCard 的 buddy_question）。
-- scope 是哪个对话：global 伙伴台，project:<projectId> 项目对话。本人在这个对话里发出任何一条新消息，还 open 的标 dismissed；带 buddyQuestionId 回答的那张标 answered。
CREATE TABLE buddy_questions (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT NOT NULL,
  questions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);
CREATE INDEX buddy_questions_open ON buddy_questions (owner_id, scope) WHERE status = 'open';
CREATE INDEX buddy_questions_run ON buddy_questions (owner_id, run_id);
