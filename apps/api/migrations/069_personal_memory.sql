-- 个人记忆（PR #12 的 061 + 062 合并，从 069 起重新编号）：每人一份 Personal.md，库里只记版本、遗忘排除与提炼任务。
-- 不再给 conversations 加 memory_epoch / memory_history_cutoff：显式改动不清空会话上下文。
-- 只新增表和可空/带默认值的列，不改已有行，可在已有库上执行。
CREATE TABLE IF NOT EXISTS memory_documents (
  module text NOT NULL CHECK (module = 'personal'),
  scope_key text NOT NULL,
  directory_id uuid NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 0,
  pending_revision integer,
  epoch integer NOT NULL DEFAULT 0,
  last_explicit_job_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module, scope_key)
);
CREATE TABLE IF NOT EXISTS personal_memory_exclusions (
  person_id text NOT NULL,
  attribute_key text NOT NULL,
  title text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  through_job_id bigint NOT NULL DEFAULT 0,
  conversation_cutoffs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, attribute_key)
);
CREATE TABLE IF NOT EXISTS personal_memory_jobs (
  id bigserial PRIMARY KEY,
  person_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('natural', 'explicit')),
  epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  clarification text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, conversation_id, through_sequence, kind)
);
CREATE INDEX IF NOT EXISTS personal_memory_jobs_pending ON personal_memory_jobs (id) WHERE status = 'pending';
