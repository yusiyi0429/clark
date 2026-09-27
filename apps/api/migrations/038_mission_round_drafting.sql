ALTER TABLE mission_rounds DROP CONSTRAINT mission_rounds_status_check;
ALTER TABLE mission_rounds ADD CONSTRAINT mission_rounds_status_check
  CHECK (status IN ('drafting', 'draft', 'open', 'reviewing', 'confirmed'));
ALTER TABLE mission_rounds ALTER COLUMN draft_origin DROP NOT NULL;
ALTER TABLE mission_rounds DROP CONSTRAINT mission_rounds_draft_window;
ALTER TABLE mission_rounds ADD CONSTRAINT mission_rounds_draft_window
  CHECK ((status IN ('drafting', 'draft')) = (opened_at IS NULL));
