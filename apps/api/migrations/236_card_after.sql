-- 卡的先后（11/07 端到端真跑后定）：规划员在派活单里写一件要等前面哪几件（after，派活单里的位置），
-- 存成同一次派活单里那几张草稿的 id；放进看板变成卡以后，换成那几张卡的 id，开工时网页照它告诉本机程序先等着。
-- 本机报 queued 带 waitingFor（还没合回的前面那几张卡），worker 列表据它写「已排队 · 等前面的卡」。没写先后的照旧，都是空的。
ALTER TABLE card_drafts ADD COLUMN after_draft_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN after_card_ids UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE local_runs ADD COLUMN waiting_for TEXT[];
