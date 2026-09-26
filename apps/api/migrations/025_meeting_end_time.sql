-- Meeting 计划结束时间与「这场会开完了」。
-- ends_at：计划结束时间，旧行按开始后 60 分钟回填。
-- ended_at：CEO 标记开完的时刻；不改 status（held 只表示已有确认的 Transcript，会后抽取依赖它）。
ALTER TABLE meetings
  ADD COLUMN ends_at TIMESTAMPTZ,
  ADD COLUMN ended_at TIMESTAMPTZ;
UPDATE meetings SET ends_at = scheduled_at + interval '60 minutes';
ALTER TABLE meetings ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE meetings ADD CONSTRAINT meetings_ends_after_start CHECK (ends_at > scheduled_at);
