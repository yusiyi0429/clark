-- 本人准备与战场组合 Review 分开：备注不暗中触发改写，已确认原文保持稳定。
ALTER TABLE mission_card_annotations ADD COLUMN intent TEXT NOT NULL DEFAULT 'note' CHECK (intent IN ('note','edit'));
-- 旧的已请求改写记录保留其真实语义；不重排队或重写任何既有正文。
UPDATE mission_card_annotations SET intent='edit' WHERE status <> 'saved';
ALTER TABLE mission_card_annotations ADD COLUMN initial_intent TEXT NOT NULL DEFAULT 'note' CHECK (initial_intent IN ('note','edit'));
UPDATE mission_card_annotations SET initial_intent=intent;
ALTER TABLE personal_mission_cards ADD COLUMN return_reason TEXT;
ALTER TABLE mission_round_reviews ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'queued'
  CHECK (agent_status IN ('queued','running','completed','failed'));
ALTER TABLE mission_round_reviews ADD COLUMN agent_input JSONB;
ALTER TABLE mission_round_reviews ADD COLUMN agent_report JSONB;
ALTER TABLE mission_round_reviews ADD COLUMN agent_error TEXT;
ALTER TABLE mission_round_reviews ADD COLUMN agent_started_at TIMESTAMPTZ;
ALTER TABLE mission_round_reviews ADD COLUMN agent_completed_at TIMESTAMPTZ;
ALTER TABLE mission_round_reviews ADD COLUMN agent_run_id UUID;
-- 已最终确认的历史数据不会在升级时重新进入自动审阅。
UPDATE mission_round_reviews v SET agent_status='completed'
  FROM mission_rounds r WHERE r.id=v.round_id AND r.status='confirmed';
