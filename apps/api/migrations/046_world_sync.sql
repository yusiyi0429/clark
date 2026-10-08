-- instance = API URL + scope_id；实例重建后的请求、缓存和回执不会复用旧实例的数据。
CREATE TABLE world_sync_ledger (
  id BIGSERIAL PRIMARY KEY,
  instance TEXT NOT NULL,
  action_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  target_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed', 'network_error')),
  receipt_id TEXT,
  error_code TEXT,
  request_digest TEXT NOT NULL,
  request_body JSONB NOT NULL,
  prepared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX world_sync_ledger_key ON world_sync_ledger (instance, idempotency_key, id DESC);

-- 会后确认的快照先落库；网络失败重放同一版本，之后的更正等待原回执。
CREATE TABLE world_meeting_events (
  id BIGSERIAL PRIMARY KEY,
  instance TEXT NOT NULL,
  meeting_id UUID NOT NULL REFERENCES meetings(id),
  meeting_version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'failed')),
  event_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance, meeting_id, meeting_version)
);
