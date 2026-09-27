ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added'));
ALTER TABLE notifications DROP CONSTRAINT notifications_object_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_object_type_check
  CHECK (object_type IN ('task', 'meeting', 'issue'));

INSERT INTO thread_members (object_type, object_id, person_id, added_by)
SELECT 'meeting', m.id::text, p.person_id, 'meeting'
FROM meetings m
CROSS JOIN LATERAL (
  SELECT DISTINCT person_id FROM (
    SELECT m.lead_dri_id AS person_id
    UNION ALL SELECT m.ceo_participant_id
    UNION ALL SELECT value->>'personId' FROM jsonb_array_elements(m.participants) AS value
  ) people WHERE person_id IS NOT NULL
) p
ON CONFLICT (object_type, object_id, person_id) DO UPDATE SET left_at = NULL;
