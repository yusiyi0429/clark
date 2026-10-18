-- 本机采集器上报到天枢：个人令牌新增 client=collector；健康（人 × 设备 × 来源）、上报的工作段、本机清单三张表。
ALTER TABLE personal_tokens DROP CONSTRAINT personal_tokens_client_check;
ALTER TABLE personal_tokens ADD CONSTRAINT personal_tokens_client_check CHECK (client IN ('codex', 'claude', 'other', 'collector'));

CREATE TABLE collector_health (
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  source TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  coverage_until TIMESTAMPTZ,
  last_new_evidence_at TIMESTAMPTZ,
  source_status TEXT NOT NULL CHECK (source_status IN ('ok', 'not_found', 'error')),
  error_code TEXT,
  -- 服务端探测写：工作日超过 26 小时没有成功同步记 yellow，超过 50 小时记 red。
  health TEXT NOT NULL DEFAULT 'green' CHECK (health IN ('green', 'yellow', 'red')),
  health_checked_at TIMESTAMPTZ,
  PRIMARY KEY (person_id, device_id, source)
);

CREATE TABLE collector_items (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  token_id UUID NOT NULL REFERENCES personal_tokens (id),
  report_kind TEXT NOT NULL CHECK (report_kind IN ('digest', 'eod', 'catchup')),
  client_event_id UUID NOT NULL,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL CHECK (ended_at >= started_at),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  links JSONB NOT NULL DEFAULT '[]',
  task_hint TEXT,
  received_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX collector_items_client_event ON collector_items (person_id, client_event_id);
CREATE INDEX collector_items_person_time ON collector_items (person_id, started_at DESC);

CREATE TABLE local_inventory (
  person_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled_task', 'feishu_doc')),
  item_key TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (person_id, device_id, kind, item_key)
);
