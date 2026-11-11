-- 完成标准放宽（11/11 主会话定，契约 DONE_DEFINITION_LIMITS）：整份从 500 字放到 2000 字，每条 300 字由 api 写入时查。
-- 只有派活单草稿 card_drafts.done_definition 有长度约束；tasks.done_definition 本来没有。
ALTER TABLE card_drafts DROP CONSTRAINT card_drafts_done_definition_check;
ALTER TABLE card_drafts ADD CONSTRAINT card_drafts_done_definition_check CHECK (char_length(done_definition) BETWEEN 1 AND 2000);
