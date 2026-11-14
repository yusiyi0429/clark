CREATE TABLE work_intake (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  scope text NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY,
  message text NOT NULL,
  page_path text,
  attachments jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','delivered','failed','cancelled')),
  priority boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  lease_until timestamptz,
  chat_segment jsonb,
  accepted_at timestamptz,
  last_error text
);
CREATE INDEX work_intake_pending ON work_intake (owner_id, scope, priority DESC, position) WHERE state IN ('queued','sending');
CREATE TABLE conversation_input_receipts (
  owner_id text NOT NULL,
  scope text NOT NULL,
  client_id uuid NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (owner_id, scope, client_id)
);
