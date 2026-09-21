-- Signal 原文配图（CEO 2026-09-21 裁决：原文折叠展示并把图片抓过来）
-- after = 图片跟在第几段（0 起）之后；空数组表示无图或旧数据
ALTER TABLE signals ADD COLUMN source_images JSONB NOT NULL DEFAULT '[]'::jsonb;
