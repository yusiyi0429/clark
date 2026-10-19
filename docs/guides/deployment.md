# 部署、检查与回滚

本页是部署入口，说明各份操作文档的分工和必须遵守的边界。具体命令以下列文件为准：

| 文档 | 内容 |
| --- | --- |
| [`infra/staging/release.md`](../../infra/staging/release.md) | 现网事实（主机、目录、compose 组合）与 `release.sh` 的 prepare / switch / 回退步骤 |
| [`infra/staging/runbook.md`](../../infra/staging/runbook.md) | 主机准备、出网检查、迁移检查、回滚、发布观察、公众号 sidecar、备份恢复与真实外部验收 |
| [`infra/local/README.md`](../../infra/local/README.md) | 本地准生产环境：同一套 Dockerfile 与 Caddy，可恢复线上备份做回归 |
| [M2 试用](m2-trial.md) | `/m2/` 独立服务的发布输入、验收与回退 |
| [环境配置](environment.md) | 每个变量的含义、必填项和缺省行为 |

发布、给已有人员重置账号、恢复数据都需要对应授权。本页不代表现网已经验证。

## 部署边界

- 主站为 `tk.tokenkingos.com`。宿主机 Nginx 终止 TLS，整域名转给回环 `127.0.0.1:3130` 的 edge（Caddy），Caddy 再分流到 Web、API 和可选的 M2。Nginx 模板为 `infra/host-nginx/tk.tokenkingos.com.conf`；`mvp.tokenkingos.com.conf` 是切站前的历史文件。
- PostgreSQL、API、Web 和公众号 sidecar 不映射公网端口。API 以 uid 1000 运行，`storage-init` 先初始化材料、附件、录音三个卷的属主。
- 真实配置在主机的 `infra/.env`（权限 600）。Compose 只把 `infra/docker-compose.yml` 中 `api.environment` 声明过的变量交给 API；新版本引入新变量时，先写进 `infra/.env`，构建前的 `config` 会检查必填项。
- 现网 compose 组合记在主机的 `infra/compose-files`（基础文件、`volcano.override.yml`、发布脚本生成的 `release.pin.yml`，启用 M2 时还有 `m2.override.yml`）。手工执行 compose 时必须带全部 `-f`。
- 真实人员名单放主机的 `seed/company-people.json`，以只读方式挂到容器 `/repo/seed`。`COMPANY_WORLD_ACCESS_FILE`、本体凭证文件等也要写 `/repo/seed/...` 下的容器内路径。

## 发布前检查

```bash
docker compose -f infra/docker-compose.yml -f infra/volcano.override.yml --env-file infra/.env config --quiet
```

`--quiet` 只校验、不打印展开后的密钥。随后按 `release.md` 用 `release.sh prepare` 构建候选、`release.sh switch` 切换；切换前脚本会先做一次加密备份。

- API 启动先执行未应用的迁移（`apps/api/migrations`，目前编号到 099）。迁移只向前、失败时不监听，没有自动 down migration。
- 含迁移的版本 `switch` 会要求 `ALLOW_MIGRATION=1`，失败后不自动回退：旧镜像不能跑新 schema，需按 runbook 用部署前备份恢复到新库。
- 发放初始码：`docker compose … --env-file infra/.env exec api pnpm --filter @warmap/api access:issue [personId[:loginId] ...]`。带参数会重置这些人，旧会话立即失效；初始码只能私下交付。

## 部署后检查

```bash
curl --fail https://tk.tokenkingos.com/healthz
curl --fail https://tk.tokenkingos.com/api/healthz
```

- `/healthz` 由 Web 返回，`/api/healthz` 由 API 返回，两者的 `buildSha` 都应等于本次发布的提交。
- 在受控 Shell 里提供 `PUBLIC_ORIGIN`、`CEO_LOGIN_ID`、`CEO_PASSCODE` 后执行 `bash infra/staging/smoke.sh`；加 `--dry-run` 只打印步骤、不发请求。
- 未授权访问 `/mcp/me` 应被拒绝；CompanyMemory MCP（`POST /mcp/company-memory`）仍在服务，不带 `COMPANY_MEMORY_MCP_TOKEN` 时返回 401。
- `bash infra/caddy/verify.sh` 用本地替身检查 Caddy 分流、SSE 与 multipart，不代表真实 TLS、登录或外部服务通过。
- 飞书、本体、博查、录音、LangSmith 是否生效，以健康接口与实际调用为准；对应变量缺失时能力如实显示未配置。

## 备份与恢复

备份脚本在宿主机执行，API 镜像不含备份工具：

```bash
bash infra/backup/backup.sh --dry-run
```

- 默认 compose 模式会停下正在运行的 API，备份 PostgreSQL 和四个卷（会前材料、对话附件、会议录音、公众号 `wechat_data`），退出时恢复 API 原来的运行状态。产物用 age 加密，带 checksum 和清单。个人记忆存数据库，随库备份。
- 脚本**不**覆盖：`m2_state` 卷、主机上的私有 seed（人员名单、World 授权文件、M2 私有数据）、`infra/.env`。这些需要另行备份；未验证前不得称为全系统完整备份。本体公司事实投影（`MEMORY_STORAGE_DIR/company`）可从本体重建，不需备份。
- 现网 cron、保留天数与私钥位置见 runbook §0 和 §6。

恢复默认 dry-run，只接受空库与显式命名的空卷，加 `--execute` 才写入：

```bash
bash infra/backup/restore.sh --backup <dump.age> --target-url <独立空库地址> --age-identity <私钥文件>
```

完整恢复还要同一批次的四对 `--<卷>-archive` / `--<卷>-volume` 参数，脚本会用恢复后的数据库逐行核对文件 SHA-256。演练前把 `PI_BASE_URL` 指向不可达地址，避免调度外呼；不得把演练数据写回生产。

## 回滚

`release.sh switch` 成功后仍可执行 `releases/before-<短SHA>/rollback.sh`，它换回切换前的镜像与整套 infra，不恢复数据库、不删卷。schema 已不兼容时，按 runbook §3、§6 用部署前备份恢复到新空库与新空卷，再重新做部署后检查。
