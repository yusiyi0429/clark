-- 一轮制定按战场 × 月份唯一；031 留给个人雷达，不挪用编号。
-- 新对象的时间一律由应用 ctx.now() 显式传入，不另设数据库时钟。
CREATE TABLE mission_rounds (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  battlefield_id TEXT NOT NULL REFERENCES battlefield_config (id),
  period TEXT NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  monthly_plan_id UUID NOT NULL REFERENCES monthly_plans (id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'reviewing', 'confirmed')),
  draft_origin TEXT NOT NULL CHECK (draft_origin IN ('placeholder', 'agent')),
  draft_source JSONB NOT NULL,
  goal_snapshot JSONB,
  window_seq INTEGER NOT NULL DEFAULT 0 CHECK (window_seq >= 0),
  first_opened_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  reopens JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reopens) = 'array'),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (battlefield_id, period),
  CONSTRAINT mission_rounds_window_pair CHECK ((opened_at IS NULL) = (closes_at IS NULL)),
  CONSTRAINT mission_rounds_window_48_hours CHECK (closes_at IS NULL OR closes_at = opened_at + interval '48 hours'),
  CONSTRAINT mission_rounds_draft_window CHECK ((status = 'draft') = (opened_at IS NULL)),
  CONSTRAINT mission_rounds_confirmation CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);

CREATE TABLE personal_mission_cards (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES mission_rounds (id),
  owner_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  role_label TEXT,
  member_ids JSONB NOT NULL CHECK (jsonb_typeof(member_ids) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (round_id, owner_id)
);

ALTER TABLE missions ADD COLUMN personal_mission_card_id UUID REFERENCES personal_mission_cards (id);
CREATE INDEX missions_personal_mission_card_idx ON missions (personal_mission_card_id);
