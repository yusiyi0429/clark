-- Ticket 07: Radar 自动升级与 DRI 导入共用同一 Issue 模型。无 ResearchJob/Action/ScanRun 实体。
CREATE TABLE issues (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  origin TEXT NOT NULL CHECK (origin IN ('radar', 'dri')),
  origin_ref JSONB NOT NULL,
  external_id TEXT,
  request_fingerprint TEXT,
  title TEXT NOT NULL,
  location JSONB NOT NULL,
  urgency JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'decided', 'dismissed')),
  research JSONB NOT NULL,
  promotion_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一外部变化只升级一次；dismissed Issue 保留该指纹并继续阻止再次升级。
CREATE UNIQUE INDEX issues_promotion_fingerprint ON issues (promotion_fingerprint)
  WHERE promotion_fingerprint IS NOT NULL;

-- DRI externalId 幂等键：同内容返回原对象，不同内容由代码返回 409。
CREATE UNIQUE INDEX issues_dri_external_id ON issues (external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE signals
  ADD COLUMN promoted_issue_id UUID REFERENCES issues(id),
  ADD COLUMN promotion_fingerprint TEXT;
