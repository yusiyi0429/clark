# staging 部署、验收与回滚

本文件是 Ticket 16 的可执行上线清单，对应 `docs/technical/ceo-warmap/08-联调与部署.md`。
真实凭据只放宿主机受限文件 `infra/.env`（Compose 自动读取，不入库）；本文件不记录任何真实值。

## 1. 部署顺序

1. 宿主机准备 `infra/.env`（变量清单见 `.env.example`；真实 Bocha key、公众号 sidecar token、模型 key、人员 seed 路径）。
2. `docker compose -f infra/docker-compose.yml --env-file infra/.env config`（检查边界，不启动）。
3. `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`。
   - migration 由 API 启动前内联执行（advisory lock、只向前、失败则不 listen）；没有 down migration，回滚靠部署前备份与旧镜像。
   - `wechat` sidecar 只在内网，无 `ports`，不经 Caddy；首次需访问其内网登录页扫码（见 §5）。
4. `bash infra/staging/smoke.sh`（需要 `PUBLIC_ORIGIN` 与 `CEO_PASSWORD`）。
5. Caddy 边界复验：`bash infra/caddy/verify.sh`（本地 stub）或对 staging 复跑 `/`（Web）、`/api/healthz`（API）、`/mcp/company-memory`（401）、SSE 与 multipart。

## 2. 迁移与版本检查

- 迁移在 API 接流量前完成；`psql "$DATABASE_URL" -Atc "SELECT max(id) FROM schema_migrations"` 应等于仓库 `apps/api/migrations` 最大编号。
- 迁移失败时 API 进程退出且不监听，已提交的 migration 不回滚；用部署前备份恢复或修好后重跑。
- `docker compose images` 确认 `api`/`web` 使用本次 `BUILD_SHA` 构建的镜像。

## 3. 回滚

1. `docker compose stop edge web`（停止公网入口与 Web，保留数据）。
2. `docker compose up -d --no-deps api web` 换回上一版镜像（`BUILD_SHA` 对应旧 tag）。
3. schema 不兼容时按 §6 用部署前加密备份恢复到新空库，再把 API/Web 指过去；不要把新数据写回旧镜像。
4. 回滚后重跑 `infra/staging/smoke.sh`，并在 §4 观察窗口记录异常。

## 4. 发布观察清单（观察窗口 ≥ 1 个 Company Day）

- API 5xx 比例与错误码分布（结构化日志 `http.request`）。
- 401/403 异常（CEO session、DRI token、MCP token 隔离）。
- PostgreSQL 连接与 `database` health。
- Agent `agent.run` 的 failed/aborted、usage 与耗时。
- Search 调用次数、超时与 8 次保护命中。
- Radar `last_run` 与 scheduler tick；未配置/失败的来源如实显示。
- Conversation runtime entries 恢复次数与 `recreatedAt`。
- 备份 `backup.sh` 退出码、异机文件数与最新 checksum；恢复演练结果。
- 观察窗口内不因单次模型失败自动重跑；由 CEO 在对象页面决定是否重试。

## 5. 公众号 sidecar（tmwgsicp/wechat-download-api，AGPL）

- 独立容器、内网、无公网端口；WarMap API 只经 `WECHAT_MCP_URL`（默认 `http://wechat:5000/mcp`）+ `WECHAT_MCP_TOKEN` 调用。
- 首次扫码登录（sidecar 无公网端口，用临时 override 把登录页只绑到宿主机回环）：

```bash
docker compose -f infra/docker-compose.yml -f infra/staging/wechat-login.override.yml up -d wechat
# 远程服务器：ssh -L 15000:127.0.0.1:15000 <host>，本地浏览器打开 http://127.0.0.1:15000/login.html
# 默认宿主端口 15000（避开 macOS AirPlay 占用的 5000）；可用 WECHAT_LOGIN_PORT 覆盖
docker compose -f infra/docker-compose.yml up -d wechat   # 扫码完成后回到无公网端口的内网形态
```

  凭证只存在 `wechat_data` 卷，WarMap 从不读取 Cookie；登录有效期约 4 天，过期需重新扫码。
- `MCP_RESOURCE_URL=http://wechat:5000/mcp` 必须与 API 访问 Host 一致，否则 sidecar 的 DNS-rebinding 白名单会拒绝内网调用。
- 账号级拉取：Radar 来源配置的 `accountId` 必须是 sidecar 已订阅公众号的 `fakeid`；未订阅时该来源如实失败，禁止用关键词或 `site:mp.weixin.qq.com` 替代。
- 来源配置目前没有 Action 面（Ticket 06 已记录该边界），staging 验收前用 SQL 写入 `radar_config.sources`，`site.id`/`account.id` 只用于本地展示，不会被发送给 Provider：

```sql
-- web 来源的 anchor query 由锚点决定；domains 仅附加 site: 过滤
UPDATE radar_config SET version = version + 1, updated_at = now(), sources = jsonb_set(sources, '{wechatAccounts}', $json$[
  {"id":"wechat-growth","accountId":"<sidecar list_subscriptions 返回的 fakeid>","name":"增长观察","enabled":true}
]$json$::jsonb) WHERE id='default';
```

