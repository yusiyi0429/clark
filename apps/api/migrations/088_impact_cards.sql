-- 影响卡（H）：某个触发（目前是会上确认的一条决定）对某个人手上的哪件事（Task / Mission / 验收项）有什么影响、要他做什么。
-- 同一个人、同一个触发（同一 revision）只出一张卡；触发改判后 revision 加一，给原来收到卡的人出更正卡（correction_of 指向原卡）。
-- status：shadow（只在后台记录，不打扰人）/ delivered（已推送：经送达通道建一条 kind=impact 的请求，request_id 指向它）/ irrelevant（本人点了「和我无关」）。
-- plan_write / plan_status：「写进计划」留给 10/30；先把结构留好（activity 由 Agent 直接写、formal 由 DRI 一键确认）。
CREATE TABLE impact_cards (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('meeting_decision')),
  trigger_id UUID NOT NULL,
  trigger_revision INTEGER NOT NULL DEFAULT 0 CHECK (trigger_revision >= 0),
  meeting_id UUID REFERENCES meetings (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('shadow', 'delivered', 'irrelevant')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  impact TEXT NOT NULL CHECK (char_length(impact) BETWEEN 1 AND 2000),
  -- {kind: do | know, text, due: YYYY-MM-DD | null}；know 即「知悉即可」。
  action JSONB NOT NULL CHECK (jsonb_typeof(action) = 'object'),
  -- [{type: task | mission | acceptance, id, index?, title}]
  targets JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(targets) = 'array'),
  why TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  ask_who JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ask_who) = 'array'),
  confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  agent_judged BOOLEAN NOT NULL DEFAULT FALSE,
  correction_of UUID REFERENCES impact_cards (id) ON DELETE SET NULL,
  correction_note TEXT,
  request_id UUID REFERENCES requests (id) ON DELETE SET NULL,
  plan_write JSONB CHECK (plan_write IS NULL OR jsonb_typeof(plan_write) = 'object'),
  plan_status TEXT CHECK (plan_status IN ('proposed', 'written', 'confirmed')),
  irrelevant_reason TEXT CHECK (irrelevant_reason IS NULL OR char_length(irrelevant_reason) <= 500),
  irrelevant_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, trigger_kind, trigger_id, trigger_revision),
  CHECK ((status = 'irrelevant') = (irrelevant_at IS NOT NULL)),
  CHECK (status <> 'delivered' OR request_id IS NOT NULL)
);
CREATE INDEX impact_cards_person_idx ON impact_cards (person_id, created_at DESC);
CREATE INDEX impact_cards_trigger_idx ON impact_cards (trigger_kind, trigger_id, trigger_revision);
CREATE UNIQUE INDEX impact_cards_request_key ON impact_cards (request_id) WHERE request_id IS NOT NULL;
