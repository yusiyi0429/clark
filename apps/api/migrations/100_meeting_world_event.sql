-- 会议入本体（回流设计稿 3.1、3.2，10/19 拍板）：
-- world_excluded：主持人或 CEO 标「不写进本体」（world_excluded_by 记标的人的名字）；已经写进去的，本体里记撤回更正，不删。
-- world_anchors：主持人或 CEO 改过的挂点 [{kind: mission | unit, id}]；NULL 时按决定影响到的 Mission，都没有就挂主持人负责的单元。
-- world_event_*：这场会在本体里的会议事件（摘要 + 会上定了 + 挂点，原文留在天枢）。world_event_id 是这条链上最新的一条：
--   改挂点、换纪要、改判都记 correction；撤回后是 withdrawn；world_event_anchors 是实际写进去的挂点（界面展示用）。
ALTER TABLE meetings
  ADD COLUMN world_excluded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN world_excluded_by TEXT,
  ADD COLUMN world_anchors JSONB CHECK (world_anchors IS NULL OR jsonb_typeof(world_anchors) = 'array'),
  ADD COLUMN world_event_status TEXT NOT NULL DEFAULT 'none' CHECK (world_event_status IN ('none', 'committed', 'withdrawn', 'skipped', 'failed')),
  ADD COLUMN world_event_id TEXT,
  ADD COLUMN world_event_digest TEXT,
  ADD COLUMN world_event_anchors JSONB CHECK (world_event_anchors IS NULL OR jsonb_typeof(world_event_anchors) = 'array'),
  ADD COLUMN world_event_at TIMESTAMPTZ;

-- 决定事件：world_fallback 表示受影响的对象一个都对不上、挂到了会议的挂点上；
-- world_event_revision 是 world_event_id 写入时的 revision（同一版撤回再恢复时，幂等键要另起）。
ALTER TABLE meeting_decisions
  ADD COLUMN world_fallback BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN world_event_revision INTEGER;
