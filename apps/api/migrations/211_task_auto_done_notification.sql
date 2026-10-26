-- 灰度：外部工具信心充足、直接判定完成时，推进人收到一条 task_auto_done。
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done', 'request_asked', 'collection_reminder', 'meeting_card_pending', 'task_progress_added', 'task_auto_done'));
