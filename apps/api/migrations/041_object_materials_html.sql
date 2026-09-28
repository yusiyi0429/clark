ALTER TABLE object_materials DROP CONSTRAINT object_materials_format_check;
ALTER TABLE object_materials ADD CONSTRAINT object_materials_format_check
  CHECK (format IN ('markdown', 'pdf', 'docx', 'html'));
