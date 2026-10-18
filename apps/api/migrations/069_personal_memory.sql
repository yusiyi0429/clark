-- 个人记忆（PR #12 的个人记忆部分，从 069 起重新编号；069 尚未发布，按本分支的最终结构写）。
-- 每条记忆一行，不再是一份整写的 Personal.md：记想法、立场、未决问题、理由、偏好与做法（kind），带时间、状态（active / superseded / forgotten）、被谁替代，
-- anchor（关于什么，[{target, pinnedVersion?}]）与 reference（依据在哪，[{ref, quote?, at}]，列名 refs 避开保留字）分开。
-- 只有本人可见，不写进本体。不给 conversations 加列：显式改动不清空会话上下文。
-- 只新增表，不改已有行，可在已有库上执行。
CREATE TABLE IF NOT EXISTS personal_memory_items (
  id uuid PRIMARY KEY,
  person_id text NOT NULL,
  kind text NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea', 'stance', 'open_question', 'reason', 'preference', 'practice')),
  title text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'forgotten')),
  superseded_by uuid REFERENCES personal_memory_items(id),
  anchors jsonb NOT NULL DEFAULT '[]'::jsonb,
  refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS personal_memory_items_person_idx ON personal_memory_items (person_id, status, created_at DESC);

-- 后台提炼的游标（每人一行）：已整理到本人哪一条消息（按 created_at、会话、序号排序）；through_* 为空表示还没整理过。
-- 失败时游标不动，attempts / next_attempt_at 做退避重试。不再每条消息排一个任务。
CREATE TABLE IF NOT EXISTS personal_memory_cursors (
  person_id text PRIMARY KEY,
  through_at timestamptz,
  through_conversation uuid,
  through_sequence integer,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
