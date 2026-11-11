-- 卡的约定（主循环第 60 条，契约 CardAgreementView / CardAgreementChange / LocalAgreementProposal）：交代 + 完成标准只认 tasks 上这一份。
-- agreement_revision 是约定的版本号：卡建出来是 1，交代或完成标准每改一次加 1（本机交回前按它核对执行方知道的是不是最新）。
ALTER TABLE tasks ADD COLUMN agreement_revision INTEGER NOT NULL DEFAULT 1 CHECK (agreement_revision >= 1);

-- 修改记录：谁（by_kind person 本人、pipeline 项目管线、worker 执行方提议本人接受）、什么时候、改前改后、原因。只列不比对。
CREATE TABLE card_agreement_changes (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 2),
  by_kind TEXT NOT NULL CHECK (by_kind IN ('person', 'pipeline', 'worker')),
  by_name TEXT,
  agreement_before JSONB NOT NULL,
  agreement_after JSONB NOT NULL,
  reason TEXT,
  at TIMESTAMPTZ NOT NULL,
  UNIQUE (card_id, revision)
);

-- 执行方提的改约定（本机同步条目 agreement_proposal，client_id 是它的 key）。同一张卡同时只有一个 open：新的到了旧的记 superseded。
CREATE TABLE card_agreement_proposals (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  run_id UUID NOT NULL,
  standards JSONB NOT NULL,
  brief TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX card_agreement_proposals_open ON card_agreement_proposals (card_id) WHERE status = 'open';
