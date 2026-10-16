-- 个人记忆（PR #12 的个人记忆部分，从 069 起重新编号；069 尚未发布，按本分支的最终结构写）。
-- 每条记忆一行，不再是一份整写的 Personal.md：记想法、立场、未决问题、理由和偏好（kind），带时间、状态（active / superseded / forgotten）、被谁替代，
-- anchor（关于什么，[{target, pinnedVersion?}]）与 reference（依据在哪，[{ref, quote?, at}]，列名 refs 避开保留字）分开。
-- 只有本人可见，不写进本体。不给 conversations 加列：显式改动不清空会话上下文。
-- 只新增表，不改已有行，可在已有库上执行。
CREATE TABLE IF NOT EXISTS personal_memory_items (
  id uuid PRIMARY KEY,
  person_id text NOT NULL,
  kind text NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea', 'stance', 'open_question', 'reason', 'preference')),
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

-- 后台提炼任务：回答成功后排一个（下一步改成按游标增量）。
CREATE TABLE IF NOT EXISTS personal_memory_jobs (
  id bigserial PRIMARY KEY,
  person_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  through_sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, conversation_id, through_sequence)
);
CREATE INDEX IF NOT EXISTS personal_memory_jobs_pending ON personal_memory_jobs (id) WHERE status = 'pending';
