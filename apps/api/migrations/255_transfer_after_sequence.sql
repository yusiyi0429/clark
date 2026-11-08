-- 设计 16.7：转交卡排在项目对话哪条消息后面。项目对话的消息从 Chat 读回来不带时间，按时间排不了位；
-- 发起「准备交接」时记下这个项目对话当时最后一条消息的 sequence（网页传上来，没传云端自己读；读不到为空）。
ALTER TABLE project_transfers ADD COLUMN after_sequence INTEGER;
