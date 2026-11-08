-- 新首页 17.4：伙伴代本人做事（契约 buddyActions.ts）。
-- 授权：本人在引导里点「同意」或偏好里打开（full），没同意时伙伴只能读（none）。
ALTER TABLE person_settings ADD COLUMN buddy_authority TEXT NOT NULL DEFAULT 'none' CHECK (buddy_authority IN ('none', 'full'));
ALTER TABLE person_settings ADD COLUMN buddy_granted_at TIMESTAMPTZ;

-- 伙伴做过的写动作（审计）：undo 是撤销要用的东西（不能撤为 null），undone_at 撤过的时间；seq 是同一时刻的先后。
CREATE TABLE buddy_actions (
  id UUID PRIMARY KEY,
  seq BIGSERIAL,
  owner_id TEXT NOT NULL,
  action TEXT NOT NULL,
  args JSONB NOT NULL,
  summary TEXT NOT NULL,
  undo JSONB,
  conversation_id TEXT,
  run_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  undone_at TIMESTAMPTZ
);
CREATE INDEX buddy_actions_owner ON buddy_actions (owner_id, at DESC, seq DESC);

-- 伙伴要转达给同事的一句话：先是草稿（对话里一张卡），本人点「发出」才由天枢机器人发。run_id 是出卡的那一轮（读回历史时卡接在那条回答后面）。
CREATE TABLE buddy_messages (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  to_ids TEXT[] NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'cancelled')),
  failed_ids TEXT[] NOT NULL DEFAULT '{}',
  conversation_id TEXT,
  run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ
);
CREATE INDEX buddy_messages_owner_sent ON buddy_messages (owner_id, sent_at DESC) WHERE status = 'sent';
CREATE INDEX buddy_messages_run ON buddy_messages (run_id) WHERE run_id IS NOT NULL;

-- 伙伴每一轮最后一张计划清单（Chat 的 runId）。
CREATE TABLE buddy_plans (
  run_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  entries JSONB NOT NULL,
  collapsed BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL
);

-- 「请这台电脑停掉」：在跑的子会话只能在本人电脑上停，开着的网页在那台电脑上认领，让本机停掉再报结果。
CREATE TABLE session_stops (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  card_id UUID REFERENCES tasks (id) ON DELETE CASCADE,
  topic_id UUID REFERENCES research_topics (id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES local_runs (id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  result TEXT CHECK (result IN ('stopped', 'not_running')),
  CHECK ((kind = 'card') = (card_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL))
);
CREATE UNIQUE INDEX session_stops_open ON session_stops (run_id) WHERE done_at IS NULL;
CREATE INDEX session_stops_owner ON session_stops (owner_id, device_id) WHERE done_at IS NULL;

-- 回收站和卡的归档：删掉的子会话 30 天后真删；归档的卡从首页和看板收起。专题归档照旧是 status = 'archived'。
ALTER TABLE tasks ADD COLUMN trashed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE research_topics ADD COLUMN trashed_at TIMESTAMPTZ;

-- 伙伴发起的转交：交接说明写好就直接发出（说明里没有疑似凭据时）。
ALTER TABLE project_transfers ADD COLUMN send_when_ready BOOLEAN NOT NULL DEFAULT false;
