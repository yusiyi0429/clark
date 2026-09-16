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
- [x] 一个真实 Web Search query 返回 title、URL、excerpt，并由 Pi 完成一次自主 Tool loop。
- [ ] 一个真实公众号账号按账号拉取文章并进入同一 Signal 管线，不以站点关键词搜索替代。
- [x] light、heavy、compaction 模型槽位和合法 Transcript 各完成一次真实验收。
- [x] CompanyMemory MCP 装载真实人员 seed，Pi 与独立客户端得到一致稳定 personId。
- [ ] 宿主机 cron 生成 age 加密 pg_dump、校验 checksum、经 SSH/SFTP 复制异机并保留至少 7 天。
- [ ] 独立 restore 流程恢复到空 PostgreSQL，不覆盖现有库；恢复后抽查六实体、Transcript、消息和 Pi entries，并继续一次 Conversation。
- [x] staging smoke、回滚步骤和发布观察清单完成；未引入 Redis、队列、对象存储、Kubernetes或额外 Runtime。

> AC6 provenance：light/heavy/compaction 三槽位为真实最小调用（`gpt-5.6-terra/sol/luna`）；Transcript 半边用的是脚本内自造的 schema 合法样例（example seed 的 personId），过 `Value.Check`+`validateTranscript` 后直调 `createPostMeetingAgent` seam，**未经 multipart 导入端点、也不是项目方真实会议稿**。该项按用户授权的“example seed 可验证模型/Transcript 链”口径成立；真实会议稿导入仍需提供（现有 API 测试覆盖导入端点本身）。

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

### 内部评审（增量 · Herdr · deepseek-flash 只读）

- 针对 `6619c39` 以来的新增（验收脚本、override 端口、runbook、证据、勾选）重审：Axis A green；Axis B 首轮 red，唯一 blocking 为 AC6 Transcript 半边未标注 provenance。
- 修复：evidence/ticket/runbook 显式标注 Transcript provenance；`webSearch.ts` 错误体按已知 key 精确抹除；验收脚本改为先按已知 secret 精确 redact 再长度兜底并剥离控制字符；runbook §7 指向验收脚本；`.env.example` 补 `WECHAT_LOGIN_PORT`。保留 non-blocking：Bocha 预算为单次进程；验收脚本不在 `pnpm typecheck` 的 `src` 范围。

### 真实外部验收（2026-09-16，脱敏证据见 `.scratch/ceo-warmap-mvp/evidence/ticket16/real-provider-acceptance.md`）

- 可重复执行入口：`apps/api/scripts/real-acceptance.ts`（失败即停、不重试、打印前 redact；`--only=<step>` 用于修复脚本 bug 后单步复跑）。
- AC4 已实测：Bocha 1 次真实 query 返回 19 条含 title/URL/excerpt（ms=296）；Pi 自主 `web_search` 一次 started+completed（isError=false），Bocha 累计 2/3 次上限内。
- AC6 已实测：light=`gpt-5.6-terra`(17 tok)/heavy=`gpt-5.6-sol`(17 tok)/compaction=`gpt-5.6-luna`(34 tok) 各 1 次最小调用成功；schema 合法 `warmap-transcript.v1`（2 turns，脚本自造 example personId）整份校验通过并经 heavy 抽取 `PostMeetingCandidate` items=2（1174 tok）。无自动重试、无换档。（provenance 见 AC6 下注。）
- 第 4 步首次执行在发出模型请求前因脚本缺临时库 migration 失败（`agent_runs` 不存在，0 次模型调用），修脚本后仅复跑一次成功。
- 公众号 sidecar：`docker compose -f infra/docker-compose.yml -f infra/staging/wechat-login.override.yml up -d wechat` 后 `/api/health`=200、`/mcp` 无 Token=401、带 Token `initialize`=200；数据卷仅新 `rss.db`、无凭证 → **等待管理员扫码**。本机扫码 URL：`http://127.0.0.1:15000/login.html`；未调用任何账号级工具、未模拟订阅、未用关键词替代。
- `infra/staging/wechat-login.override.yml` 宿主端口改为 `${WECHAT_LOGIN_PORT:-15000}`（避开 macOS AirPlay 占用的 5000），runbook §5 同步。

### AC5 公众号尝试（2026-09-16，BLOCKED，未勾选）

