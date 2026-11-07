-- 新首页 13.2：飞书推送。
-- person_settings：本人的偏好（「我 › 偏好」）：飞书通知开关（没有行 = 开），和最近一次在网页上打开天枢的时间（判断「本人在不在天枢里」）。
CREATE TABLE person_settings (
  person_id TEXT PRIMARY KEY,
  feishu BOOLEAN NOT NULL DEFAULT TRUE,
  web_seen_at TIMESTAMPTZ
);

-- feishu_pushes：推过的「等你」条目（同一件不推第二次）；每人最近一次推的时间决定 10 分钟里合成一条。
CREATE TABLE feishu_pushes (
  person_id TEXT NOT NULL,
  key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (person_id, key)
);
CREATE INDEX feishu_pushes_person_sent ON feishu_pushes (person_id, sent_at DESC);
