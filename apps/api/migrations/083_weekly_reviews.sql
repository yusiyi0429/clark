-- 周复盘（D-01）：天枢数据库是主存储，每人每周一份。
-- body 六段（沿用公司现行周复盘模板：本周总体判断、关键进展与 Evidence、最重要的问题及 Why、判断变化 / Implication、当前处理、下周重点），
-- 每段 {text, sources}，正文里每句带出处 [名称](cite:<ref>)。
-- 状态：drafting（Co-Agent 生成中）→ draft / draft_failed → submitted；origin=import 是 10 月从飞书一次性导入的已提交周复盘。
-- revisions：修改记录（谁、什么时候、生成 / 修改 / 提交 / 导入、动了哪几段、改之前的原文），最多留 100 条。
-- world_sync：提交后按关联的 Mission、Task 各写一条进展到本体，逐个对象记结果。
CREATE TABLE weekly_reviews (
  id UUID PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  person_id TEXT NOT NULL,
  week_start DATE NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  status TEXT NOT NULL CHECK (status IN ('drafting', 'draft_failed', 'draft', 'submitted')),
  origin TEXT NOT NULL DEFAULT 'tianshu' CHECK (origin IN ('tianshu', 'import')),
  body JSONB CHECK (body IS NULL OR jsonb_typeof(body) = 'object'),
  draft_source TEXT CHECK (draft_source IN ('co_agent', 'manual', 'agent_tool', 'import')),
  draft_error JSONB,
  generation_steps JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(generation_steps) = 'array'),
  edited_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(edited_fields) = 'array'),
  revisions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(revisions) = 'array'),
  import_source JSONB,
  action_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(action_fingerprints) = 'array'),
  submitted_at TIMESTAMPTZ,
  world_sync_status TEXT NOT NULL DEFAULT 'none' CHECK (world_sync_status IN ('none', 'pending', 'done', 'failed')),
  world_sync JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(world_sync) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (person_id, week_start),
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
  CHECK (origin <> 'import' OR status = 'submitted')
);
CREATE INDEX weekly_reviews_week ON weekly_reviews (week_start, person_id);
CREATE INDEX weekly_reviews_world_pending ON weekly_reviews (submitted_at) WHERE world_sync_status = 'pending';
