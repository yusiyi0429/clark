-- 会议决策确认（10/28 方案 B）：记录正文不用确认；会上提取的决策和行动项逐条由责任人确认（没有责任人的由主持人），主持人可以代确认。
-- decisions：MeetingCardDecision[]（text、ownerPersonId、basisSectionIds、review）；NULL 是 10/28 之前生成的会议卡（照旧由主持人整卡确认）。
-- write_to_world：冻结时写不写进本体，冻结前主持人或创建人在会议卡上改（原来在整卡确认时选）。
ALTER TABLE meeting_cards
  ADD COLUMN decisions JSONB CHECK (decisions IS NULL OR jsonb_typeof(decisions) = 'array'),
  ADD COLUMN write_to_world BOOLEAN NOT NULL DEFAULT TRUE;
