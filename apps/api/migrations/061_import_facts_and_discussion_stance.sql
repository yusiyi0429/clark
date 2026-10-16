-- H05 补充：客户资料导入的执行事实、撤回依据与群发言性质（均为可空/新增，不改原有行）。

-- 决定之后实际发生的执行/外部事实（客户邮件、法务进展、交付台账等），有日期和出处；不是决定。
-- 一条事实关联多个议题时每个议题一行（external_id 相同）。related_decision_ids 为 `decision:<id>` 引用。
CREATE TABLE issue_execution_facts (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL,
  fact_text TEXT NOT NULL CHECK (char_length(fact_text) BETWEEN 1 AND 4000),
  source_ref TEXT NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 2000),
  nature TEXT NOT NULL CHECK (nature IN ('execution', 'external')),
  related_decision_ids TEXT[] NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, external_id)
);
CREATE INDEX issue_execution_facts_issue ON issue_execution_facts (issue_id, occurred_at);

-- 被另一条决定撤回时记录撤回依据（本表 id 或 Issue Receipt id）；只在 status = 'revoked' 时有值。
ALTER TABLE issue_decision_history ADD COLUMN revoked_by TEXT;
ALTER TABLE issue_decision_history ADD CONSTRAINT issue_decision_history_revoked_by_check
  CHECK (revoked_by IS NULL OR status = 'revoked');

-- 群发言的性质（提案、意见、事实核对等），由导入资料提供；现场发言为空。发言永远不是组织决定。
ALTER TABLE thread_messages ADD COLUMN stance TEXT CHECK (stance IS NULL OR char_length(stance) BETWEEN 1 AND 100);
