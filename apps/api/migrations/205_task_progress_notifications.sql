-- 协作进展通知：别人在你的执行事项上写了进展（你是推进人或在场协作者，作者不是你），左栏「协作进展」出一条。
-- 同一人同一件事只留一条没看过的：再有新进展就把那条顶到最前（created_at 更新），文案读取时取最新一条不是本人写的进展。
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done', 'request_asked', 'collection_reminder', 'meeting_card_pending', 'task_progress_added'));
CREATE UNIQUE INDEX notifications_task_progress_unread ON notifications (person_id, object_id) WHERE kind = 'task_progress_added' AND read_at IS NULL;
