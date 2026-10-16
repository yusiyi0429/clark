# 部署、检查与回滚

本指南提供操作步骤，不代表现网已验证。发布、重置账号和恢复数据必须获得对应授权。

## 部署边界

仓库记录的主站为 `tk.tokenkingos.com`。宿主机 Nginx 终止 TLS，将请求转到回环端口 `3130`。Caddy 再分流至 Web、API 和可选 M2。执行前必须核对当前主机、目录、域名与镜像版本。

旧 `mvp.tokenkingos.com` 配置是历史保留文件。不得依据旧文件切换现网域名。主站 Nginx 模板见 `infra/host-nginx/tk.tokenkingos.com.conf`。

PostgreSQL、API、Web 和公众号服务不直接暴露公网端口。API 以非 root 用户运行。`storage-init` 初始化持久卷权限后，API 才能启动。

## 发布输入

1. 明确提交 SHA 与回退镜像。
2. 核对根目录 `.env` 的生产配置。
3. 准备真实人员目录与 World 授权文件。
4. 核对模型、搜索、公众号、录音与追踪的网络条件。
5. 完成数据库及文件备份。
6. 记录本次未覆盖能力与风险。

真实凭据只放受限根目录 `.env`。文件权限为 `600`。变量及本地／容器路径区别见[环境指南](environment.md)。API 人员目录挂载为 `/repo/seed/company-people.json`。

World 授权文件必须位于只读挂载目录。记忆使用独立 `memory` 卷。缺少 World 授权时，不得用示例名单或旧公司资料替代。

## Compose 检查与启动

从仓库根目录执行。解析配置使用 `--quiet`，避免展开密钥。

```bash
docker compose --env-file .env -f infra/docker-compose.yml config --quiet
```

火山环境按实际部署加入 `-f infra/volcano.override.yml`。M2 另加入 `-f infra/m2.override.yml`，并先完成 [M2 发布输入](m2-trial.md)。检查、启动、停止与回滚必须使用同一组 Compose 文件。

获得发布授权后执行：

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build
```

API 在监听前应用未执行迁移。迁移只向前执行，失败时不监听。没有自动 down migration。不得认为换回旧镜像就能回退数据库。

需要发放账号时，另行确认人员与影响范围：

```bash
docker compose --env-file .env -f infra/docker-compose.yml \
  exec api pnpm --filter @warmap/api access:issue <personId>
```

显式发放已有人员会重置凭据。初始码通过私密渠道交付，首次登录要求修改。

## 部署检查

```bash
curl --fail https://tk.tokenkingos.com/healthz
curl --fail https://tk.tokenkingos.com/api/healthz
```

在受控子 Shell 导出配置后执行 `bash infra/staging/smoke.sh`。真实 smoke 需要 `CEO_LOGIN_ID` 与 `CEO_PASSCODE`。这两个临时验收值不写入示例配置。

检查以下边界：

- Web 与 API 的构建标识符合发布版本。
- 未授权 `/mcp/me` 拒绝访问。
- `/mcp/company-memory` 返回 404。
- SSE 不缓冲，长请求不提前截断。
- multipart 上传限制符合代理与 API 配置。
- 成员不能访问 CEO 专用接口。
- 公司事实按登录人员授权范围读取。

`bash infra/caddy/verify.sh` 使用本地替身检查代理，不代表真实 TLS、登录或外部服务通过。

## 公众号服务

公众号使用独立 `tmwgsicp/wechat-download-api` 容器。API 只持有 MCP 令牌，不读取微信 Cookie。扫码数据保存在 `wechat_data` 卷。

首次扫码可以临时开放回环端口：

```bash
docker compose --env-file .env -f infra/docker-compose.yml \
  -f infra/staging/wechat-login.override.yml up -d wechat
```

远程操作使用 SSH 隧道转发 `15000`，再打开本地 `/login.html`。扫码完成后，使用原部署文件组重建公众号服务，移除临时端口。

`MCP_RESOURCE_URL` 必须与 API 实际访问 Host 一致。`WECHAT_PROXY_URLS` 可以配置经授权的代理。Radar 的 `accountId` 必须是已订阅公众号的 `fakeid`。不得用关键词搜索冒充账号级拉取。

## 备份与恢复

备份脚本在宿主机执行。API 镜像不安装备份工具。Shell 导出方式见[环境指南](environment.md)。

```bash
(
  set -a
  . ./.env
  set +a
  bash infra/backup/backup.sh --dry-run
)
```

默认 Compose 模式会停止原本运行中的 API，随后备份数据库和四个文件卷。退出时尝试恢复 API 原运行状态。产物使用 age 加密，并带 checksum 与清单。

四个文件卷为会议材料、会话附件、录音和公众号数据。`BACKUP_SOURCE_MODE=url` 只备份数据库。`BACKUP_TARGET=local` 只保留本机副本，不能应对整机丢失。

**不得把现有脚本产物称为全系统完整备份。** 当前脚本没有归档独立 `memory` 卷、`m2_state` 和私有 seed。部署者必须核对这些数据的独立备份与恢复。未经验证，不得宣称个人记忆或 M2 可以恢复。

cron 使用仓库绝对路径，加载同一根目录配置。不得继续维护独立的 `infra/backup.env`。本地整理不会替换服务器已有 cron。

恢复默认 dry-run。目标必须是新空库与显式命名的空卷。脚本先验证 checksum，再执行解密。加 `--execute` 才写入：

```bash
bash infra/backup/restore.sh \
  --backup <dump.age> \
  --target-url <独立空库地址> \
  --age-identity <私钥文件>
```

上述命令只检查数据库恢复。四卷恢复还必须提供 `--meeting-materials-archive` / `--meeting-materials-volume`、`--conversation-attachments-archive` / `--conversation-attachments-volume`、`--meeting-recordings-archive` / `--meeting-recordings-volume`、`--wechat-data-archive` / `--wechat-data-volume`。参数必须属于同一备份批次。

恢复后，核对数据库中的 storageKey/SHA-256 与文件。再检查对象、对话及 Runtime 恢复。隔离演练必须阻止真实模型与调度外呼。不得把演练数据写回生产。

## 回滚

1. 停止入口流量。
2. 保留当前数据库与文件卷。
3. 使用原文件组恢复已核对的旧镜像。
4. schema 不兼容时，恢复部署前备份到新空库与新空卷。
5. 指向恢复数据后，重新执行部署检查。

不得删除现有卷，不得把新数据强行交给不兼容的旧镜像。M2 停止与回退见其独立指南。

## 真实外部验收

从 `apps/api` 运行实际验收脚本。先用 dry-run 核对计划：

```bash
cd apps/api
node --env-file=../../.env --import tsx scripts/real-acceptance.ts --dry-run
```

正式执行会访问外部服务并产生费用。分别核对博查、三个模型槽位、Pi 工具循环、公众号账号拉取、真实人员目录、会议逐字稿与恢复路径。脚本中的可控样例不替代真实会议导入。

观察 API 错误、鉴权异常、数据库连接、Agent 失败、搜索超时、雷达最近成功时间、调度与备份结果。外部能力失败时如实显示，不以静默重试或假数据通过验收。
