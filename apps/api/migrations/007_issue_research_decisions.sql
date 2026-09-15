-- Ticket 08: ResearchDoc 决定闭环。Receipt 与 Research 一样是 Issue 内嵌结构，不新建实体。
ALTER TABLE issues
  ADD COLUMN receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN dismissed_at TIMESTAMPTZ,
  ADD COLUMN dismiss_reason TEXT,
  ADD COLUMN dismiss_fingerprint TEXT;
