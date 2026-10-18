-- 会议链路（G）：妙记自动获取与实际参会名单。只给 meetings 加列，不改已有列。
-- minutes_status：none（会还没开完）→ waiting（开完了，等飞书妙记生成；有人问就答「还在生成」）
--   → ready（已拿到逐字稿或候选，任何来源都算）；拿不到时（飞书没接、主持人没授权、等了 24 小时还没有）为 manual，退回手动上传。
-- feishu_meeting_id / minute_token：对上的飞书会议和妙记；同一份妙记只对一场会。
-- attendees_actual：飞书实际参会名单换算成的天枢 personId 数组（中途加入的也算）；拿不到时为 NULL，退回手填的参会人。
-- decisions_run_id：会后分层（meeting_decisions）是按哪一次纪要整理（outcome.runId）挑出来的；挑出 0 条也记，免得反复调模型。
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS decisions_run_id TEXT,
  ADD COLUMN IF NOT EXISTS feishu_meeting_id TEXT,
  ADD COLUMN IF NOT EXISTS minute_token TEXT,
  ADD COLUMN IF NOT EXISTS minutes_status TEXT NOT NULL DEFAULT 'none' CHECK (minutes_status IN ('none', 'waiting', 'manual', 'ready')),
  ADD COLUMN IF NOT EXISTS minutes_waiting_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS minutes_error TEXT,
  ADD COLUMN IF NOT EXISTS attendees_actual JSONB CHECK (attendees_actual IS NULL OR jsonb_typeof(attendees_actual) = 'array');

CREATE UNIQUE INDEX IF NOT EXISTS meetings_minute_token_key ON meetings (minute_token) WHERE minute_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS meetings_minutes_waiting_idx ON meetings (minutes_waiting_since) WHERE minutes_status = 'waiting';
