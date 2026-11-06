-- 约定与对表（taskAgreements.ts，设计 v0.2 第 3 节）：11 月天枢自己补的约定。12 月起约定随 Mission 确认写进本体 Task 的 definition 块，
-- 本体里有就用本体的，这张表只给 11 月补用。天枢自己的数据，不写本体。没有认可状态：这是补充说明，不是另一道认可。
-- basis 和交付物评审同一套（acceptance / definition）；criteria 是 [{index, text, proof, acceptorId}]，text 是当时的标准原文，acceptorId 为 null 表示有对表的证据就算数；
-- basis_hash 是当时标准文字的摘要，本体里的标准改了就对不上（提示「标准改过」）；revision 每存一次加 1。
CREATE TABLE task_agreement_notes (
  task_id TEXT PRIMARY KEY,
  basis TEXT NOT NULL CHECK (basis IN ('acceptance', 'definition')),
  criteria JSONB NOT NULL CHECK (jsonb_typeof(criteria) = 'array'),
  exclusions TEXT[] NOT NULL DEFAULT '{}',
  basis_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 修改记录：每存一次留一份整份的约定（负责人和 Mission 负责人都能改，留下谁在什么时候改成了什么）。
CREATE TABLE task_agreement_note_revisions (
  task_id TEXT NOT NULL REFERENCES task_agreement_notes(task_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  basis TEXT NOT NULL,
  criteria JSONB NOT NULL,
  exclusions TEXT[] NOT NULL,
  basis_hash TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, revision)
);

-- 传版本时的约定快照（评审照它判）：{proofs: [每条标准用什么证明，没写为 null], exclusions: [这次不包括什么]}；没有约定时为 null。
ALTER TABLE deliverable_versions ADD COLUMN agreement JSONB;
