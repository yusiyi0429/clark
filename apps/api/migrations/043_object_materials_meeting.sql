ALTER TABLE object_materials DROP CONSTRAINT object_materials_object_type_check;
ALTER TABLE object_materials ADD CONSTRAINT object_materials_object_type_check
  CHECK (object_type IN ('issue', 'task', 'meeting'));
