-- ③ 信息收集（小版本，只有财务每周开销、方法部门每周进展两个场景）：发起人一句话 → Agent 起草 → 预览后发出。
-- collections 是任务本身（收什么、发给谁、截止、每周固定、对应的飞书多维表格）；每发出一轮建一条 kind = collection 的请求，
-- 接收人的待办卡、通知栏和飞书通知都走送达通道。person_id 一类列对应 company-people seed，不建外键。
CREATE TABLE collections (
  id UUID PRIMARY KEY,
  initiator_id TEXT NOT NULL,
  prompt TEXT NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 2000),
  scenario TEXT NOT NULL CHECK (scenario IN ('expense', 'method_progress')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60),
  -- [{key, label, kind, required}]；按场景固定，发出后不再改。
  fields JSONB NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
  -- 草稿：Agent 建议的收件人；发出后是本人确定的名单（每周固定的下一轮照这个名单发）。
  recipient_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recipient_ids) = 'array'),
  -- 草稿：拟定的截止时间；发出后是第一轮的截止时间，之后每轮加 7 天。
  deadline_at TIMESTAMPTZ NOT NULL,
  weekly BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'stopped')),
  -- 跟着草稿内容走：发出时校验 actionId 里的版本，发出去的就是预览那一版。
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 飞书多维表格 {appToken, tableId, url}；后台同步建好后写上。sync_error 是最近一次同步失败的原因（成功后清空）。
  bitable JSONB CHECK (bitable IS NULL OR jsonb_typeof(bitable) = 'object'),
  sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CHECK ((status = 'draft') = (sent_at IS NULL))
);
CREATE INDEX collections_initiator_idx ON collections (initiator_id, created_at DESC);

-- 一轮 = 一条 kind = collection 的请求。opens_at 是这一轮发出的时间：每周固定的下一轮在上一轮 opens_at 之后 7 天发出。
-- reminded_at：截止前固定时间那一次提醒发过了。
CREATE TABLE collection_rounds (
  request_id UUID PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  week_start DATE NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  deadline_at TIMESTAMPTZ NOT NULL,
  reminded_at TIMESTAMPTZ,
  UNIQUE (collection_id, seq)
);

-- 每轮每人一行（多维表格里的一行在天枢的镜像）。
-- draft_from：Agent 草稿的来源（weekly_review = 本人这周已提交的周复盘）；edited：本人改过（之后不再用周复盘覆盖）。
-- version / synced_version：天枢这边改了几次、推到飞书推到第几次；record_id 是飞书那一行。
-- shadow_nudge_at：「填完了主动提醒确认」的影子记录——如果推，会在这个时间推（不打扰人，只记录，之后对照 confirmed_at 统计有用率）。
CREATE TABLE collection_entries (
  request_id UUID NOT NULL REFERENCES collection_rounds (request_id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  "values" JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("values") = 'object'),
  draft_from TEXT CHECK (draft_from IN ('weekly_review')),
  draft_review_id UUID,
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  synced_version INTEGER NOT NULL DEFAULT 0,
  record_id TEXT,
  last_edit_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  shadow_nudge_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, person_id)
);
CREATE INDEX collection_entries_person_idx ON collection_entries (person_id);

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done', 'request_asked', 'collection_reminder'));
