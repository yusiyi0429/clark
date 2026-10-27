-- 待归位（10/26 孙铭泽定）：只有本人自己建的执行事项可以不挂 Mission；会后分派、外部 Agent 建的都要挂上。
-- 挂不上的是「待归位」：mission_id 为空、created_by 是 meeting / agent、standalone_at 为空、没做完也没退回（tasks.ts 的 UNPLACED）。
-- unplaced_reason：没挂上的原因（会后归位 Agent 或外部 Agent 写的，一句话）；挂上 Mission 时清掉。
-- standalone_at / standalone_reason：本人确认「不属于任何 Mission」和他写的为什么，之后按本人的独立事项算。
ALTER TABLE tasks
  ADD COLUMN unplaced_reason TEXT,
  ADD COLUMN standalone_at TIMESTAMPTZ,
  ADD COLUMN standalone_reason TEXT;

-- 已有的会后分派事项先按会议挂点归一次：会挂在某个 Mission 上、被分派的人正好是它的负责人，就挂上（接在这个 Mission 已有的步骤后面）。
WITH candidates AS (
  SELECT t.id, t.created_at, (
    SELECT m.id FROM jsonb_array_elements(COALESCE(mt.world_anchors, '[]'::jsonb)) a
    JOIN missions m ON m.id = a->>'id'
    WHERE a->>'kind' = 'mission' AND m.owner_id = t.owner_id AND NOT m.placeholder
    LIMIT 1
  ) AS mission_id
  FROM tasks t JOIN meetings mt ON mt.id = t.origin_meeting_id
  WHERE t.mission_id IS NULL AND t.created_by = 'meeting'
), numbered AS (
  SELECT c.id, c.mission_id,
    (SELECT COALESCE(MAX(s.step_order), 0) FROM tasks s WHERE s.mission_id = c.mission_id)
      + row_number() OVER (PARTITION BY c.mission_id ORDER BY c.created_at, c.id) AS step_order
  FROM candidates c WHERE c.mission_id IS NOT NULL
)
UPDATE tasks t SET mission_id = n.mission_id, step_order = n.step_order, version = t.version + 1, updated_at = now()
FROM numbered n WHERE t.id = n.id;
