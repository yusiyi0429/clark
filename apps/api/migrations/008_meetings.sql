-- Ticket 09: Meeting 创建与会前准备。无日历、会议中心、Notification 实体。
-- preflight 与 draft 是 Meeting 内嵌结构；action_fingerprints 用于确定性 Action 幂等重放。
CREATE TABLE meetings (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'held', 'reviewed', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  lead_dri_id TEXT NOT NULL,
  ceo_participant_id TEXT NOT NULL,
  participants JSONB NOT NULL,
  issue_ids JSONB NOT NULL,
  preflight JSONB NOT NULL,
  draft JSONB NOT NULL,
  origin_ref JSONB NOT NULL,
  external_id TEXT,
  request_fingerprint TEXT,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DRI 导入 idempotency：同 externalId 同内容返回原对象，不同内容由代码返回 409。
CREATE UNIQUE INDEX meetings_dri_external_id ON meetings (external_id) WHERE external_id IS NOT NULL;

-- 会前通知与列表按时间排序。
CREATE INDEX meetings_scheduled_at ON meetings (scheduled_at);
