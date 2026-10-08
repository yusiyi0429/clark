-- 正式 Mission Card 规范：时间边界与取舍独立保存；既有真实内容保留，缺项保持空白。
ALTER TABLE missions
  ADD COLUMN time_boundary TEXT NOT NULL DEFAULT '',
  ADD COLUMN tradeoffs TEXT NOT NULL DEFAULT '';

ALTER TABLE mission_card_feedback DROP CONSTRAINT mission_card_feedback_field_check;
ALTER TABLE mission_card_feedback ADD CONSTRAINT mission_card_feedback_field_check CHECK (field IS NULL OR field IN (
  'title','why','outcome','timeBoundary','tradeoffs','successEvidence','boundaries','keyPath',
  'milestones','resources','dependencies','humanAgentSplit','risk','retrospect'
));
ALTER TABLE mission_card_corrections DROP CONSTRAINT mission_card_corrections_field_check;
ALTER TABLE mission_card_corrections ADD CONSTRAINT mission_card_corrections_field_check CHECK (field IN (
  'title','why','outcome','timeBoundary','tradeoffs','successEvidence','boundaries','keyPath',
  'milestones','resources','dependencies','humanAgentSplit','risk','retrospect'
));
ALTER TABLE mission_card_annotations DROP CONSTRAINT mission_card_annotations_field_check;
ALTER TABLE mission_card_annotations ADD CONSTRAINT mission_card_annotations_field_check CHECK (field IN (
  'title','why','outcome','timeBoundary','tradeoffs','successEvidence','boundaries','keyPath',
  'milestones','resources','dependencies','humanAgentSplit','risk','retrospect'
));
