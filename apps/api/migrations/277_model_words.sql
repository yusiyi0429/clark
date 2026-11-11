-- 对话里说的模型要求落到派活单上（第 69 条，契约 ModelWords）：本人原话里关于来源、模型、思考的那一截，原样。
-- 登记拆卡时记在登记上，规划员出派活单时拷到这次的每张草稿上；网页拿它去和这台电脑连着的来源对。
ALTER TABLE card_split_requests ADD COLUMN model_words TEXT CHECK (char_length(model_words) BETWEEN 1 AND 300);
ALTER TABLE card_drafts ADD COLUMN model_words TEXT CHECK (char_length(model_words) BETWEEN 1 AND 300);
