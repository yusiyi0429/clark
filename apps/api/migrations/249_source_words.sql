-- 新首页 16.8：派活单带上本人原话。登记拆卡存这次依据的本人原话（最多最近 5 条），派活单草稿和卡存核对过的原文片段或整条原话。
ALTER TABLE card_split_requests ADD COLUMN source_words JSONB NOT NULL DEFAULT '[]';
ALTER TABLE card_drafts ADD COLUMN source_words JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN source_words JSONB NOT NULL DEFAULT '[]';
