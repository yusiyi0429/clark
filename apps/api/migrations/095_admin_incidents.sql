-- 管理员视图的操作留痕：给本人发提醒、标记已接手 / 已解决、重试，一次操作一行，只追加不改。
-- subject_type + subject_id 指向被处理的对象：collector / feishu / world 是人 × 来源的一格（subject_id 是 personId），
-- job 是 jobs.id，world_write 是本体写入（台账幂等键或 meeting-event:<id>），quality 是 agent_runs.id。
-- 某个对象当前是否「已接手」看它最近一次 acknowledge / resolve；失败列表里，解决时间晚于这次失败的就不再列出。
-- remind 经送达通道发出一条请求（request_id），本人在通知栏「请求」里收到。id 是客户端给的 clientId，重放不重复执行。
CREATE TABLE admin_incidents (
  id UUID PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('remind', 'acknowledge', 'resolve', 'retry')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('collector', 'feishu', 'world', 'job', 'world_write', 'quality')),
  subject_id TEXT NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  actor_id TEXT NOT NULL,
  request_id UUID REFERENCES requests (id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 用数据库时钟：连续两次操作也分得出先后，「最近一次标记」不会并列。
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (action = 'remind' OR request_id IS NULL)
);
CREATE INDEX admin_incidents_subject ON admin_incidents (subject_type, subject_id, created_at DESC);
