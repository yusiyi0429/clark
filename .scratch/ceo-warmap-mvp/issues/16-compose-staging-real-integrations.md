# 16: 完成 Compose 部署与真实外部验收

Type: implementation
Status: claimed
Blocked by: 15 建立全链测试、观测与安全门槛

## What to build

把已通过功能门槛的系统部署到 integration/staging，验证 Caddy TLS、真实 Provider、生产模型、CompanyMemory MCP、备份恢复和上线 smoke。

## Acceptance criteria

- [x] Caddy、Web、API 和 PostgreSQL 通过单机 Docker Compose 运行，只有 Caddy 暴露 80/443 并自动处理证书与 HTTP 跳转。
- [x] Web/API 镜像可重复构建、以非 root 运行；migration 在 API 接流量前完成且不会自动回滚数据库。
- [x] SSE、Transcript multipart、DRI service API 与 MCP 均直接经 Caddy 正确透传，不经过 Web rewrite。
- [ ] 一个真实 Web Search query 返回 title、URL、excerpt，并由 Pi 完成一次自主 Tool loop。
- [ ] 一个真实公众号账号按账号拉取文章并进入同一 Signal 管线，不以站点关键词搜索替代。
- [ ] light、heavy、compaction 模型槽位和合法 Transcript 各完成一次真实验收。
- [ ] CompanyMemory MCP 装载真实人员 seed，Pi 与独立客户端得到一致稳定 personId。
- [ ] 宿主机 cron 生成 age 加密 pg_dump、校验 checksum、经 SSH/SFTP 复制异机并保留至少 7 天。
- [ ] 独立 restore 流程恢复到空 PostgreSQL，不覆盖现有库；恢复后抽查六实体、Transcript、消息和 Pi entries，并继续一次 Conversation。
- [x] staging smoke、回滚步骤和发布观察清单完成；未引入 Redis、队列、对象存储、Kubernetes或额外 Runtime。

## Comments

### 交付（`.scratch/ceo-warmap-mvp/evidence/ticket16/verification.md` 为完整证据）

- Provider 决策纠正：Web Search 唯一 Provider 改为博查（`BOCHA_API_KEY`），删除 Brave/`SEARCH_API_KEY`；公众号改为独立 AGPL sidecar `tmwgsicp/wechat-download-api:1.7.0` 的 MCP（`WECHAT_MCP_URL`/`WECHAT_MCP_TOKEN`），用 `list_subscriptions`/`get_recent_articles`/`read_article` 账号级能力，未订阅账号如实失败、不退回关键词或 `site:mp.weixin.qq.com`；不 vendor 源码、WarMap 不接触微信 Cookie、sidecar 只在内网且不经 Caddy。
- 已对真实镜像核对契约：本地起 1.7.0，`/mcp` 无 Token 401、`Host: wechat:5000` + Token 200、6 个工具名与返回形状确认；真实 MCP 客户端调用 `list_subscriptions` 得到空列表并如实拒绝未订阅账号。
- Compose/镜像：新增内部 `wechat` 服务（无 ports、固定 tag、`MCP_RESOURCE_URL=http://wechat:5000/mcp`）；API/Web 镜像改为 `USER node` 并固定 `pnpm@11.20.0`；新增 `.dockerignore`；migration 保持 API 启动前内联执行（advisory lock、只向前、失败不 listen，无 down）。
- 备份/恢复：新增 `infra/backup/backup.sh`（pg_dump → 非空校验 → age 加密 → checksum+meta → SFTP 异机 → 保留 ≥7 天 → 删明文）与独立 `restore.sh`（默认 dry-run、`--execute` 才写、拒绝生产 URL/非空库、checksum 先行）。本地用真实 pg_dump/age/pg_restore 跑通完整往返（含恢复后 conversations/messages/pi_entries 抽查与非空库拒绝）。
- 新增 `infra/staging/runbook.md`（部署顺序、迁移检查、回滚、观察清单、sidecar 扫码、备份恢复、真实验收表）与 `infra/staging/smoke.sh`（`--dry-run` + 真实入口 smoke）；API 增加 `/api/healthz` 别名，使 health 经 Caddy `/api/*` 公网可达。
- `.env.example` 与 `docs/technical/ceo-warmap/08-联调与部署.md` 同步为 `BOCHA_API_KEY`/`WECHAT_MCP_*`/备份变量。

### 验证

- `pnpm test`：contracts 26 + Web 9 + API 227；`pnpm typecheck`、`pnpm build` 通过；`gen:client` 无漂移。
- `docker compose config`：仅 `edge` 发布 80/443，服务集合正确；`docker compose build api web` 成功；容器内 `uid=1000(node)` 且 `pnpm 11.20.0`。
- `bash infra/caddy/verify.sh`：`/`、`/api/*`、`/api/healthz`、`/mcp/*`、multipart、SSE 全通过。
- 新增测试：`apps/api/test/webSearch.test.ts`、`apps/api/test/deployment.test.ts`（Compose 边界/镜像非 root/脚本安全边界/smoke dry-run），并改写 radar adapter 用例覆盖博查与真实 MCP 调用形状。

### 内部评审（Herdr · deepseek-flash 只读双轴）

- 命令：`herdr agent start t16-reviewer --kind pi --pane wH:p2 -- --provider deepseek --model deepseek-flash --exclude-tools edit,write`，只读评审 Standards/Spec。
- 结论：Axis A green、Axis B green，无 blocking；确认博查唯一、公众号严格账号级 MCP（用真实镜像源码核对工具签名）、Caddy 唯一公网直透、migration 前置于 listen 且无自动回滚、备份/恢复六要素齐备。
- 主 agent 修复的有效 non-blocking：`.dockerignore` 排除 `seed`/`backend`；新增 `infra/staging/wechat-login.override.yml` + runbook §5 可执行扫码路径（解除 AC#5 落地阻塞）；docs/08 §4 变量名改 `PI_BASE_URL`/`PI_API_KEY`，`.env.example` 补 `WECHAT_SITE_URL` 与宿主机 `DATABASE_URL`；sidecar 镜像钉 `1.7.0@sha256:4723fcbb...`。

### 仍阻塞（真实外部验收，必须真实凭据与实际输出）

- 用户需把真实值放入 `infra/.env`（本仓库不提交、不输出）：`BOCHA_API_KEY`；`PI_BASE_URL`、`PI_API_KEY`、`LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL`；`WECHAT_MCP_TOKEN`（sidecar `MCP_TOKEN` 同值）与 sidecar 扫码登录得到的已订阅 fakeid；`BACKUP_AGE_RECIPIENT`、`BACKUP_AGE_IDENTITY`、`BACKUP_SSH_HOST`、`BACKUP_SSH_USER`、`BACKUP_SSH_PATH`、`BACKUP_SSH_KEY_PATH`、`BACKUP_RETENTION_DAYS`；`PUBLIC_DOMAIN`。
- 真实人员名单需放到 `seed/company-people.json`（当前仓库只有 example；缺失时 API 启动即失败，属预期诚实失败）。
- 真实合法 `warmap-transcript.v1` 与参与人 personId 需由项目方提供。
- 以上到齐后按 `infra/staging/runbook.md` §6/§7 逐项执行；未完成前 Ticket 16 保持 `claimed`，不标 `resolved`，也不发送完成信号。
- 已知实现边界：Radar 来源（sites/wechatAccounts）目前无 Action 面（Ticket 06 已记录），staging 验收前用 runbook §5 的 SQL 写入 `radar_config.sources`。
