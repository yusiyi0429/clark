-- 子会话停下的原因（SubSession.stopWhy）：本机报 stopped 时记在这个会话上，开始下一轮（starting、running、queued）时清掉。老的为 NULL。
ALTER TABLE local_runs ADD COLUMN stop_why TEXT;
-- 本机程序重启打断的停下（runner_restart）契约里早有，报告表的检查没跟上，报上来会整条拒收。
ALTER TABLE sub_session_reports DROP CONSTRAINT sub_session_reports_why_check;
ALTER TABLE sub_session_reports ADD CONSTRAINT sub_session_reports_why_check
  CHECK (why IN ('turn_done', 'interrupted', 'held', 'error', 'killed', 'runner_restart'));
