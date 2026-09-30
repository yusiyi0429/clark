-- 本人看过的更新卡与产品演示，跨设备记住；person_id 来自人员 seed，不建数据库外键（同 person_onboarding）。
CREATE TABLE person_seen_marks (
  person_id TEXT NOT NULL,
  key TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (person_id, key)
);
