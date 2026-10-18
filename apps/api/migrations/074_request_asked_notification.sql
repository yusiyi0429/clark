-- 送达通道：接收人提问（没有命中「已有人问过」、本人确认发出）时通知发起人，点开进这条请求的问答区。
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted', 'issue_assigned',
    'request_received', 'request_answered', 'request_done', 'request_asked'));
