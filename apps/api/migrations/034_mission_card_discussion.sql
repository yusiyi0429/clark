-- 公开意见独立于 thread_messages；Review 只快照这些意见，私聊不进入本轮。
CREATE TABLE mission_card_feedback (
  id UUID PRIMARY KEY,
  seq BIGSERIAL UNIQUE,
  round_id UUID NOT NULL REFERENCES mission_rounds (id),
  card_id UUID NOT NULL REFERENCES personal_mission_cards (id),
  mission_id TEXT REFERENCES missions (id),
  field TEXT CHECK (field IS NULL OR field IN (
    'title', 'why', 'outcome', 'successEvidence', 'boundaries', 'keyPath',
    'milestones', 'resources', 'dependencies', 'humanAgentSplit', 'risk', 'retrospect'
  )),
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'quote', 'suggestion')),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  quote TEXT CHECK (char_length(quote) <= 2000),
  proposed TEXT CHECK (char_length(proposed) <= 4000),
  original TEXT,
  source_version INTEGER CHECK (source_version > 0),
  basis TEXT NOT NULL CHECK (basis IN ('draft', 'candidate')),
  window_seq INTEGER NOT NULL CHECK (window_seq > 0),
  late BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (author_id, client_id),
  CONSTRAINT mission_card_feedback_field_mission CHECK (field IS NULL OR mission_id IS NOT NULL),
  CONSTRAINT mission_card_feedback_suggestion CHECK (kind <> 'suggestion' OR (
    mission_id IS NOT NULL AND field IS NOT NULL AND proposed IS NOT NULL
    AND original IS NOT NULL AND source_version IS NOT NULL AND NOT late
  )),
  CONSTRAINT mission_card_feedback_quote CHECK (kind <> 'quote' OR (
    field IS NOT NULL AND quote IS NOT NULL AND source_version IS NOT NULL
  )),
  CONSTRAINT mission_card_feedback_comment CHECK (kind <> 'comment' OR (quote IS NULL AND proposed IS NULL))
);
CREATE INDEX mission_card_feedback_card_seq_idx ON mission_card_feedback (card_id, seq);
CREATE INDEX mission_card_feedback_round_created_idx ON mission_card_feedback (round_id, created_at);

CREATE TABLE mission_round_reviews (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES mission_rounds (id),
  window_seq INTEGER NOT NULL CHECK (window_seq > 0),
  snapshot_at TIMESTAMPTZ NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL,
  feedback_ids JSONB NOT NULL CHECK (jsonb_typeof(feedback_ids) = 'array'),
  mission_versions JSONB NOT NULL CHECK (jsonb_typeof(mission_versions) = 'object'),
  note TEXT,
  applied_versions JSONB,
  superseded_at TIMESTAMPTZ,
  UNIQUE (round_id, window_seq)
);

CREATE TABLE mission_review_decisions (
  review_id UUID NOT NULL REFERENCES mission_round_reviews (id),
  feedback_id UUID NOT NULL REFERENCES mission_card_feedback (id),
  decision TEXT NOT NULL CHECK (decision IN ('accept', 'decline')),
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  carried BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (review_id, feedback_id)
);

CREATE TABLE mission_card_reads (
  card_id UUID NOT NULL REFERENCES personal_mission_cards (id),
  person_id TEXT NOT NULL,
  last_read_seq BIGINT NOT NULL CHECK (last_read_seq >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (card_id, person_id)
);
