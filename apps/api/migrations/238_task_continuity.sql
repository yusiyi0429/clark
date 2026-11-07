-- 跨月延续与了结（taskContinuity.ts，设计《新首页_伙伴总管线与Task管线_2026-11-07》第 10 节）：月份只是检查点。
-- 都是天枢自己的对照和标记，不写本体。

-- 延续：旧 Task → 新 Task，一件旧 Task 只延续到一件。source：coagent Co-Agent 终版里带的「接着哪件」、world 本体里带的关系、owner 本人定的。
-- decided_by 是谁定的（本人定的必须有）；两头的 mission_id、task_name 是写入时的快照，月份页写「延续到 12 月的 X」不用再读本体。
CREATE TABLE task_continuations (
  from_task_id TEXT PRIMARY KEY,
  to_task_id TEXT NOT NULL CHECK (to_task_id <> from_task_id),
  source TEXT NOT NULL CHECK (source IN ('coagent', 'world', 'owner')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ NOT NULL,
  from_mission_id TEXT NOT NULL,
  from_task_name TEXT NOT NULL,
  to_mission_id TEXT NOT NULL,
  to_task_name TEXT NOT NULL,
  CHECK (source <> 'owner' OR decided_by IS NOT NULL)
);
CREATE INDEX task_continuations_to ON task_continuations (to_task_id);

-- 到此为止：复盘时（或本人在 Task 上）定了这件 Task 不再做；撤销就删掉这一行。note 是一句话。
CREATE TABLE task_stops (
  task_id TEXT PRIMARY KEY,
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 200)
);

-- 月份页的复盘答案：本人对这个月每件 Task 的选择（continue 继续做 / revise 改一改再做 / stop 到此为止）和一句话；同一件再答就覆盖。
-- 只补一句话、还没选时 choice 为空；两样不能都空。
CREATE TABLE task_month_reviews (
  owner_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  task_id TEXT NOT NULL,
  choice TEXT CHECK (choice IN ('continue', 'revise', 'stop')),
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 200),
  answered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, period, task_id),
  CHECK (choice IS NOT NULL OR note IS NOT NULL)
);

-- Task 在哪个 Mission（planTaskAccess.locatePlanTask 每次找到 Task 时记下）：只开过管线、没挂卡的 Task 也知道它在哪个 Mission，
-- 「看得见的 Mission」（visibleMissions.ts）据此带出之前月份的 Mission。变了按最新的覆盖。
CREATE TABLE plan_task_missions (
  task_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL
);

-- 约定草稿：延续时从旧 Task 复制来的约定，draft_from 是旧 Task 的 id；本人存一次（taskAgreements.saveAgreement）就清空、成了正式的。
ALTER TABLE task_agreement_notes ADD COLUMN draft_from TEXT;
