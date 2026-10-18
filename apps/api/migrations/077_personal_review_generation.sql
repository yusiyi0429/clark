-- 个人复盘生成：最近一次生成的步骤（读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草），每步 {id,label,status,result?}；
-- 本人（或本人的 AI 工具）保存过的段落，重新生成时保留不覆盖。
ALTER TABLE personal_reviews ADD COLUMN generation_steps JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(generation_steps) = 'array');
ALTER TABLE personal_reviews ADD COLUMN edited_fields JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(edited_fields) = 'array');
