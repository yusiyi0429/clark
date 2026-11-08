-- 18.10 照本机的同步条目 stopped（LocalStopReport）记报告：why 换掉 outcome，加卡在哪（blocker）和这一轮的产出物（outputs：artifact 条目的 key、标题、文件名）。
ALTER TABLE sub_session_reports DROP COLUMN outcome;
ALTER TABLE sub_session_reports ADD COLUMN why TEXT NOT NULL DEFAULT 'turn_done'
  CHECK (why IN ('turn_done', 'interrupted', 'held', 'error', 'killed'));
ALTER TABLE sub_session_reports ALTER COLUMN why DROP DEFAULT;
ALTER TABLE sub_session_reports ADD COLUMN blocker TEXT;
ALTER TABLE sub_session_reports ADD COLUMN outputs JSONB NOT NULL DEFAULT '[]'::jsonb;
