-- 自由子会话（第 68 条，项目下的「+」）：专题带 free，不加新的会话种类。first_message 是本人说的第一句话，开工交代就是它。
ALTER TABLE research_topics
  ADD COLUMN free BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN first_message TEXT CHECK (char_length(first_message) <= 20000);

-- 排着队、在等普通文件夹空出来时，本机报的占着它的那个会话（契约 LocalFolderHolder：kind、id、title）；不在等为 NULL。
ALTER TABLE local_runs ADD COLUMN held_by JSONB;
