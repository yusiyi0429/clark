# staging 部署、验收与回滚

本文件是 Ticket 16 的可执行上线清单，对应 `docs/technical/ceo-warmap/08-联调与部署.md`。
真实凭据只放宿主机受限文件 `infra/.env`（Compose 自动读取，不入库）；本文件不记录任何真实值。

## 0. 火山主机准备（方案 B，一次性）

> **2026-09-29 实际上线**：天枢生产域名改为 `tk.tokenkingos.com`（新建 `sites-available/tk.conf`，配置见 `infra/host-nginx/tk.tokenkingos.com.conf`，证书 certbot webroot 签发）；`mvp.tokenkingos.com` 保持 clark 不变。镜像在主机上按国内源构建，公众号 sidecar 用 `infra/volcano.override.yml` 的本地标签。每日 05:00 备份：`crontab` 读 `infra/backup.env`（`BACKUP_TARGET=local`，存 `/srv/tokenhub/backups/tianshu`，保留 14 天，只留本机、不是异地）；age 公钥在 `backup.env`，**私钥只在 `TokenkingOS/tkos-secrets` 的 `tianshu/backup-age.key`**，主机上不留。恢复时私钥经 stdin 传入（`age -d -i -`），不落盘。

主机是 `tokenhub-prod-app-01`（Ubuntu 22.04，8C16G，公网 115.191.26.230），同时跑着 TokenHub 官网、clark-main（`demo`/旧 `mvp`）、本体 world-lab、openviking、tkos-lab 等。宿主机 Nginx 占 80/443，站点配置在 `/etc/nginx/sites-available/` 并软链到 `sites-enabled/`，证书由 certbot（nginx 插件）签发与续期。天枢只把 edge 绑在 `127.0.0.1:3130`，由宿主机 Nginx 终止 TLS 后整域名转发过来，不按路径拆。

部署目录按主机约定放在数据盘 `/srv/tokenhub/apps/tianshu`（与 world-lab、world-02、clark 同级；Docker 数据目录也在这块盘上），不放系统盘。

1. **备案与解析（已就绪）**：`tokenkingos.com` 在火山云解析，`mvp` A 记录已指向 115.191.26.230。
2. **端口**：`ss -ltnp | grep 3130` 应为空（2026-09-28 核查为空；被占用时改 `infra/docker-compose.yml` 里 edge 的宿主端口，并同步 Nginx 配置）。
3. **证书（已就绪）**：`/etc/letsencrypt/live/mvp.tokenkingos.com/` 已存在，certbot 自动续期；`sudo certbot renew --dry-run` 可复核。
4. **Nginx（切换时做）**：现有 `/etc/nginx/sites-available/mvp.conf` 把 `mvp` 转给 `127.0.0.1:3120`（clark-main，与 `demo.tokenkingos.com` 共用同一容器）。切到天枢时只替换这一个文件，`demo` 不受影响：
   ```bash
   sudo cp /etc/nginx/sites-available/mvp.conf /root/mvp.conf.clark-$(date +%Y%m%d)
   sudo cp infra/host-nginx/mvp.tokenkingos.com.conf /etc/nginx/sites-available/mvp.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
   新配置沿用同一证书路径，已含 120m 上传上限、SSE 不缓冲、600s 读超时，以及转发 `Host`/`X-Forwarded-Proto`/`X-Forwarded-For`。回退：把备份拷回 `sites-available/mvp.conf` 后 reload。
5. **镜像与依赖下载**：大陆主机直连 Docker Hub 与 npm 常失败。先试 `docker pull caddy:2 postgres:17-alpine node:22-alpine node:22.13-alpine`；失败时在 `/etc/docker/daemon.json` 配 `registry-mirrors`（火山镜像仓库或可用加速地址）后 `systemctl restart docker`。`tmwgsicp/wechat-download-api` 按 digest 拉取，镜像站没有时在可联网机器 `docker save` 后 `docker load`。构建时 `pnpm install`/`apk add` 慢可在 `infra/.env` 加 `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` 与 `ALPINE_MIRROR=https://mirrors.aliyun.com`，compose 会作为构建参数传入。
6. **出网连通**（在主机上执行，任何一项不通都先解决再上线）：
   ```bash
   for u in https://api.edgecloudapp.com https://api.bochaai.com https://tos-cn-beijing.volces.com \
            https://openspeech.bytedance.com https://asr.tencentcloudapi.com https://github.com \
            https://world-02.tokenkingos.com/v1/health; do
     printf '%-45s ' "$u"; curl -s -o /dev/null -m 10 -w '%{http_code}\n' "$u" || echo 不通
   done
   ```
   模型接口（`PI_BASE_URL` 所在域名）不通时对话、雷达与预研全部不可用。雷达的 GitHub Trending 来源依赖 `github.com`，大陆访问时好时坏。LangSmith 使用 SDK 上报；启用时配置 `LANGSMITH_API_KEY`、`LANGSMITH_PROJECT=clark_oct`、`LANGSMITH_TRACING=true` 并允许出网访问 `api.smith.langchain.com`。缺 key 或设置 tracing=false 时不上传；上传失败不改变业务结果。Thread/Turn/Span 契约见 `docs/adr/0028-langsmith-thread-turn-spans.md`。
