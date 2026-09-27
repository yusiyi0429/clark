ALTER TABLE tasks ADD COLUMN mission_id TEXT REFERENCES missions (id);
ALTER TABLE tasks ADD COLUMN start_date DATE;
ALTER TABLE tasks ADD COLUMN step_order INTEGER CHECK (step_order > 0);
ALTER TABLE tasks ADD COLUMN client_id UUID;
-- 推进人写「这件事的判断」的时间，详情里写「某某写于…」。
ALTER TABLE tasks ADD COLUMN judgment_at TIMESTAMPTZ;
ALTER TABLE tasks ADD CONSTRAINT tasks_step_with_mission CHECK ((mission_id IS NULL) = (step_order IS NULL));
ALTER TABLE tasks ADD CONSTRAINT tasks_start_not_after_due CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);
CREATE UNIQUE INDEX tasks_owner_client ON tasks (owner_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX tasks_mission_order ON tasks (mission_id, step_order) WHERE mission_id IS NOT NULL;

CREATE TABLE task_notes (
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id, person_id)
);

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added'));

-- 026 已经建立的会后事项只有 task_members，补齐群组名单。
INSERT INTO thread_members (object_type, object_id, person_id, added_by, joined_at)
SELECT 'task', tm.task_id::text, tm.person_id, tm.added_by, tm.added_at
  FROM task_members tm WHERE tm.left_at IS NULL
ON CONFLICT (object_type, object_id, person_id) DO UPDATE SET left_at = NULL;
