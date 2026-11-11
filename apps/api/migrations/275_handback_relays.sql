-- 手机或别的电脑登记的「再改一轮」「我来补」（主循环第 61、62 条，契约 CardRelayView）：复用转话 session_commands，
-- 记上是哪次交回（handback_id）、哪一种（relay：return 再改一轮、supply 我来补）。那台电脑上的网页认领、送到、报 done 后回写交回。
ALTER TABLE session_commands
  ADD COLUMN handback_id UUID REFERENCES card_handbacks (id) ON DELETE CASCADE,
  ADD COLUMN relay TEXT CHECK (relay IN ('return', 'supply')),
  ADD CONSTRAINT session_commands_relay CHECK ((relay IS NULL) = (handback_id IS NULL));
CREATE INDEX session_commands_handback ON session_commands (handback_id) WHERE handback_id IS NOT NULL;

-- 「我来补」送到了的时间：送到以后卡不再是等你补。
ALTER TABLE card_handbacks ADD COLUMN supplied_at TIMESTAMPTZ;
