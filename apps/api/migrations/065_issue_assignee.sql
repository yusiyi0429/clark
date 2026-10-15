-- 议题指派主责人（docs/superpowers/specs/2026-10-12-assign-and-mission-status.md）。
-- assignee：当前主责 {personId, displayName, assignedAt, assignedBy, assignedByName, note, fingerprint}；没指派为 NULL。
-- assignments：全部指派历史（同字段），只增不删；改派时追加一条，assignee 换成新的一条。
ALTER TABLE issues
  ADD COLUMN assignee JSONB,
  ADD COLUMN assignments JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned'));
