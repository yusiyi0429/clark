-- 使用周报（usage.ts）：能从现有表推导的都现算（对话运行、会议卡、个人记忆、上手完成、失败与质量信号），这里只存推导不了的几类，以及每周生成的周报快照。
-- usage_events：一次一行，只有 personId、种类、时间，不存正文和凭证。
--   active 某人这一天用过天枢（登录后发问或改动，GET 不算，一人一天一行）；login 登录成功；memory_edit 本人在界面上原地改了一条个人记忆；
--   memory_purge 本人彻底删除了一条个人记忆（行已经没了，推导不出来）；onboarding_step 上手走到了哪一步（detail 是步骤名，一人一步一天一行）。
--   day 是北京时间的日期。
CREATE TABLE usage_events (
  id BIGSERIAL PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active', 'login', 'memory_edit', 'memory_purge', 'onboarding_step')),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) BETWEEN 1 AND 40),
  day DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'onboarding_step') = (detail IS NOT NULL))
);
CREATE UNIQUE INDEX usage_events_once_a_day ON usage_events (person_id, kind, day, COALESCE(detail, '')) WHERE kind IN ('active', 'onboarding_step');
CREATE INDEX usage_events_day ON usage_events (day, kind);

-- 每周一早上生成上一周（周一到周日，北京时间）的周报；一周一行，生成后不改。report 是 UsageWeekReport。
CREATE TABLE usage_weekly_reports (
  week_start DATE PRIMARY KEY,
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