7. **`infra/.env`**：`PUBLIC_DOMAIN=mvp.tokenkingos.com`；`EXTRA_ALLOWED_ORIGINS` 留空；其余按 `.env.example`。
8. **`tkos.ai` 跳转（已就绪，2026-09-28）**：`.ai` 不能在大陆备案，请求打到这台主机会被火山拦截，所以跳转在 Porkbun 的 URL Forwarding 做，不经宿主机 Nginx：`tkos.ai`、`www.tkos.ai` → `https://tokenkingos.com`（301，不带路径）；`mvp.tkos.ai` → `https://mvp.tokenkingos.com`（301，带路径）。用户最终停在 `mvp.tokenkingos.com`，登录 Cookie 也只在这个域名下；发给成员 Agent 的连接地址一律写 `mvp.tokenkingos.com`（301 会让部分客户端把 POST 改成 GET）。

## 1. 部署顺序

1. 宿主机准备 `infra/.env`（变量清单见 `.env.example`；真实 Bocha key、公众号 sidecar token、模型 key、人员 seed 路径）。
2. `docker compose -f infra/docker-compose.yml --env-file infra/.env config`（检查边界，不启动）。
3. `docker compose -f infra/docker-compose.yml --env-file infra/.env up -d --build`。
   - migration 由 API 启动前内联执行（advisory lock、只向前、失败则不 listen）；没有 down migration，回滚靠部署前备份与旧镜像。
   - `wechat` sidecar 只在内网，无 `ports`，不经 Caddy；首次需访问其内网登录页扫码（见 §5）。
   - 首次上线（或新增人员）后发初始码：`docker compose -f infra/docker-compose.yml --env-file infra/.env exec api pnpm --filter @warmap/api access:issue`，把输出表格里的「ID / 初始码」私下发给每个人；首次登录会要求改成自己的 4 位口令。重置某人：`... exec api pnpm --filter @warmap/api access:issue <personId>`（旧会话立即失效）。容器工作目录是 workspace 根，不带 `--filter` 会报 `Command "access:issue" not found`。
