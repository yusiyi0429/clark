-- 从本体载入的 Mission 服务哪个周期目标（PO）：本体 Mission 的 goal_ref 指向的对象 id。约会议挑挂点时，点一个 PO 往下列挂在它下面的 Mission。
-- 只是载入时记下的引用，不进 missions_world_source_complete 那组（没有 goal_ref 的 Mission 为 NULL）。
ALTER TABLE missions ADD COLUMN world_goal_id TEXT;
