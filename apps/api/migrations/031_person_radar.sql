-- 个人雷达（ADR-0021）。person_id 对应 company-people seed，不建外键（同 029）。
-- 个人信号单独存表：结构上进不了公司信号的升级事务，也没有升级相关的列。
CREATE TABLE person_radar (
  person_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  directions JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 规范化后的方向原文，字符串数组
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,     -- 规范化后的来源值，如 ["ft.com","36kr.com"]；读法按当前目录现算
  updated_at TIMESTAMPTZ,                         -- 只在本人保存设置时写；从没保存过为 NULL
  last_scan_day DATE,                             -- 最近一次开始扫描的 Company Day（任何触发）
  last_manual_scan_at TIMESTAMPTZ,                -- 手动扫描 10 分钟冷却
  last_run JSONB,                                 -- {trigger,status,queuedAt?,startedAt?,completedAt?,createdSignals,warnings}
  CHECK (jsonb_typeof(directions) = 'array' AND jsonb_array_length(directions) <= 5),
  CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 10),
  CHECK (NOT enabled OR jsonb_array_length(directions) >= 1)
);

CREATE TABLE person_radar_signals (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('web', 'outlet', 'list')),  -- list：榜单（02b）
  source_fingerprint TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TIMESTAMPTZ,   -- 榜单条目没有发布时间，只有上榜日
  listed_on DATE,             -- 榜单的上榜日（02b）
  excerpt TEXT NOT NULL,
  source_ref JSONB NOT NULL,
  direction_id TEXT NOT NULL,
  direction_text TEXT NOT NULL,   -- 命中时的方向快照
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  relevance SMALLINT NOT NULL CHECK (relevance BETWEEN 1 AND 5),
  read_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, source_fingerprint),
  CHECK (source_type = 'list' OR published_at IS NOT NULL),
  CHECK (source_type <> 'list' OR listed_on IS NOT NULL)
);

CREATE INDEX person_radar_signals_person_collected ON person_radar_signals (person_id, collected_at DESC, id);
