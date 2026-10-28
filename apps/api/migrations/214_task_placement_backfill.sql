-- 10/27：已有的会议、Agent 建的事项还没挂 Mission 的（待归位），各排一次自动归位（task.place，taskPlacement.ts）。
-- 会后分派的事项当初已经排过一次 task.place:<id>，这次换一个键；本人已手动挂好、确认不属于任何 Mission、已完成或退回的不排。
INSERT INTO jobs (kind, dedupe_key, payload)
SELECT 'task.place', 'task.place:backfill-20261027:' || t.id::text, jsonb_build_object('taskId', t.id::text)
  FROM tasks t
 WHERE t.mission_id IS NULL AND t.created_by IN ('meeting', 'agent') AND t.standalone_at IS NULL AND t.status NOT IN ('done', 'returned')
ON CONFLICT (dedupe_key) DO NOTHING;
