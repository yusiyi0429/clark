-- Ticket 06: minimal RadarConfig and Signal facts. No ScanRun or Issue promotion tables.
CREATE TABLE radar_config (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  timezone TEXT NOT NULL,
  lookback_hours INTEGER NOT NULL CHECK (lookback_hours > 0),
  anchors JSONB NOT NULL,
  sources JSONB NOT NULL,
  scheduled_company_day DATE,
  last_scheduled_at TIMESTAMPTZ,
  last_run JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO radar_config (id, version, timezone, lookback_hours, anchors, sources)
VALUES ('default', 1, 'Asia/Shanghai', 48, '[]'::jsonb, '{"sites":[],"wechatAccounts":[]}'::jsonb);

CREATE TABLE signals (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('web', 'wechat-account')),
  source_fingerprint TEXT NOT NULL UNIQUE,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  excerpt TEXT NOT NULL,
  source_ref JSONB NOT NULL,
  anchor_id TEXT NOT NULL,
  location JSONB NOT NULL,
  summary TEXT NOT NULL,
  strategic_impact TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  unknowns JSONB NOT NULL,
  score JSONB NOT NULL,
  read_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