- 管理员扫码后：MCP `search_accounts("量子位")` ×1 → 唯一精确项 nickname=`量子位`/alias=`QbitAI`（masked fakeid `MzIz...Mw==`）；MCP `subscribe_account` ×1 `success=true`；MCP `list_subscriptions` ×1 订阅数=1 且目标存在；MCP `get_recent_articles(limit=1)` ×1 → **articles=0**；未调用 `read_article`。
- 侧车文档化的首次订阅立即拉取 `POST /api/rss/poll` ×1 返回 success，但侧车日志显示 WeChat 文章列表接口 `ret=200013 err_msg='freq control'`（微信频控），未写入任何文章；`subscriptions=1`、`articles=0`。
- 未重试、未换号、未用关键词/site 搜索、未改生产语义；Radar→Candidate→Signal 管线因无来源未执行。AC5 保持未勾，等频控解除/配 `PROXY_URLS` 后从 `get_recent_articles` 重验。
- 收尾：`docker compose -f infra/docker-compose.yml up -d --force-recreate wechat` 撤销 15000 宿主端口（PORTS 仅 `5000/tcp`），容器 healthy，`wechat_data` 卷未删且重建后仍 `logged_in=true`。
- 方案 B 代理重试（仅一次）：worktree `infra/.env` 配 `WECHAT_PROXY_URLS`（值不输出），`.env.example` 新增可选 `WECHAT_PROXY_URLS`，compose 给 wechat 传 `PROXY_URLS` 并加 `host.docker.internal:host-gateway`，runbook §5 同步；重建后容器内 `PROXY_URLS` configured 且经代理 HTTPS → ok。临时回环 override 后只触发 `POST /api/rss/poll` 一次、只调 `get_recent_articles(limit=1)` 一次 → `isError=false, articles=0`；侧车日志仍 `ret=200013 err_msg='freq control'`（登录态维度频控，换出口 IP 未绕过）。按规则停止，未再重试；`read_article` 0 次、Radar 管线未执行、0 次模型调用；再次 base compose force-recreate 撤回宿主端口。

### AC7 真实人员 seed 验收（2026-09-16，通过）

- 真实 seed `seed/company-people.json`（8 人，唯一 CEO 1 人、7 人 dri+participant，唯一 ID/姓名），不使用 example。
- 临时独立 MCP 服务（同一 `createCompanyMemoryMcpSession`/`loadCompanyMemory` repository）+ 独立 Streamable HTTP 客户端 `search_people({})`：count=8、roles `{ceo:1,dri:7,participant:7}`、idSetSha256=`fe3d9805...`。
- 真实 Pi runtime（当前 light 槽位，`runtime.run()` 1 次、无重试）：tool 事件 `search_people` started+completed（isError=false）；从工具结果回算唯一 personId=8、idSetSha256 与独立客户端完全一致；tokens in=3 out=55 total=1547、ms=6207。
- 只读验证：MCP 无写工具、seed 哈希验收前后一致、未写业务事实。证据只存 count/hash/角色统计/tool 事件/耗时/usage，不含姓名/完整 personId。
- 工具口径：实际只读工具集无 `list_people`，“读取完整目录”为 `search_people`（query 缺省返回全部），角色筛在客户端侧；一次 tool loop 需 2 次模型响应（工具调用+收尾），已如实记录。

### 仍阻塞（真实外部验收，必须真实凭据与实际输出）

- 已 SET 并已用于真实验收：`BOCHA_API_KEY`、`PI_BASE_URL`、`PI_API_KEY`、`LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL`、`WECHAT_MCP_TOKEN`、`WECHAT_MCP_URL`（已规范为 `http://wechat:5000/mcp`）、`WECHAT_SITE_URL`。
- AC5 公众号：侧车已登录且已订阅 `量子位/QbitAI`；直连与经 SOCKS5 代理均被微信频控（`ret=200013 freq control`），`articles=0`；需等账号频控自然解除后再拉取，再跑账号级 `get_recent_articles` → Radar 管线（1 篇、1 次 light 候选）。
- AC8/AC9 异机备份与恢复：需 `BACKUP_AGE_RECIPIENT`、`BACKUP_AGE_IDENTITY`、`BACKUP_SSH_HOST`、`BACKUP_SSH_USER`、`BACKUP_SSH_PATH`、`BACKUP_SSH_KEY_PATH`、`BACKUP_RETENTION_DAYS` 与真实异机目标（脚本本地真实往返已在 `verification.md` §3 验证）。
- AC1 真实 TLS 签发需可解析的 staging 域名与公网 80/443（当前 `PUBLIC_DOMAIN=localhost` 仅验证配置与路由）。
- 以上到齐后按 `infra/staging/runbook.md` §6/§7 逐项执行；未完成前 Ticket 16 保持 `claimed`，不标 `resolved`，也不发送完成信号。
- 已知实现边界：Radar 来源（sites/wechatAccounts）目前无 Action 面（Ticket 06 已记录），staging 验收前用 runbook §5 的 SQL 写入 `radar_config.sources`。
