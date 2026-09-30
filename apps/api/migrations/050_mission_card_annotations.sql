-- 正文批注独立保存，不进入群聊或私人对话；明确的批注排队修改，不明确时先问作者。
CREATE TABLE mission_card_annotations (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES personal_mission_cards(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  field TEXT NOT NULL CHECK (field IN (
    'title', 'why', 'outcome', 'successEvidence', 'boundaries', 'keyPath',
    'milestones', 'resources', 'dependencies', 'humanAgentSplit', 'risk', 'retrospect'
  )),
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  source_text TEXT NOT NULL CHECK (char_length(source_text) <= 12000),
  quote TEXT NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 2000),
  prefix TEXT NOT NULL CHECK (char_length(prefix) <= 200),
  suffix TEXT NOT NULL CHECK (char_length(suffix) <= 200),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('saved','queued','applying','needs_clarification','applied','no_change','failed')),
  question TEXT,
  options JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  answer TEXT,
  note TEXT,
  applied_version INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(author_id, client_id)
);
CREATE INDEX mission_card_annotations_card_created_idx ON mission_card_annotations(card_id, created_at, id);

CREATE TABLE mission_card_revisions (
  id UUID PRIMARY KEY,
  card_id UUID NOT NULL REFERENCES personal_mission_cards(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  field TEXT NOT NULL,
  before_text TEXT NOT NULL,
  after_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('annotation','agent')),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  annotation_id UUID REFERENCES mission_card_annotations(id),
  before_version INTEGER NOT NULL CHECK (before_version > 0),
  after_version INTEGER NOT NULL CHECK (after_version > before_version),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(author_id, client_id)
);
CREATE INDEX mission_card_revisions_card_created_idx ON mission_card_revisions(card_id, created_at, id);
CREATE UNIQUE INDEX mission_card_revisions_annotation_idx ON mission_card_revisions(annotation_id) WHERE annotation_id IS NOT NULL;
