-- 我的 Agent 按「人 × 页面」私有：会话挂到登录的人名下。
-- 旧行 owner_id 为空，由应用启动时归到人员目录里的 CEO（不在迁移里写死真实人员 id）。
ALTER TABLE conversations ADD COLUMN owner_id TEXT;
DROP INDEX conversations_scope_active_idx;
CREATE INDEX conversations_owner_scope_active_idx ON conversations (owner_id, scope, created_at, id) WHERE deleted_at IS NULL;

-- 通用群组：对象（议题、信号、执行事项、会议）上的成员、消息与每人读到哪里。
-- person_id / author_id / added_by 对应 company-people seed，不建外键（seed 在文件里）。
CREATE TABLE thread_members (
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'signal', 'task', 'meeting')),
  object_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (object_type, object_id, person_id)
);

-- 成员消息必有作者；Co-Agent 同步消息作者为空。
CREATE TABLE thread_messages (
  id BIGSERIAL PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'signal', 'task', 'meeting')),
  object_id TEXT NOT NULL,
  author_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('member', 'co-agent')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  quote JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'member') = (author_id IS NOT NULL))
);
CREATE INDEX thread_messages_object_idx ON thread_messages (object_type, object_id, id);

CREATE TABLE thread_reads (
  object_type TEXT NOT NULL CHECK (object_type IN ('issue', 'signal', 'task', 'meeting')),
  object_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  last_read_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id, person_id)
);
