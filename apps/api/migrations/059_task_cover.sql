-- 执行事项封面（.scratch/execution-items/design-12-task-cover.md）：验收、外部工具提交验收、链接材料。

-- 外部工具替推进人提交的验收（可带草稿）与推进人的验收记录；都不是状态，状态枚举不变（本体每周拉进展读它）。
ALTER TABLE tasks ADD COLUMN submission JSONB;
ALTER TABLE tasks ADD COLUMN acceptance JSONB;

-- 执行事项里贴的外部链接：没有原件，revision 1 的正文就是地址。
ALTER TABLE object_materials ADD COLUMN url TEXT;
ALTER TABLE object_materials DROP CONSTRAINT object_materials_format_check;
ALTER TABLE object_materials ADD CONSTRAINT object_materials_format_check
  CHECK (format IN ('markdown', 'pdf', 'docx', 'html', 'link'));
-- 040 的无名约束「上传的必须有原件」：链接是人放进来的（origin=upload），但没有原件。
ALTER TABLE object_materials DROP CONSTRAINT object_materials_check;
ALTER TABLE object_materials ADD CONSTRAINT object_materials_check
  CHECK (format = 'link' OR (origin = 'upload') = (storage_key IS NOT NULL));
ALTER TABLE object_materials ADD CONSTRAINT object_materials_link_check
  CHECK ((format = 'link') = (url IS NOT NULL) AND (format <> 'link' OR (origin = 'upload' AND storage_key IS NULL)));

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('meeting_action_assigned', 'task_returned', 'strategic_rejected', 'task_collaborator_added', 'thread_member_added', 'task_submitted'));
