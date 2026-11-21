-- 18 节第 10 条：子会话用字母称呼，停了、要人介入都报给项目主管线，主管线按字母管子会话。

-- 字母：每个项目里的子会话（卡、专题）按建立先后的序号（1 = A、26 = Z、27 = AA），建了不变、不复用（行不删，序号取最大的往下编）。
-- 一个子会话换了项目，在新项目里另给一个。项目删了跟着删。
CREATE TABLE sub_session_letters (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  subject_id UUID NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind, subject_id),
  UNIQUE (project_id, seq)
);

-- 老数据补上：卡（带岗位或交给 Claude Code 的）和专题，所在项目照首页的算法（挂着的 Task 在哪个项目，没挂 Task 的看自己的 project_id），按建立先后编。
WITH subs AS (
  SELECT COALESCE(g.project_id, t.project_id) AS project_id, 'card' AS kind, t.id AS subject_id, t.created_at
    FROM tasks t LEFT JOIN project_goals g ON g.task_id = t.plan_task_id AND g.owner_id = t.owner_id
    WHERE t.role_id IS NOT NULL OR t.executor = 'claude_code'
  UNION ALL
  SELECT COALESCE(g.project_id, r.project_id), 'topic', r.id, r.created_at
    FROM research_topics r LEFT JOIN project_goals g ON g.task_id = r.plan_task_id AND g.owner_id = r.owner_id
)
INSERT INTO sub_session_letters (project_id, kind, subject_id, seq, created_at)
SELECT s.project_id, s.kind, s.subject_id, row_number() OVER (PARTITION BY s.project_id ORDER BY s.created_at, s.subject_id), s.created_at
  FROM subs s JOIN projects p ON p.id = s.project_id;

-- 子会话停了的报告（项目动态 sub_session_report）。after_sequence：记下以后补上项目对话当时最后一条消息的 sequence，读不到为 NULL。
CREATE TABLE sub_session_reports (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  subject_id UUID NOT NULL,
  letter TEXT NOT NULL,
  title TEXT NOT NULL,
  run_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('round_done', 'stopped', 'failed')),
  summary TEXT,
  after_sequence INTEGER,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sub_session_reports_project ON sub_session_reports (project_id, created_at);

-- 子会话要人介入的决定卡（项目动态 sub_session_decision）：同一次提问、同一步批准只出一张。ask 是 { kind: question | permission, request }。
CREATE TABLE sub_session_decisions (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  subject_id UUID NOT NULL,
  letter TEXT NOT NULL,
  title TEXT NOT NULL,
  run_id UUID NOT NULL,
  device_id UUID NOT NULL,
  request_id TEXT NOT NULL,
  ask JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  after_sequence INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  UNIQUE (run_id, request_id)
);
CREATE INDEX sub_session_decisions_project ON sub_session_decisions (project_id, created_at);
CREATE INDEX sub_session_decisions_open ON sub_session_decisions (run_id) WHERE status = 'open';

-- 「请这台电脑对子会话做一件事」（SessionCommandView）：转话、重开、回答、批准，网页认领后交给本机。认领规矩同 session_stops。
CREATE TABLE session_commands (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  card_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  topic_id UUID,
  run_id UUID NOT NULL,
  device_id UUID NOT NULL,
  command JSONB NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  result TEXT CHECK (result IN ('done', 'not_running', 'expired', 'failed')),
  message TEXT,
  CHECK ((kind = 'card') = (card_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL))
);
CREATE INDEX session_commands_pending ON session_commands (owner_id, device_id) WHERE done_at IS NULL;
