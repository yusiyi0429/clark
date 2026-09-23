-- Ticket 28 W1: Mission 升为第七个核心实体。迁移只改结构，不写 21 条真实 Mission（W4 通过 API 导入）。
-- 七实体：Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan、Conversation、Mission。

-- 战场图上的 {code,title} 只是战略锚点，不再是 Mission Card；旧列名与实体重名，改名 mission_anchors。
ALTER TABLE battlefield_config RENAME COLUMN missions TO mission_anchors;

-- 能力的主要支撑引用同步改名：{type:"mission"} → {type:"mission-anchor"}，语义仍是能力支撑某个战场战略锚点。
UPDATE capability_config
   SET support_refs = COALESCE(
         (SELECT jsonb_agg(
                   CASE WHEN ref->>'type' = 'mission'
                        THEN jsonb_build_object('type', 'mission-anchor', 'missionCode', ref->>'missionCode')
                        ELSE ref END
                   ORDER BY ord)
            FROM jsonb_array_elements(support_refs) WITH ORDINALITY AS t(ref, ord)),
         '[]'::jsonb)
 WHERE support_refs @> '[{"type":"mission"}]'::jsonb;

-- Mission：版本化 Organization Fact。没有 status 列：是否为当前 Mission 由 period 表达。
-- code 只在 Mission 表内唯一，与 mission_anchors 的 code 是两套命名空间，可以重名。
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  code TEXT UNIQUE NOT NULL,
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  battlefield_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(battlefield_ids) = 'array'),
  outcome TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  success_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(success_evidence) = 'array'),
  milestones JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(milestones) = 'array'),
  dependencies TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT '',
  boundaries TEXT NOT NULL DEFAULT '',
  source_ref TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  source_title TEXT NOT NULL,
  -- mission.edit 的 fingerprint 幂等表；与 MonthlyPlan 的 action_fingerprints 同构。
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mission 配置页与总览按 period desc、能力域、code 排序；给 period + code 一条覆盖索引即可。
CREATE INDEX missions_period_code_idx ON missions (period DESC, code);
