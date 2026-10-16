-- 材料每一版是怎么来的（页面据此写「X让 Agent 改了 N 处」还是「X上传的新版本」）：
--   agent  = Agent 按某人的要求改的（对话里改、立即修改 / 采用批注、按提议改、恢复删掉的段落），或 Agent 新写的第 1 版；
--   upload = 有人上传的（上传的原件、贴的链接，或上传的新版本）；
--   import = 客户资料包导入的版本（例如资料里某人上传的 v2，带改动说明）。
-- 已有数据一律记 agent（第 1 版是原件，页面不按这一列显示）；新开的演示场次由导入写 import。
ALTER TABLE material_revisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'
  CHECK (origin IN ('agent', 'upload', 'import'));
