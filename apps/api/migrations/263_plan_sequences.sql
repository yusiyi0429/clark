-- 17.2 第 29 条：拆卡那几块按序号插进项目对话（Chat 读回的消息不带时间，同 project_transfers.after_sequence）。
-- 登记拆卡、派活单记开拆那一下本人看到的最后一条；派活单另记开工（放进看板）那一下的。
ALTER TABLE card_split_requests ADD COLUMN after_sequence INTEGER;
ALTER TABLE card_plans ADD COLUMN after_sequence INTEGER;
ALTER TABLE card_plans ADD COLUMN started_after_sequence INTEGER;
