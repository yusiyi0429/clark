-- 本人完成审核独立于整轮确认；复用 mission_card_revisions 留痕，不新建修改历史表。
ALTER TABLE personal_mission_cards ADD COLUMN owner_confirmed_at TIMESTAMPTZ;
