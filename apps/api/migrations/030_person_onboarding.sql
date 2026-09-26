-- 首次登录引导：完成和主动跳过都记一次；person_id 来自人员 seed，不建数据库外键。
CREATE TABLE person_onboarding (
  person_id TEXT PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL
);
