-- 战场参与者：签发后为这些人起草本月任务卡。NULL 表示 CEO 从未保存过，起草时按上月在本战场有 Mission 的人推算。
ALTER TABLE battlefield_config ADD COLUMN participant_ids JSONB
  CHECK (participant_ids IS NULL OR jsonb_typeof(participant_ids) = 'array');
