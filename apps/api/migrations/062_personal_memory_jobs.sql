CREATE TABLE personal_memory_jobs (
  id bigserial PRIMARY KEY,
  person_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('natural','explicit')),
  epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','superseded')),
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  clarification text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(person_id,conversation_id,through_sequence,kind)
);
CREATE INDEX personal_memory_jobs_pending ON personal_memory_jobs(id) WHERE status='pending';

ALTER TABLE memory_documents ADD COLUMN last_explicit_job_id bigint;
