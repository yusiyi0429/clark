-- 记忆导入（7a-3、D-06）：从 ChatGPT、Claude（粘贴、上传导出包）和 Claude Code、Codex（本机采集器上报）带进个人记忆。
-- 一次导入一行：来源、经由（登录态 session / 采集器令牌 collector）、状态、五步的步骤（读取、拆分、分类、去重和冲突、等你确认）、计数。
-- 不存上传的原文：读取和拆分在收到请求时就做完，只留拆出来的单条（密钥类在拆分时就换成「[已省略：敏感信息]」）和文件元数据。
CREATE TABLE IF NOT EXISTS memory_imports (
  id uuid PRIMARY KEY,
  person_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('chatgpt', 'claude', 'claude_code', 'codex')),
  via text NOT NULL CHECK (via IN ('session', 'collector')),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'awaiting_review', 'confirmed', 'failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- [{path, sha256, mtime, bytes}]
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS memory_imports_person_idx ON memory_imports (person_id, created_at DESC);

-- 拆出来的一条：分到哪类（category / kind / drop_reason）、把握、和谁重复、和谁冲突、在确认页哪一组（grp）、默认勾没勾、最后勾没勾、冲突怎么定、导入成了哪条个人记忆。
-- 重复、冲突可以指向已有个人记忆，也可以指向（本次或以前导入的）另一条；被指向的删掉时置空。
CREATE TABLE IF NOT EXISTS memory_import_candidates (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES memory_imports(id) ON DELETE CASCADE,
  person_id text NOT NULL,
  position integer NOT NULL,
  source text NOT NULL,
  path text NOT NULL,
  locator text NOT NULL,
  section text,
  project text,
  title text NOT NULL,
  text text NOT NULL,
  mtime timestamptz NOT NULL,
  hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  category text CHECK (category IN ('personal_preference', 'company_fact', 'project_instruction', 'drop')),
  kind text CHECK (kind IN ('preference', 'practice')),
  drop_reason text CHECK (drop_reason IN ('stale_state', 'one_off', 'private_life', 'secret', 'other_person', 'injection')),
  confidence real,
  alternative text,
  locked boolean NOT NULL DEFAULT false,
  duplicate_of_memory uuid REFERENCES personal_memory_items(id) ON DELETE SET NULL,
  duplicate_of_candidate uuid REFERENCES memory_import_candidates(id) ON DELETE SET NULL,
  conflict_memory uuid REFERENCES personal_memory_items(id) ON DELETE SET NULL,
  conflict_candidate uuid REFERENCES memory_import_candidates(id) ON DELETE SET NULL,
  grp text CHECK (grp IN ('conflict', 'uncertain', 'import', 'company', 'project', 'duplicate', 'dropped', 'skipped', 'partner')),
  default_checked boolean NOT NULL DEFAULT false,
  checked boolean NOT NULL DEFAULT false,
  resolution text CHECK (resolution IN ('keep_old', 'use_new', 'neither')),
  memory_item_id uuid REFERENCES personal_memory_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (import_id, position)
);
CREATE INDEX IF NOT EXISTS memory_import_candidates_fingerprint_idx ON memory_import_candidates (person_id, fingerprint);
