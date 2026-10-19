# Meeting Material 使用 API 专用 Docker volume

Meeting Material 是 Meeting 内嵌值对象，不增加第七实体。其元数据、受限抽取文本、SHA-256 与相对 storage key 存 PostgreSQL；原始 PDF、DOCX、Markdown 仅存 API 容器挂载的 named volume，Web、DRI 服务和 Agent 均不能直接访问。选择 volume 而非对象存储或数据库 BLOB，避免为 MVP 引入新服务或把二进制塞进 JSONB；代价是数据库 dump 与 volume tar 必须在同一维护窗口、以同一 UTC 批次备份、加密、校验和恢复，未通过联合恢复验收不得部署该能力。

## 备份与恢复的落地（2026-09-20 补充）

现行脚本备份数据库和会前材料、对话附件、会议录音、公众号数据四个卷，`m2_state` 与主机私有配置不在覆盖范围内，见[部署指南](../guides/deployment.md#备份与恢复)。以下记录最初的联合恢复设计。

`infra/backup/backup.sh`（compose 模式）在同一 UTC 批次内冻结唯一写方（仅停止在运行的 `api` 服务，EXIT trap 重启），对 PostgreSQL dump 与 `meeting_materials`、`conversation_attachments` 两个卷分别归档、加密、checksum 后同批上传异机；manifest 内嵌以 DB 为准的 storageKey/SHA-256 行清单（`meetings.materials` 与 `conversation_messages.attachments`）。`infra/backup/restore.sh` 只接受空库与显式命名的空目标卷，先卷后库（`--user 1000:1000` 提取，非 root 属主兼容），并以恢复后的 DB 逐行核对卷内文件 SHA-256，不一致即 fail closed。数据库-only 的备份/恢复被显式声明为对卷数据不完整。隔离验收环境必须在 API 启动前把 PI 端点指到死地址（见 `.scratch/ceo-warmap-mvp/evidence/isolated-audit-runbook.md`）。
