-- 一版会后确认向一个既有工作目标只递送一次。pending 是本人已授权但目标尚未收到。
-- 目标 id 是当时的地址：项目/子会话后来移交、删除，也保留授权人的回执，打开时重新鉴权。
CREATE TABLE meeting_work_handoffs (
  id uuid PRIMARY KEY,
  confirmation_ref uuid NOT NULL REFERENCES nexus_dri_confirmations(id),
  authorized_by text NOT NULL,
  authorized_at timestamptz NOT NULL,
  project_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('project', 'task', 'card', 'topic')),
  target_id text NOT NULL,
  instruction text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  failure text,
  delivered_at timestamptz,
  destination jsonb,
  criteria jsonb,
  UNIQUE (confirmation_ref, project_id, target_kind, target_id),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL AND destination IS NOT NULL AND criteria IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
CREATE INDEX meeting_work_project_feed ON meeting_work_handoffs(project_id, delivered_at) WHERE status = 'delivered';
