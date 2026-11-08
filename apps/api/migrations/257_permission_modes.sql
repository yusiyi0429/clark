-- 设计 17.2 第 11 条：权限模式（五档，见契约 localRunner.ts 的 LocalPermissionMode）。
-- 项目存新开子会话的默认（项目主管线下面的选择），缺省 auto；项目对话、伙伴开的子会话开工时带给本机。
ALTER TABLE projects ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (permission_mode IN ('auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'));
-- 本机同步 status 报的子会话当前模式（老版本本机不报，为空）。
ALTER TABLE local_runs ADD COLUMN permission_mode TEXT
  CHECK (permission_mode IN ('auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'));
