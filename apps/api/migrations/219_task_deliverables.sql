-- Task 的交付物（taskDeliverables.ts）：本体 Task 的每个版本一行，版本号按 Task 从 1 起。天枢自己的业务数据，不写本体。
-- task_name、done_definition、criteria 是建版本时 Task 的名字、完成定义和按哪几条评（快照，basis 说明来源；评审只看快照）；review 是评审报告（headline、summary、gain、criteria[]：index、verdict、reason、evidence、fix、dissent）。
-- review_run_token：这一次评审的令牌，旧的评审跑完不能覆盖新的；review_started_at 超过 10 分钟还在 running 的会被重排。
-- note 是交付以后伙伴写的版本说明（status、achieved、gain、why、lesson、edited、dismissed）；撤回交付时清空。
CREATE TABLE deliverable_versions (
  id UUID PRIMARY KEY,
  task_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  task_name TEXT NOT NULL,
  done_definition TEXT,
  statement TEXT CHECK (char_length(statement) <= 2000),
  basis TEXT NOT NULL CHECK (basis IN ('acceptance', 'definition', 'none')),
  criteria JSONB NOT NULL DEFAULT '[]',
  review_status TEXT NOT NULL DEFAULT 'queued' CHECK (review_status IN ('queued', 'running', 'done', 'failed')),
  review_phase JSONB,
  review JSONB,
  review_error TEXT,
  review_started_at TIMESTAMPTZ,
  review_finished_at TIMESTAMPTZ,
  review_run_token UUID,
  delivered_at TIMESTAMPTZ,
  note JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, number)
);

-- 版本里的一样东西：文件、图片按 storage_key 存在材料卷的 deliverables/ 下（沿用上一版时复制行、共用同一份文件）；链接只有 url。
-- extracted_text 是能读的文字（文档上传时抽、链接评审时取）；read 是评审能不能读到它，read_note 是读不了的原因。
CREATE TABLE deliverable_items (
  id UUID PRIMARY KEY,
  version_id UUID NOT NULL REFERENCES deliverable_versions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image', 'link')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 2000),
  mime_type TEXT,
  size_bytes INTEGER,
  page_count INTEGER,
  storage_key TEXT,
  url TEXT,
  extracted_text TEXT,
  read TEXT NOT NULL DEFAULT 'pending' CHECK (read IN ('pending', 'read', 'unreadable')),
  read_note TEXT,
  CHECK ((kind = 'link') = (url IS NOT NULL AND storage_key IS NULL)),
  UNIQUE (version_id, position)
);
