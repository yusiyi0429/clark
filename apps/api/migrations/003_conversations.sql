-- Ticket 04: PostgreSQL owns raw Conversation messages; Pi entries are replaceable execution state.
CREATE TABLE fixture_objects (
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'signal', 'meeting', 'monthly-plan')),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  payload JSONB NOT NULL,
  visible_to_ceo BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (object_type, id)
);

-- Minimal replaceable object until Ticket 07 implements real Issue storage.
INSERT INTO fixture_objects (object_type, id, version, title, payload, visible_to_ceo) VALUES
  ('issue', 'fixture-001', 1, '月球基地供应链选择', '{"summary":"需要比较自建与合作供应链"}', true),
  ('issue', 'fixture-hidden', 1, '不可见 fixture', '{}', false);

CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL UNIQUE,
  pi_session_id UUID NOT NULL,
  runtime_entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  runtime_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_messages (
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  references_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, sequence)
);
