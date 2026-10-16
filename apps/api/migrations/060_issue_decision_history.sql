-- 议题的已确认历史决定（客户原始纪要等导入）：与现场确认产生的 Issue Receipt 分开保存。
-- 只记录已经发生、有出处的历史事实；不是待 CEO 确认的候选，也不改变议题当前 status。
-- status：effective 仍有效；superseded 被同一议题的另一条决定替代（superseded_by 为替代决定的 id，
-- 可以是本表 id 或 Issue Receipt id）；revoked 已撤回（status_at 为撤回时间）。
CREATE TABLE issue_decision_history (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  decided_at TIMESTAMPTZ NOT NULL,
  decided_by TEXT NOT NULL,
  decision_text TEXT NOT NULL CHECK (char_length(decision_text) BETWEEN 1 AND 5000),
  option_label TEXT CHECK (option_label IS NULL OR char_length(option_label) BETWEEN 1 AND 500),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 2000),
  meeting_id UUID REFERENCES meetings (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('effective', 'superseded', 'revoked')),
  superseded_by TEXT,
  status_at TIMESTAMPTZ,
  status_reason TEXT CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 500),
  origin TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, external_id),
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL)),
  CHECK (status = 'effective' OR status_at IS NOT NULL)
);
CREATE INDEX issue_decision_history_issue ON issue_decision_history (issue_id, decided_at);
