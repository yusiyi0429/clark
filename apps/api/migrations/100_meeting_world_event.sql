-- 会议入本体（B 方案，D-58）：建会只存天枢；主持人或创建人整卡确认后写一条整场会议事件，修改另记一条（更正原记录或会后新决定）。
-- created_by：建会的人（预约的人、配置页是 CEO）；为空时按主持人算（整卡确认只给主持人和创建人）。
-- world_anchors：预约时选的、或主持人和 CEO 改过的挂点 [{kind: mission | unit, id} | {kind: lto | po, id: 本体 object_id, title}]；
--   NULL 时挂主持人负责的单元，都没有挂公司。确认版本和写入回执见文件末尾的 meeting_card_confirmations、meeting_card_syncs。
ALTER TABLE meetings
  ADD COLUMN created_by TEXT,
  ADD COLUMN world_anchors JSONB CHECK (world_anchors IS NULL OR jsonb_typeof(world_anchors) = 'array');

-- 妙记读取失败（会议卡 FR-4.2）：minutes_status 加 failed，minutes_failure 记原因（no_permission 没权限 / not_ready 原文还没好 /
--   not_found 没找到 / fetch_failed 其他失败），主持人或创建人可以再读一次；只有逐字稿存下才是 ready。
ALTER TABLE meetings DROP CONSTRAINT meetings_minutes_status_check;
ALTER TABLE meetings
  ADD CONSTRAINT meetings_minutes_status_check CHECK (minutes_status IN ('none', 'waiting', 'manual', 'ready', 'failed')),
  ADD COLUMN minutes_failure TEXT CHECK (minutes_failure IS NULL OR minutes_failure IN ('no_permission', 'not_ready', 'not_found', 'fetch_failed'));

-- 会议卡草稿（FR-4.3–4.5）：一场会一行，有这一行就是新格式会议（会后整理只记进度，outcome.items 为空）。
--   draft 是 MeetingCardDraft（payload 去掉 revision），action_items 是天枢本地的行动项（不进 payload、不写本体）；
--   draft_version 每次生成、保存、刷新差异、改挂点加一（编辑带它做并发控制）；draft_status created / draft_ready；current_revision 是当前确认版（整卡确认后才有）。
CREATE TABLE meeting_cards (
  meeting_id UUID PRIMARY KEY REFERENCES meetings(id),
  draft JSONB,
  action_items JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(action_items) = 'array'),
  draft_version INTEGER NOT NULL DEFAULT 0,
  draft_status TEXT NOT NULL DEFAULT 'created' CHECK (draft_status IN ('created', 'draft_ready')),
  current_revision INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 整卡确认（FR-5.1）：一次确认一行，revision 从 1 递增（meeting_cards.current_revision 指当前确认版）。
--   payload 是冻结的 MeetingCardV1Payload（relatedObjectRefs 带确认时的对象版本 <id>@<version>，不带 stale）；
--   confirmation 是 {revision, confirmedBy, confirmedAt, payloadHash}；kind first / correction / followup，reason 是修改原因；
--   draft_version 是确认用的草稿版本（同一草稿再确认不出新版）；action_items 是确认时行动项的快照（天枢本地，不进 payload）；
--   write_to_world 为 FALSE 时只留天枢记录，不写本体（已写进去的不撤回）。
CREATE TABLE meeting_card_confirmations (
  meeting_id UUID NOT NULL REFERENCES meetings(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  draft_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first', 'correction', 'followup')),
  reason TEXT,
  payload JSONB NOT NULL,
  confirmation JSONB NOT NULL,
  action_items JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(action_items) = 'array'),
  write_to_world BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, revision)
);

-- 同步回执（每个确认版本一行）：会议事件 event_status pending 待写 / succeeded 写成并读回 / failed 失败（event_error 记原因）/ skipped 选了不写入；
--   幂等键 tianshu-meeting:<会议 id>:v<revision>；objects 是对象修改的回执（MeetingObjectResult[]）；状态变化不改冻结的 payload。
--   event_subject_refs、event_occurred_at 是写成时实际写进去的 subject_refs 和 occurred_at（之后更正这条时沿用）；
--   updated_at 是最近一次变化的时刻（写成时就是写成的时刻）。
CREATE TABLE meeting_card_syncs (
  meeting_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  event_status TEXT NOT NULL CHECK (event_status IN ('pending', 'succeeded', 'failed', 'skipped')),
  event_id TEXT,
  event_error TEXT,
  event_subject_refs JSONB CHECK (event_subject_refs IS NULL OR jsonb_typeof(event_subject_refs) = 'array'),
  event_occurred_at TEXT,
  objects JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(objects) = 'array'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, revision),
  FOREIGN KEY (meeting_id, revision) REFERENCES meeting_card_confirmations(meeting_id, revision)
);

-- 会议记录待确认（FR-5.2）：草稿生成好了给主持人和创建人各发一条提醒，一场会只发一次（再存草稿、重新生成都不再发）。
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done', 'request_asked', 'collection_reminder', 'meeting_card_pending'));
CREATE UNIQUE INDEX notifications_meeting_card_pending_once ON notifications (person_id, object_id) WHERE kind = 'meeting_card_pending';

-- 会后只有会议卡一个入口（拍板 4、11）：逐条分层、提醒代判、影响卡往下推的后台任务不再有处理方，队列里没跑完的删掉（跑完的留着）。
DELETE FROM jobs WHERE kind IN ('meeting.decisions_sync', 'meeting.decisions_tick', 'meeting.decision_propagate') AND status <> 'done';
