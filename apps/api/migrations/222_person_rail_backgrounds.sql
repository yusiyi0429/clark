-- 本人给左边通知栏选的背景：几张预设之一，或本人上传的一张图（网页先缩小、转成 JPEG 再传），跟着人走。
-- 预设清单只在契约里校验，加预设不用改表；换回预设时上传过的图留着，再选「我的图」不用重传。
CREATE TABLE person_rail_backgrounds (
  person_id TEXT PRIMARY KEY,
  choice TEXT NOT NULL,
  image BYTEA,
  image_type TEXT,
  image_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
