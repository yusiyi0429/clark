-- 02c 会后闭环：执行事项、成员通知、待更新本体。
-- owner_id / person_id / actor_id / added_by 对应 company-people seed，不建外键（seed 在文件里）。
-- created_by / added_by 为 'meeting' 表示由会后推送创建。

-- 执行事项：会议 todo 推送给负责人；return_reason 只在 returned 时有意义。
-- 同一会议条目最多一条执行事项（推送幂等）；同一人同一信号最多转一次。
-- created_at 用 clock_timestamp()：同一事务内推送的多条也能按先后排序。
CREATE TABLE tasks (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  done_definition TEXT,
  judgment TEXT,
  due_date DATE,
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'done', 'returned')),
  owner_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  return_reason TEXT CHECK (char_length(return_reason) BETWEEN 1 AND 200),
  origin_signal_id UUID,
  origin_meeting_id UUID REFERENCES meetings (id),
  origin_item_id TEXT,
  source_quote TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((origin_meeting_id IS NULL) = (origin_item_id IS NULL))
);
CREATE UNIQUE INDEX tasks_origin_meeting_item ON tasks (origin_meeting_id, origin_item_id) WHERE origin_meeting_id IS NOT NULL;
CREATE UNIQUE INDEX tasks_owner_origin_signal ON tasks (owner_id, origin_signal_id) WHERE origin_signal_id IS NOT NULL;
CREATE INDEX tasks_owner_created ON tasks (owner_id, created_at DESC);

CREATE TABLE task_members (
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator')),
  added_by TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (task_id, person_id)
);

-- 通知只存指向哪个对象，文案读取时按对象当前状态组合。
-- item_id：对象内的条目（strategic_rejected 指向会议里的战略项），其余为空。
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected')),
  object_type TEXT NOT NULL CHECK (object_type IN ('task', 'meeting')),
  object_id TEXT NOT NULL,
  item_id TEXT,
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ
);
CREATE INDEX notifications_person_created ON notifications (person_id, created_at DESC);

-- CEO 确认的战略议题：先记一条待更新本体，由 OntologyUpdater 处理后回写状态与结果。
CREATE TABLE ontology_update_requests (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings (id),
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, item_id)
);
