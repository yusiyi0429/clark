-- 新首页：伙伴总管线 + 每件 Task 一条 Task 管线 + 子会话（契约 workHome.ts，设计《新首页_伙伴总管线与Task管线_2026-11-07》）。

-- Task 管线：每人每件 Task 一条单独的伙伴对话（对话 scope 是 plan-task:<taskId>）。
-- 这张表只记接了 Chat 服务时的对应：conversation_id 是 Chat 里那段对话的 id（Chat 的 POST /conversations 开的），总管线挑段时排除这些段。
-- 没接 Chat 时用天枢自己的对话，按 (owner_id, scope) 存在 conversations 里，不用另记。
CREATE TABLE task_pipelines (
  owner_id TEXT NOT NULL,
  plan_task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, plan_task_id)
);

-- 要开工（第 4.4 节）：管线里定了计划（接受草稿带 start）或伙伴开了探索子会话，云端只记这一条，不指挥本机。
-- 配对的电脑上开着的网页认领（claimed_at、claimed_device），交给本机程序；本机报上这张卡或专题的第一条执行时了结（closed_at）。
-- 认领了 5 分钟还没了结的，别处可以再认领；本机拒了，网页放回（claimed_* 清空）。一张卡、一个专题同时只有一条没了结的。
CREATE TABLE session_starts (
  id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'topic')),
  card_id UUID REFERENCES tasks (id) ON DELETE CASCADE,
  topic_id UUID REFERENCES research_topics (id) ON DELETE CASCADE,
  plan_task_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('web', 'buddy')),
  requested_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  claimed_device UUID,
  closed_at TIMESTAMPTZ,
  CHECK ((kind = 'card') = (card_id IS NOT NULL) AND (kind = 'topic') = (topic_id IS NOT NULL)),
  CHECK ((claimed_at IS NULL) = (claimed_device IS NULL))
);
CREATE UNIQUE INDEX session_starts_open_card ON session_starts (card_id) WHERE closed_at IS NULL AND card_id IS NOT NULL;
CREATE UNIQUE INDEX session_starts_open_topic ON session_starts (topic_id) WHERE closed_at IS NULL AND topic_id IS NOT NULL;
CREATE INDEX session_starts_owner_open ON session_starts (owner_id, requested_at) WHERE closed_at IS NULL;

-- 子会话里 Claude Code 自己开的后台任务（本机同步条目 background：子 agent、后台命令），按会话（run_id = 本机 sessionId）+ item_id 覆盖，
-- seq 是写入它的那条同步条目的本机序号，晚到的旧条目不改。只给首页右栏显示，云端不能停。
CREATE TABLE local_background_items (
  run_id UUID NOT NULL REFERENCES local_runs (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL CHECK (char_length(item_id) BETWEEN 1 AND 120),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subagent', 'command')),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed', 'stopped')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  stoppable BOOLEAN NOT NULL,
  seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, item_id)
);
CREATE INDEX local_background_items_owner ON local_background_items (owner_id, started_at DESC);

-- 验收过的卡合回到哪了（第 4.5 节，本机程序报的 merge 同步条目；同一次交回以同步条目幂等键末尾的本机序号最大的那条为准，同一毫秒里可能报两条）：
-- { merged, commit, baseBranch, reason, message, auto, at, seq }，merged=false 时 reason 是 base_not_checked_out | dirty | conflict | auto_merge_off | not_ready。没报过为空。
ALTER TABLE card_handbacks ADD COLUMN merge JSONB;

-- 返工卡（第 4.5 节）：已合回的卡验收被推翻时，在同一件 Task 下开一张新卡接着改，记下是从哪张卡开出来的；原卡不退回、已合进去的不撤回。
ALTER TABLE tasks ADD COLUMN rework_of_card_id UUID REFERENCES tasks (id) ON DELETE SET NULL;

-- 本机会话状态加 done（本机契约 b735df52）：规划员交了计划、验收员交了结论，这一轮做完就自己收工、进程退出；不占位置，再说一句会续上。
ALTER TABLE local_runs DROP CONSTRAINT local_runs_state_check;
ALTER TABLE local_runs ADD CONSTRAINT local_runs_state_check CHECK (state IN ('queued', 'starting', 'running', 'waiting_permission', 'idle', 'exited', 'failed', 'done'));
