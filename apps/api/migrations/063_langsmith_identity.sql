-- Observability identity survives Pi session replacement and process restart.
CREATE TABLE trace_threads (
  business_key text PRIMARY KEY,
  thread_id uuid NOT NULL UNIQUE
);
CREATE TABLE trace_turns (
  thread_id uuid NOT NULL REFERENCES trace_threads(thread_id) ON DELETE CASCADE,
  logical_turn_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  input_digest text,
  PRIMARY KEY (thread_id, logical_turn_id)
);
ALTER TABLE conversation_messages ADD COLUMN logical_turn_id uuid;
CREATE UNIQUE INDEX conversation_messages_logical_turn_role
  ON conversation_messages(conversation_id, logical_turn_id, role)
  WHERE logical_turn_id IS NOT NULL;
