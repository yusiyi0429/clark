-- 会后分层确认：一场会解读出来的「会上定了 X」。
-- tier：strategic 推给 CEO（不代判，一直等 CEO 本人；状态跟着会议条目的确认 / 不同意走）；host 由主持人确认，每场最多 5 条。
-- status：pending → confirmed（对）/ edited（改一下，final_statement 是改后的说法）/ not_decided（其实没定）/ rejected（CEO 不同意）；
--   主持人满一个工作日没确认时 agent_judged（按 recommendation 生效）；之后主持人改判，revision 加一，下游出更正卡。
-- 提醒：remind_count 已提醒次数，next_remind_at 下一次提醒（散会当天一次、下一个工作日上午一次）；due_at 到点代判（只有 host）。
-- impact_status：下游影响分析与推送的进度（按 revision）。world_*：方案 A，一条决定记一条本体事件，改判记 correction。
CREATE TABLE meeting_decisions (
  id UUID PRIMARY KEY,
  meeting_id UUID NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('strategic', 'host')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 300),
  -- 对应会议纪要里的条目（outcome.items[].id）；strategic 恰好一条。
  item_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(item_ids) = 'array'),
  turn_id TEXT,
  quote TEXT,
  speaker_id TEXT,
  -- Agent 的推荐判断与理由：代判时按它生效。
  recommendation TEXT NOT NULL DEFAULT 'confirmed' CHECK (recommendation IN ('confirmed', 'not_decided')),
  why TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'edited', 'not_decided', 'rejected', 'agent_judged')),
  final_statement TEXT CHECK (final_statement IS NULL OR char_length(final_statement) BETWEEN 1 AND 300),
  reviewer_id TEXT,
  reviewed_at TIMESTAMPTZ,
  judged_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  remind_count INTEGER NOT NULL DEFAULT 0 CHECK (remind_count >= 0),
  next_remind_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  impact_status TEXT NOT NULL DEFAULT 'none' CHECK (impact_status IN ('none', 'pending', 'done', 'failed')),
  world_status TEXT NOT NULL DEFAULT 'none' CHECK (world_status IN ('none', 'pending', 'committed', 'skipped', 'failed')),
  world_event_id TEXT,
  world_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, tier, ordinal),
  CHECK ((status = 'edited') = (final_statement IS NOT NULL)),
  CHECK (tier = 'host' OR (status <> 'agent_judged' AND due_at IS NULL))
);
CREATE INDEX meeting_decisions_meeting_idx ON meeting_decisions (meeting_id, tier, ordinal);
CREATE INDEX meeting_decisions_remind_idx ON meeting_decisions (next_remind_at) WHERE status = 'pending' AND next_remind_at IS NOT NULL;
CREATE INDEX meeting_decisions_due_idx ON meeting_decisions (due_at) WHERE status = 'pending' AND due_at IS NOT NULL;
