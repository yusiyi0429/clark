-- 材料批注按「谁写的」区分（october-launch 工单 03）：能改的人（上传者 + 对象负责人）写的批注可以立即改，
-- 其他人的批注保存为 noted，等能改的人采用（进原队列）或不采用（declined，note 是原因）。
-- decided_by：采用 / 不采用的人；能改的人自己「立即修改」时是本人。只读格式原来的 kept 并入 noted。
ALTER TABLE material_annotations DROP CONSTRAINT material_annotations_status_check;
ALTER TABLE material_annotations ADD COLUMN decided_by TEXT;
UPDATE material_annotations SET status='noted' WHERE status='kept';
UPDATE material_annotations SET decided_by=author_id WHERE status<>'noted';
ALTER TABLE material_annotations ADD CONSTRAINT material_annotations_status_check
  CHECK (status IN ('noted', 'queued', 'applying', 'applied', 'no_change', 'failed', 'declined'));
ALTER TABLE material_annotations ADD CONSTRAINT material_annotations_decided_check CHECK ((status = 'noted') = (decided_by IS NULL));

-- 对话里的修改提议：proposed_by 是对话本人；不能改的人提的，proposed_for 是上传者（对象负责人也能处理）。
ALTER TABLE material_edit_proposals ADD COLUMN proposed_by TEXT;
UPDATE material_edit_proposals SET proposed_by=proposed_for;
ALTER TABLE material_edit_proposals ALTER COLUMN proposed_by SET NOT NULL;
