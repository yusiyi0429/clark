-- 发起人的追问；被问的人看过、更正伙伴的答复；发起人知道了更正（计划 T5，补充条款 A9）。
-- reviewed_at：伙伴的答复，被问的人点了「没问题」或「改一下」的时间。corrects：这条是被问的人的更正，更正的是哪条伙伴答复（原话保留）。
-- correction_seen_at：更正，发起人点了「知道了」的时间；没点的进发起人的等你。
ALTER TABLE team_delivery_replies
  DROP CONSTRAINT team_delivery_replies_status_check,
  ADD CONSTRAINT team_delivery_replies_status_check CHECK (status IN ('answered', 'needs_info', 'clarification', 'follow_up')),
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN corrects UUID,
  ADD COLUMN correction_seen_at TIMESTAMPTZ,
  ADD CONSTRAINT team_reply_corrects FOREIGN KEY (request_id, corrects) REFERENCES team_delivery_replies (request_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT team_reply_review_shape CHECK ((reviewed_at IS NULL OR origin = 'buddy') AND (correction_seen_at IS NULL OR corrects IS NOT NULL));
-- 转本人是问的人点「问本人」转的（true），还是伙伴判的（false）。只在 handoff 时可能为 true。
ALTER TABLE request_recipients
  ADD COLUMN buddy_asked_owner BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT request_recipients_buddy_asked_owner CHECK (NOT buddy_asked_owner OR buddy_state = 'handoff');
