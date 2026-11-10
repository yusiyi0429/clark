-- V2 岗位与团队（roles.ts）：长期存在、会成长的是岗位；每次干活按岗位临时起执行实例，学到的经本人采纳写回岗位。
-- owner_id 空是组织预设（启动时从 apps/api/src/roles/presets/<family>/<key>.md 同步，preset_key 就是文件名，内容变了 version +1）；
-- 本人的岗位是预设的副本（preset_key、preset_version 记从哪个预设、哪一版复制来）或自己新建的。只归档，不删，卡上的版本快照不受影响。
CREATE TABLE roles (
  id UUID PRIMARY KEY,
  owner_id TEXT,
  preset_key TEXT,
  preset_version INTEGER CHECK (preset_version >= 1),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  family TEXT NOT NULL CHECK (family IN ('general', 'dev', 'strategy_content')),
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'reviewer', 'critic')),
  duties_md TEXT NOT NULL DEFAULT '' CHECK (char_length(duties_md) <= 8000),
  practice_md TEXT NOT NULL DEFAULT '' CHECK (char_length(practice_md) <= 8000),
  acceptance_md TEXT NOT NULL DEFAULT '' CHECK (char_length(acceptance_md) <= 8000),
  tools TEXT[] NOT NULL DEFAULT '{}' CHECK (tools <@ ARRAY['tianshu', 'web_search', 'feishu', 'github', 'browser']::text[]),
  model_tier TEXT NOT NULL DEFAULT 'normal' CHECK (model_tier IN ('strong', 'normal', 'light')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by TEXT,
  CHECK (owner_id IS NOT NULL OR preset_key IS NOT NULL)
);
CREATE UNIQUE INDEX roles_preset ON roles (preset_key) WHERE owner_id IS NULL;
CREATE UNIQUE INDEX roles_owner_preset ON roles (owner_id, preset_key) WHERE owner_id IS NOT NULL AND preset_key IS NOT NULL AND archived_at IS NULL;
CREATE INDEX roles_owner ON roles (owner_id, created_at) WHERE owner_id IS NOT NULL;

-- 修改记录：version 是改完以后的版本；changes 是 [{field, before, after}]；source=proposal 时 proposal_id 指向采纳的那条修改。
CREATE TABLE role_revisions (
  id UUID PRIMARY KEY,
  role_id UUID NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  changes JSONB NOT NULL,
  reason TEXT CHECK (char_length(reason) <= 200),
  source TEXT NOT NULL CHECK (source IN ('manual', 'proposal')),
  proposal_id UUID,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX role_revisions_role ON role_revisions (role_id, version DESC);

-- 伙伴提的岗位修改：本人推翻验收（overrule）或同一张卡第二次没过（second_fail）时排一个轻模型作业。
-- drafting 是作业还在写（重启后接着写），failed 是作业没写成（不给本人看）；本人看到的是 open，采纳 accepted、不要 dismissed。
-- 一张卡最多提一条（task_id 唯一）；同一岗位同时最多 3 条待确认（代码里查）。base_version 是提的时候岗位的版本。
CREATE TABLE role_proposals (
  id UUID PRIMARY KEY,
  role_id UUID NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  task_id UUID NOT NULL UNIQUE REFERENCES tasks (id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('overrule', 'second_fail')),
  source_id UUID NOT NULL,
  base_version INTEGER NOT NULL,
  field TEXT CHECK (field IN ('duties_md', 'practice_md', 'acceptance_md')),
  proposed_text TEXT CHECK (char_length(proposed_text) <= 8000),
  why TEXT CHECK (char_length(why) <= 200),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting', 'open', 'accepted', 'dismissed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_at TIMESTAMPTZ,
  CHECK (status IN ('drafting', 'failed') OR (field IS NOT NULL AND proposed_text IS NOT NULL AND why IS NOT NULL))
);
CREATE INDEX role_proposals_owner ON role_proposals (owner_id, status, created_at DESC);

-- 卡的岗位：role_version 是开工时（本机第一次报这张卡的一次执行）岗位版本的快照。草稿的 role_id 替代 executor、model_tier 的建议（两列留着兼容），
-- 没有合适的岗位时 suggest_preset_key 建议从哪个预设加一个。专题也可以配一个岗位。
ALTER TABLE tasks ADD COLUMN role_id UUID REFERENCES roles (id), ADD COLUMN role_version INTEGER;
ALTER TABLE card_drafts ADD COLUMN role_id UUID REFERENCES roles (id), ADD COLUMN suggest_preset_key TEXT;
ALTER TABLE research_topics ADD COLUMN role_id UUID REFERENCES roles (id);

-- 专题的版本加一种：评审会合成的「分歧和建议」。
ALTER TABLE topic_versions DROP CONSTRAINT topic_versions_kind_check;
ALTER TABLE topic_versions ADD CONSTRAINT topic_versions_kind_check CHECK (kind IN ('outline', 'draft', 'review'));
