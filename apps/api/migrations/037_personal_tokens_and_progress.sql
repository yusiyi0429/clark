CREATE TABLE personal_tokens (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  client TEXT NOT NULL CHECK (client IN ('codex', 'claude')),
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX personal_tokens_person ON personal_tokens (person_id, created_at DESC);

CREATE TABLE task_progress (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'codex', 'claude', 'github')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  links JSONB NOT NULL DEFAULT '[]',
  token_id UUID REFERENCES personal_tokens (id),
  client_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX task_progress_client_event ON task_progress (author_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX task_progress_task ON task_progress (task_id, created_at DESC);
