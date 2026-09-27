-- 已确定个人卡的更正（GAP-04）：非拍板人申请、拍板人逐条处理；拍板人直接更正同样留痕。
-- 每条只改一个字段；写回时 Mission 版本 +1，applied_version 记写回后的版本。
CREATE TABLE mission_card_corrections (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES mission_rounds (id),
  card_id UUID NOT NULL REFERENCES personal_mission_cards (id),
  mission_id TEXT NOT NULL REFERENCES missions (id),
  field TEXT NOT NULL CHECK (field IN (
    'title', 'why', 'outcome', 'successEvidence', 'boundaries', 'keyPath',
    'milestones', 'resources', 'dependencies', 'humanAgentSplit', 'risk', 'retrospect'
  )),
  original TEXT NOT NULL,
  proposed TEXT NOT NULL CHECK (char_length(proposed) BETWEEN 1 AND 4000),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  direct BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  applied_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (author_id, client_id),
  CONSTRAINT mission_card_corrections_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT mission_card_corrections_applied CHECK ((status = 'applied') = (applied_version IS NOT NULL)),
  CONSTRAINT mission_card_corrections_rejected_note CHECK (status <> 'rejected' OR note IS NOT NULL),
  CONSTRAINT mission_card_corrections_direct CHECK (NOT direct OR status = 'applied')
);
CREATE INDEX mission_card_corrections_card ON mission_card_corrections (card_id, created_at DESC);
CREATE INDEX mission_card_corrections_pending ON mission_card_corrections (round_id) WHERE status = 'pending';