- 验证账号已订阅：在 sidecar 内调用 MCP `list_subscriptions`（或 `docker compose exec wechat` 查看订阅页）；空列表说明未扫码或账号未订阅。

## 6. 备份与恢复

### 每日备份（宿主机 cron）

```cron
15 3 * * * DATABASE_URL=postgres://... BACKUP_AGE_RECIPIENT=age1... BACKUP_SSH_HOST=... BACKUP_SSH_USER=... \
  BACKUP_SSH_PATH=/srv/warmap-backups BACKUP_SSH_KEY_PATH=/root/.ssh/warmap_backup \
  /path/to/repo/infra/backup/backup.sh >> /var/log/warmap-backup.log 2>&1
```

- 需要宿主机安装 `postgresql-client`（`pg_dump`/`psql`）与 `age`。
- 流程：`pg_dump -Fc` → 非空校验 → `age -r` 加密 → checksum + meta（含 schema version）→ `scp` 异机 → 异机与本机清理 `BACKUP_RETENTION_DAYS`（≥7）天前文件 → 删除本机明文。
- 先用 `backup.sh --dry-run` 验证配置；真实执行后确认异机目录存在 `.age` 与 `.sha256`。

### 恢复演练（只恢复到空库）

1. 新建空 PostgreSQL（独立实例或空库），得到 `TARGET_URL`。
2. `infra/backup/restore.sh --backup <warmap-*.dump.age> --target-url "$TARGET_URL" --age-identity <私钥>`（默认 dry-run，只做 checksum、生产库保护与空库检查）。
3. 确认通过后加 `--execute` 真正恢复；脚本拒绝目标等于 `DATABASE_URL`、拒绝已有表的库、checksum 不符即中止。
4. 恢复后抽查六实体、Transcript、Conversation messages 与 Pi entries 计数（脚本自动打印）。
5. 把 API 指向恢复库（`DATABASE_URL`）启动一次，创建一个 Pi Session 并继续一次对象 Conversation；记录耗时与结果。
6. 演练完成后销毁恢复库；不得把演练数据写回 staging/production。

## 7. 真实外部验收（成本上限见 ticket15 `acceptance-gates.md`）

逐项执行，失败记录但不自动重试；任何一项需要缺失的凭据/扫码/SSH 时该验收保持 BLOCKED，不得标记通过。

可重复执行入口：`set -a; . infra/.env; set +a; cd apps/api && npx tsx scripts/real-acceptance.ts`（失败即停、不重试、输出 redact；`--dry-run` 只打印计划，`--only=<bocha|models|pi-loop|transcript-outcome>` 用于修复脚本 bug 后单步复跑；Bocha 预算为单次进程 ≤3）。

> Transcript/Outcome 口径：脚本内用 `company-people.example.json` 的 personId 构造 schema 合法样例，先过 `Value.Check` 与 `validateTranscript`，再直调 `createPostMeetingAgent` seam（不经 multipart 导入端点）。项目方真实会议稿仍须按最下方第 4 行单独验收。

| 验收 | 前置 | 判定 |
|---|---|---|
| Bocha Web Search + Pi 自主 Tool loop | `BOCHA_API_KEY`、`PI_*` | 真实 query 返回 title/URL/excerpt；Pi 自主调用一次并停止 |
| 公众号账号级拉取 | sidecar 扫码、`WECHAT_MCP_*`、Radar 已订阅 fakeid | `get_recent_articles(source_id=fakeid)` 产出 Signal，非关键词搜索 |
| light/heavy/compaction 三个槽位 | `PI_BASE_URL`/`PI_API_KEY`/三模型名 | 每槽位一次真实调用成功 |
| 合法 Transcript 导入 + Outcome | heavy 槽位 | 整份校验通过并抽取（真实导入端点见 API 测试；验收脚本为直调 agent seam + example personId） |
| 真实人员 seed | 项目授权人名单 `COMPANY_PEOPLE_SEED` | MCP 与 Pi 得到一致稳定 personId |
| 异机加密备份 + 恢复 | SSH/SFTP 目标、age 公私钥 | §6 全流程通过并继续一次 Conversation |

手动触发与取证：

```bash
# Bocha + Radar 管线（一条真实 query；未配 BOCHA_API_KEY 时如实显示未配置）
curl -fsS -b cookie.txt -X POST "$PUBLIC_ORIGIN/api/radar/scans/manual" -H "origin: $PUBLIC_ORIGIN"
# 结果在 GET /api/cards/radar 与 /api/cards/signals/:id；记录 createdSignals 与 warnings

# Pi 自主 Tool loop（Conversation SSE）：在对象对话里提一个需要当前外部事实的问题
curl -N -b cookie.txt -X POST "$PUBLIC_ORIGIN/api/conversations/<scope>/messages" \
  -H "content-type: application/json" -H "origin: $PUBLIC_ORIGIN" \
  -d '{"message":"最近的公开信息里，<公司>有什么变化？"}'
# 期望 SSE 出现 tool.started/tool.completed(name=web_search) 后 turn.completed；记录调用次数
```
