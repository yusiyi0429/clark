-- Ticket 19: Meeting Material 是 meetings JSONB 内嵌值对象；原件仅在 API-only volume。
ALTER TABLE meetings
  ADD COLUMN materials JSONB NOT NULL DEFAULT '[]'::jsonb;
