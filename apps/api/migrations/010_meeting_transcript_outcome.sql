-- Ticket 10: warmap-transcript.v1 导入与 MeetingOutcome 抽取。
-- transcript 与 outcome 都是 Meeting 内嵌结构，不建立 Transcript/Outcome 实体。
ALTER TABLE meetings
  ADD COLUMN transcript JSONB,
  ADD COLUMN outcome JSONB;
