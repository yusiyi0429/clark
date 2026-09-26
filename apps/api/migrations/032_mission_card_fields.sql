-- 本月个人卡的 13 字段；placeholder 记录来源性质，不代表已经确认。
ALTER TABLE missions
  ADD COLUMN key_path TEXT NOT NULL DEFAULT '',
  ADD COLUMN resources TEXT NOT NULL DEFAULT '',
  ADD COLUMN human_agent_split TEXT NOT NULL DEFAULT '',
  ADD COLUMN retrospect TEXT NOT NULL DEFAULT '',
  ADD COLUMN placeholder BOOLEAN NOT NULL DEFAULT false;
