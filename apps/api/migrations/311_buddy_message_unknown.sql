-- 伙伴转达：飞书出错或超时的收件人可能已经收到，和没关联飞书的分开记。
ALTER TABLE buddy_messages ADD COLUMN unknown_ids TEXT[] NOT NULL DEFAULT '{}';
