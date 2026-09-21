-- 发布方级财经媒体（RSS/news-sitemap）Signal 需要独立 source_type；
-- 旧 CHECK 只允许 web / wechat-account，会让 outlet Signal 落库失败。
ALTER TABLE signals DROP CONSTRAINT signals_source_type_check;
ALTER TABLE signals ADD CONSTRAINT signals_source_type_check
  CHECK (source_type IN ('web', 'wechat-account', 'outlet'));