4. `bash infra/staging/smoke.sh`（需要 `PUBLIC_ORIGIN`、`CEO_LOGIN_ID` 与 `CEO_PASSCODE`）。
5. 入口复验：`bash infra/caddy/verify.sh`（本地 stub）或对线上域名复跑 `/`（Web）、`/api/healthz`（API）、`/mcp/me`（401，未授权）、已停用 `/mcp/company-memory`（404）、SSE 与 multipart；宿主机上 `curl -s http://127.0.0.1:3130/api/healthz` 可绕过 Nginx 单独确认 edge。

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
docker compose -f infra/docker-compose.yml up -d --force-recreate wechat   # 扫码/验收后回到无公网端口形态
```

  凭证只存在 `wechat_data` 卷，WarMap 从不读取 Cookie；登录有效期约 4 天，过期需重新扫码。
- `MCP_RESOURCE_URL=http://wechat:5000/mcp` 必须与 API 访问 Host 一致，否则 sidecar 的 DNS-rebinding 白名单会拒绝内网调用。
- 可选 `WECHAT_PROXY_URLS`（sidecar 侧环境变量名 `PROXY_URLS`）：填入 SOCKS5 代理池（逗号分隔）以降低微信风控；本机代理用 `socks5://host.docker.internal:<port>`（compose 已为 Linux 加 `host.docker.internal:host-gateway`，需 Docker Engine ≥ 20.10）。留空则直连。
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

默认 `BACKUP_SOURCE_MODE=compose`：PostgreSQL 只在 Compose 内网且**从不映射端口**，宿主机通过 `docker compose exec -T postgres pg_dump/psql` 在容器内备份；脚本不读取/拼接/打印 `POSTGRES_PASSWORD`。

```cron
# 火山主机已有定时任务在 01:30、02:40、03:20–03:50、04:30、06:30，天枢备份放在 05:00 错开
PATH=/opt/homebrew/opt/libpq/bin:/opt/homebrew/bin:/usr/bin:/bin
0 5 * * * BACKUP_AGE_RECIPIENT=age1... BACKUP_SSH_HOST=... BACKUP_SSH_USER=... \
  BACKUP_SSH_PATH=/srv/warmap-backups BACKUP_SSH_KEY_PATH=/root/.ssh/warmap_backup \
  WARMAP_ENV_FILE=/path/to/repo/infra/.env \
  /path/to/repo/infra/backup/backup.sh >> /var/log/warmap-backup.log 2>&1
```

- compose 模式只需宿主机有 `docker`、`age`、`ssh`/`scp`；`docker compose` 会在容器内使用 image 自带的 `pg_dump`/`psql`。
- 只有 `BACKUP_SOURCE_MODE=url`（外部库）与 `restore.sh` 才需要宿主 `pg_dump`/`psql`/`psql`；macOS 上 libpq 是 keg-only，用上面的 `PATH` 前缀（`/opt/homebrew/opt/libpq/bin`）即可，不需全局链接。
- 流程：容器内 `pg_dump -Fc` → 非空校验 → 容器内 `psql` 读 schema version → `age -r` 加密 → checksum + meta → `scp` 异机 → 异机与本机清理 `BACKUP_RETENTION_DAYS`（≥7）天前文件 → 删除本机明文。
- 先用 `backup.sh --dry-run` 验证配置（会报告 source mode、将执行的 dump/schema 命令与远端流程，零写入）；真实执行后确认异机目录存在 `.age` 与 `.sha256`。

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

## 备份/恢复（ADR 0017 + §11）

- 备份：`infra/backup/backup.sh`（宿主机 cron）。compose 模式自动停/启 `api` 冻结写入，同批次产出 dump.age、四个卷归档 .age（会前材料、会话附件、录音、公众号 sidecar 数据）与 manifest；恢复必须使用同一批次。
- 恢复：`infra/backup/restore.sh` 默认 dry-run；完整恢复需要加密 dump + 四个卷归档 + 显式命名的**空**目标卷（`--<卷>-archive`/`--<卷>-volume` 四对，缺一即拒绝）；脚本以恢复后的 DB 逐行核对 storageKey/SHA-256，不一致即失败。数据库-only 恢复对材料/会话附件/录音/公众号登录态**不是完整恢复**（脚本会显式提示）。
- 演练环境提醒：隔离恢复演练必须在 API 启动前把 `PI_BASE_URL` 指向死地址，避免 recovery/scheduler 外呼（见 `.scratch/ceo-warmap-mvp/evidence/isolated-audit-runbook.md`）。
