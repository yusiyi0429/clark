CREATE TABLE personal_reviews (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  monthly_review_id UUID NOT NULL REFERENCES monthly_reviews (id),
  period TEXT NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  person_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'drafting', 'draft_failed', 'draft', 'submitted', 'skipped')),
  draft_source TEXT CHECK (draft_source IN ('agent_tool', 'co_agent', 'manual')),
  draft_error JSONB,
  self_review JSONB,
  submitted_at TIMESTAMPTZ,
  skipped_by TEXT,
  skipped_at TIMESTAMPTZ,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (monthly_review_id, person_id)
);
CREATE INDEX personal_reviews_person ON personal_reviews (person_id, period);

ALTER TABLE monthly_review_items DROP CONSTRAINT monthly_review_items_status_check;
ALTER TABLE monthly_review_items ADD CONSTRAINT monthly_review_items_status_check
  CHECK (status IN ('waiting', 'drafting', 'draft_failed', 'draft', 'submitted', 'returned', 'confirmed'));
ALTER TABLE monthly_reviews ADD COLUMN cycle_started_at TIMESTAMPTZ;

-- 讨论由拍板人结束；已开放但未汇总的旧轮次也取消自动截止。
ALTER TABLE mission_rounds DROP CONSTRAINT mission_rounds_window_48_hours;
ALTER TABLE mission_rounds DROP CONSTRAINT mission_rounds_window_pair;
ALTER TABLE mission_rounds ADD CONSTRAINT mission_rounds_window_pair
  CHECK (closes_at IS NULL OR (opened_at IS NOT NULL AND closes_at >= opened_at));
UPDATE mission_rounds SET closes_at = NULL WHERE status = 'open';

ALTER TABLE company_strategy_config ADD COLUMN lto_window_start TEXT
  CHECK (lto_window_start ~ '^\d{4}-(0[1-9]|1[0-2])$');
ALTER TABLE battlefield_config ADD COLUMN lto_window_start TEXT
  CHECK (lto_window_start ~ '^\d{4}-(0[1-9]|1[0-2])$');
