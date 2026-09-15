-- Ticket 05: replaceable Pi execution state can be rebuilt without touching raw messages.
ALTER TABLE conversations
  ADD COLUMN recreated_at TIMESTAMPTZ,
  ADD COLUMN runtime_warning TEXT;

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  object_ref JSONB,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  model_slot TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  input_snapshot JSONB NOT NULL,
  candidate_output JSONB,
  error TEXT,
  usage JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
