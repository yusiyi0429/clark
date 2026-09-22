-- Ticket 27: 妙记 Markdown Transcript 候选。
-- 候选是 Meeting 内嵌 Candidate Material（不是新实体），确认前不改 status、不跑 Outcome。
-- 旧行免迁移：NULL 表示没有候选。
ALTER TABLE meetings ADD COLUMN transcript_candidate JSONB;
