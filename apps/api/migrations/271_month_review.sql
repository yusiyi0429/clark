-- 月底复盘第三版（monthReview.ts，设计《复盘进新首页_设计第三版_2026-11-10》）：天枢自己的数据，不写本体、不转 M2。
-- 一件 Task 只属于一个月，复盘的行都按（月份, Task）记；同一件 Task 在 Mission 负责人和 Task 负责人的复盘页上是同一份。

-- 去向：current 本期验收 / deferred 延期（deferred_to 是延到哪个月）/ cancelled 已取消（同时写 task_stops）。
-- owner_id 是这件 Task 的负责人（本体没登记时是 Mission 负责人），顺延清单按它找；set_by 为空表示 Agent 预填的。
CREATE TABLE month_review_tasks (
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('current', 'deferred', 'cancelled')),
  deferred_to TEXT CHECK (deferred_to ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND deferred_to > period),
  set_by TEXT,
  set_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (period, task_id),
  CHECK ((disposition = 'deferred') = (deferred_to IS NOT NULL))
);
CREATE INDEX month_review_tasks_carryover ON month_review_tasks (owner_id, deferred_to) WHERE disposition = 'deferred';

-- 逐条评定：text 是预评时的标准原文（本体里改了就对不上，那一条重新预评、本人的评定作废）。
-- agent_*：统一评审员的预评、依据一句、「标准含糊」（不给本人看，交下月拆解）；rating / note / rated_by：本人的评定、备注和谁改的，没改为空。
CREATE TABLE month_review_criteria (
  period TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 1),
  text TEXT NOT NULL,
  agent_rating TEXT CHECK (agent_rating IN ('met', 'partial', 'unmet')),
  agent_basis TEXT,
  vague BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('met', 'partial', 'unmet')),
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 1000),
  rated_by TEXT,
  PRIMARY KEY (period, task_id, idx),
  FOREIGN KEY (period, task_id) REFERENCES month_review_tasks (period, task_id) ON DELETE CASCADE
);

-- 挂在一条标准上的交付（一律是链接）。source：agent 预评挂的 / person 本人挂的。
CREATE TABLE month_review_links (
  id UUID PRIMARY KEY,
  period TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 1),
  url TEXT NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  source TEXT NOT NULL CHECK (source IN ('agent', 'person')),
  -- 挂上的先后（按写入的真实时间，页面上按它排）。
  added_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (period, task_id) REFERENCES month_review_tasks (period, task_id) ON DELETE CASCADE
);
CREATE INDEX month_review_links_task ON month_review_links (period, task_id, idx, added_at);

-- 按 Mission 确认（只有 Mission 负责人能点）；确认后这个 Mission 下再改就删掉这一行，要重新确认。
CREATE TABLE month_review_missions (
  period TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (period, mission_id)
);

-- 本人这一轮的预评走到哪了（复盘页页头、「等你」里的「复盘 N 月」看它）。
CREATE TABLE month_review_prefills (
  owner_id TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, period)
);
