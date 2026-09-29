-- 月末复盘（M1B 会议共识，ADR-0024）：每月一份，按战场 / 能力域各一项。
-- 新对象的时间一律由应用 ctx.now() 显式传入。

-- 能力域负责人：月末复盘由他提交；空串在界面显示“待指派”，和战场一致。
ALTER TABLE capability_config ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

CREATE TABLE monthly_reviews (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  period TEXT NOT NULL UNIQUE CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status TEXT NOT NULL CHECK (status IN ('collecting', 'summarizing', 'ltco_pending', 'closed')),
  -- {status: none|pending|running|ready|failed, runId, error, judgments: [], confirmedAt, confirmedBy}
  summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  -- 汇总 Agent 的 LTCO 修订建议 {change, proposedLtco, rationale}；汇总完成前为 NULL。
  ltco_suggestion JSONB,
  -- {decision: keep|revise, ltcoBefore, ltcoAfter, decidedAt, decidedBy, planExisted}
  ltco_decision JSONB,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT monthly_reviews_closed_has_decision CHECK ((status = 'closed') = (ltco_decision IS NOT NULL))
);

CREATE TABLE monthly_review_items (
  id UUID PRIMARY KEY,
  review_id UUID NOT NULL REFERENCES monthly_reviews (id),
  version INTEGER NOT NULL CHECK (version > 0),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('battlefield', 'capability')),
  subject_id TEXT NOT NULL,
  owner_id TEXT NOT NULL CHECK (owner_id <> ''),
  -- 注册表负责人为空时挂到 CEO 名下代复盘。
  owner_unassigned BOOLEAN NOT NULL,
  -- 被复盘月份已签发计划里这一项的 PCO 快照；没有时为 NULL。
  target TEXT,
  status TEXT NOT NULL CHECK (status IN ('drafting', 'draft_failed', 'draft', 'submitted', 'returned', 'confirmed')),
  -- 起草运行 {runId, error}
  draft_run JSONB NOT NULL CHECK (jsonb_typeof(draft_run) = 'object'),
  self_review JSONB,
  suggestions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(suggestions) = 'array'),
  return_reason TEXT,
  -- 偏差评估 {status: none|pending|running|ready|failed, runId, result, error}
  assessment JSONB NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
  history JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (review_id, subject_type, subject_id),
  CONSTRAINT monthly_review_items_confirmation CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT monthly_review_items_returned_reason CHECK ((status = 'returned') = (return_reason IS NOT NULL))
);
CREATE INDEX monthly_review_items_owner ON monthly_review_items (owner_id, review_id);

