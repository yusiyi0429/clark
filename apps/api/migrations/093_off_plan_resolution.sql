-- 计划外工作的处理（② 进展）：采集器整理时归不上 Task 的进展（collector_progress.placement 是 pending_attach / pending_replan），
-- 本人二选一：attached 挂到某件执行事项上（task_id 改成选中的那件，同时写一条执行事项进展 task_progress_id）；
-- replan 提出改计划（先只记下来，还没有改计划的流程）。placement 保留整理时的判断，不随处理改写。
ALTER TABLE collector_progress ADD COLUMN resolution TEXT CHECK (resolution IN ('attached', 'replan'));
ALTER TABLE collector_progress ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE collector_progress ADD COLUMN resolved_by TEXT;
ALTER TABLE collector_progress ADD CONSTRAINT collector_progress_resolved_check
  CHECK ((resolution IS NULL) = (resolved_at IS NULL) AND (resolution IS NULL) = (resolved_by IS NULL));
CREATE INDEX collector_progress_off_plan ON collector_progress (person_id, ended_at DESC)
  WHERE placement <> 'task' AND resolution IS DISTINCT FROM 'attached';
