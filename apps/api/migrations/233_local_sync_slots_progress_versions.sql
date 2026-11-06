-- 本机程序 11/06 补的同步内容（契约 localRunner.ts）：每批带本机的位置数，计划带进度，专题新的一版由本机编号报上来。
-- slots：这台电脑最近一批报的 {max, running, queued}（worker 列表的资源摘要用）。
ALTER TABLE local_devices ADD COLUMN slots JSONB;
-- plan_progress：最近一份计划的 {done, total, step, current}（「第 3/6 步」）。
ALTER TABLE local_runs ADD COLUMN plan_progress JSONB;
-- local_number：本机编的号。两处同时写同一个专题、号撞了时云端把这一版排到最后，number 和它不同；飞书地址按本会话的本机号对回来。
ALTER TABLE topic_versions ADD COLUMN local_number INTEGER;
