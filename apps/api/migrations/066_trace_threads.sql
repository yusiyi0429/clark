-- LangSmith 轨迹的会话 Thread 与 Turn 计数（docs/superpowers/specs/2026-10-13-langsmith-tracing.md）。
-- 只在 LANGSMITH_TRACING=true 时读写；不参与任何业务逻辑。
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS thread_id uuid;

CREATE TABLE IF NOT EXISTS trace_threads (
  thread_key text PRIMARY KEY,
  thread_id uuid NOT NULL,
  turn_no integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  turn_status text NOT NULL DEFAULT 'none',
  updated_at timestamptz NOT NULL DEFAULT now()
);
