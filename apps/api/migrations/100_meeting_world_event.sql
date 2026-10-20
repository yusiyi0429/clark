-- 会议入本体（B 方案，D-58）：建会只存天枢；主持人或创建人整卡确认后写一条整场会议事件，修改另记一条并指回前次。
-- created_by：建会的人（预约的人、配置页是 CEO）；为空时按主持人算（整卡确认只给主持人和创建人）。
-- world_anchors：预约时选的、或主持人和 CEO 改过的挂点 [{kind: mission | unit, id} | {kind: lto | po, id: 本体 object_id, title}]；
--   NULL 时挂主持人负责的单元，都没有挂公司。
-- world_excluded：整卡确认时选了「不写入」（world_excluded_by 记确认人的名字）；已经写进去的不撤回，原事件保留。
-- record_*：整卡确认。record_version 只在要真写一版时加一（幂等键 tianshu-meeting:<会议 id>:v<版本>）；原样再确认只刷新确认时刻。
--   record_snapshot 是这一版确认下来、要写进去的记录；record_reason 是这次修改的原因；
--   record_edit_pending：确认之后又改了（改挂点等），要重新确认才写。
-- world_event_*：world_event_status 是 record_version 这一版的写入状态（none 待写 / committed 已写入并读回 / failed）；
--   world_event_id、world_event_record、world_event_anchors、world_event_at 是最近一次写进去的那条（下一版 content.refs 指回它，按 world_event_record 算改了什么）。
ALTER TABLE meetings
  ADD COLUMN created_by TEXT,
  ADD COLUMN world_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN world_excluded_by TEXT,
  ADD COLUMN world_anchors JSONB CHECK (world_anchors IS NULL OR jsonb_typeof(world_anchors) = 'array'),
  ADD COLUMN record_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN record_confirmed_at TIMESTAMPTZ,
  ADD COLUMN record_confirmed_by TEXT,
  ADD COLUMN record_reason TEXT,
  ADD COLUMN record_snapshot JSONB,
  ADD COLUMN record_edit_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN world_event_status TEXT NOT NULL DEFAULT 'none' CHECK (world_event_status IN ('none', 'committed', 'failed')),
  ADD COLUMN world_event_id TEXT,
  ADD COLUMN world_event_record JSONB,
  ADD COLUMN world_event_anchors JSONB CHECK (world_event_anchors IS NULL OR jsonb_typeof(world_event_anchors) = 'array'),
  ADD COLUMN world_event_at TIMESTAMPTZ;

-- 妙记读取失败（会议卡 FR-4.2）：minutes_status 加 failed，minutes_failure 记原因（no_permission 没权限 / not_ready 原文还没好 /
--   not_found 没找到 / fetch_failed 其他失败），主持人或创建人可以再读一次；只有逐字稿存下才是 ready。
ALTER TABLE meetings DROP CONSTRAINT meetings_minutes_status_check;
ALTER TABLE meetings
  ADD CONSTRAINT meetings_minutes_status_check CHECK (minutes_status IN ('none', 'waiting', 'manual', 'ready', 'failed')),
  ADD COLUMN minutes_failure TEXT CHECK (minutes_failure IS NULL OR minutes_failure IN ('no_permission', 'not_ready', 'not_found', 'fetch_failed'));
