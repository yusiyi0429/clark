-- 001: 基础骨架。业务时间一律 UTC（timestamptz）。
-- schema_migrations 由 migration runner 自建，不在此定义。

-- Ticket 02 的 fixture 首页状态：单行。生产环境不通过 API seed 扩展它。
CREATE TABLE fixture_home (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  notice_dismissed BOOLEAN NOT NULL DEFAULT false,
  notice_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fixture_home (id, version) VALUES ('default', 1);
