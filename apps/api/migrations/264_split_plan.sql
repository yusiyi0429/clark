-- 17.2 第 29 条：拆卡登记被本机规划员的哪份派活单用过（派活单照它记 afterSequence）。
-- 用过的不再给后来直接开（不经过登记）的规划员，那种用建派活单那一下项目对话的最后一条。
ALTER TABLE card_split_requests ADD COLUMN plan_id UUID;
