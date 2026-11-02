-- 首页对话走独立 Chat 时的转议题建议（11/02）：Chat 的 propose_issue 调 /internal/issue-drafts 写一条，挂在 Chat 的那段对话上。
-- chat_conversation_id 是 Chat 的会话 id，run_id 是提议那一轮的 Chat runId；天枢的 conversation_id 与 Chat 的二选一。
-- 相关那一段不在天枢库里：start/end_sequence 留空，接受时从 Chat 现读（到提议那一轮的回答为止，往前数 turns 轮提问）。
-- 只放宽和新增，已有数据都满足新约束。
ALTER TABLE issue_drafts ADD COLUMN chat_conversation_id UUID;
ALTER TABLE issue_drafts ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE issue_drafts ALTER COLUMN start_sequence DROP NOT NULL;
ALTER TABLE issue_drafts ALTER COLUMN end_sequence DROP NOT NULL;
ALTER TABLE issue_drafts ADD CONSTRAINT issue_drafts_one_conversation CHECK ((conversation_id IS NULL) <> (chat_conversation_id IS NULL));
ALTER TABLE issue_drafts ADD CONSTRAINT issue_drafts_native_segment CHECK (conversation_id IS NULL OR (start_sequence IS NOT NULL AND end_sequence IS NOT NULL));
-- Chat 的一轮最多一条建议（同一轮重复调用拿回原来那条）；读首页历史时按 runId 找卡。
CREATE UNIQUE INDEX issue_drafts_chat_run ON issue_drafts (chat_conversation_id, run_id) WHERE chat_conversation_id IS NOT NULL;
