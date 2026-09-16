# Ticket 16 · 可执行部分验证证据与阻塞

基线 `main=5b8df54`；本文件只记录实际执行过的命令与结果，未执行的项一律列在「仍阻塞」。

## 1. Provider 决策纠正（可执行，已完成）

- Web Search 唯一实现为博查：`apps/api/src/webSearch.ts` `createBochaWebSearchAdapter`；`radarSources.ts` 的 `createBochaRadarWebAdapter` 复用同一客户端。
- 删除 Brave/`SEARCH_API_KEY` 路径；`BOCHA_API_KEY` 缺失时 `search()` 明确失败、Radar Card 与 health 如实显示未配置。
- 公众号只经 `tmwgsicp/wechat-download-api` 独立 AGPL sidecar 的 MCP（`WECHAT_MCP_URL`/`WECHAT_MCP_TOKEN`），账号级 `list_subscriptions` → `get_recent_articles(source_id=fakeid)` → 摘要缺失时 `read_article`；未订阅账号明确失败，不退回关键词或 `site:mp.weixin.qq.com`。
- 不 vendor 其源码；WarMap 不接触微信 Cookie；sidecar 只在内网、不经 Caddy。

### 对真实 Docker 镜像/MCP 契约的核对（已实际执行）

镜像 `tmwgsicp/wechat-download-api:1.7.0`（digest `sha256:4723fcbbda1e...`）本地起容器 + `MCP_RESOURCE_URL=http://wechat:5000/mcp`：

- `/api/health` → `{"status":"healthy",...}`。
- `POST /mcp` 无 Bearer → `401`；带 `Host: wechat:5000` 与正确 Token → `200`（证明 DNS-rebinding 白名单需与 API 访问 Host 一致）。
- 用 `@modelcontextprotocol/sdk` 真实握手 `tools/list` 得到 6 个工具：`list_subscriptions/search_accounts/get_recent_articles/read_article/subscribe_account/unsubscribe_account`。
- 真实调用返回形状：`list_subscriptions` → `structuredContent.result`；`get_recent_articles` → `content[0].text` JSON `{articles,next_since}`；`read_article` 缺正文时 `isError=true`（adapter 已处理）。
- 用真实 `createWechatMcpAdapter` 走真实 MCP 客户端调用：`list_subscriptions` 为空 → 如实拒绝 `账号 not-subscribed 不在公众号 sidecar 订阅列表`（证明真实链路可达，未伪造文章）。

## 2. Compose / 镜像（已执行）

- `docker compose -f infra/docker-compose.yml --env-file <dummy> config`：仅 `edge` 发布 80/443；`wechat` 无 `ports`、固定 tag `1.7.0`；服务集合为 `api/edge/postgres/web/wechat`，无 Redis/队列/对象存储/K8s。
- `docker compose build api web` 成功；`docker run --entrypoint sh` 实测 `uid=1000(node)`；镜像内固定 `pnpm@11.20.0`（不再运行时下载任意 pnpm 版本）。
- `bash infra/caddy/verify.sh`：`/`、`/api/*`、`/api/healthz`、`/mcp/*`、multipart、SSE 全通过。
- `apps/api/test/deployment.test.ts`：12 项（Compose 边界、镜像非 root、脚本安全边界、smoke dry-run）。
- `docker compose config` 未验证真实 TLS 证书签发（需真实域名/80/443 可达，属真实 staging，见「仍阻塞」）。

## 3. 备份/恢复脚本（本地真实往返 + 源模式单测）

方案 A（Ticket 16 后续）：默认 `BACKUP_SOURCE_MODE=compose`；PostgreSQL 继续只在 Compose 内网且**从不映射端口**，宿主机 cron 经 `docker compose exec -T postgres pg_dump/psql` 在容器内 dump/查 schema；脚本不读取/拼接/打印 `POSTGRES_PASSWORD`。显式 `BACKUP_SOURCE_MODE=url` 才要求 `DATABASE_URL` 与宿主 `pg_dump`/`psql`（libpq keg-only 仅 url/restore 需要）。未引入通用 adapter。

- `backup.sh --dry-run`：报告 source mode、将执行的 dump/schema 命令与远端流程，零写入；仍校验 age/SSH 配置。
- 早前本地真实往返（用注入的容器化 `pg_dump`/`age`/`pg_restore` 与本地目录 stub 代替异机）已跑通：dump → 非空校验 → `age -r` 加密（产物头 `age-encryption.org/v1`）→ `.sha256` + `.meta.json`（含 schema=12）→ 复制到「异机」目录 → 保留策略 → 删除本机明文。该轮用的是显式 url/注入模式；默认 compose 模式由单测覆盖命令形状。
- `restore.sh`（默认 dry-run）：checksum 校验、生产 `DATABASE_URL` 保护、空库检查；`--execute` 解密并 `pg_restore`，恢复后抽查 `conversations=1 messages=1 pi_entries=1`；对已有表的库如实拒绝。
- 安全/命令形状单测（`apps/api/test/deployment.test.ts`，17 项）：compose 模式命令形状与“无 DATABASE_URL”；容器内 `pg_dump -U warmap -d warmap --format=custom --no-owner --no-privileges` + `psql` 读 schema；`POSTGRES_PASSWORD` 不出现在 stdout/stderr/docker 参数；url 模式兼容且缺 `DATABASE_URL` 时失败；dry-run 零写入；缺配置、保留 <7 天、checksum 不符、目标=生产库、非空库均拒绝。
- AC9 本机独立恢复演练已通过（专用临时 source + 独立空 target，真实 pg_dump→age→checksum→restore `--execute`，六实体/Transcript/messages/Pi entries counts 一致，target 上继续一次对象 Conversation `messages 1→3`、`pi_entries 0→5`，临时资源全销毁）；完整记录见 `real-provider-acceptance.md` 的 AC9 节。

## 4. 确定性门槛（已执行）

- `pnpm test`：contracts 26、apps/web 9、apps/api 227。
- `pnpm typecheck`、`pnpm build` 通过。
- `pnpm --filter @warmap/web gen:client` + `git diff --exit-code -- apps/web/src/lib/api` 无漂移。
- `/api/healthz` 经 Caddy 的 `/api/*` 直达 API（不经 Web rewrite），供公网 smoke 使用。

## 5. 仍阻塞（缺真实凭据/外部资源，未勾选）

| 验收项 | 需要的真实输入 | 放置位置 |
|---|---|---|
| 真实 Bocha query + Pi 自主 Tool loop | `BOCHA_API_KEY` | `infra/.env` |
| light/heavy/compaction 三槽位真实调用 | `PI_BASE_URL`、`PI_API_KEY`、`LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL` | `infra/.env` |
| 公众号账号级文章拉取 | sidecar 扫码登录（微信 Cookie 仅存 sidecar 卷）+ `WECHAT_MCP_TOKEN` + Radar 已订阅 fakeid | `infra/.env` / sidecar 登录页 |
| 真实人员 seed | 项目授权人 `company-people.v1` 名单 | `seed/company-people.json`（当前只有 example，缺失时 API 启动即失败） |
| 真实 Transcript 导入 + Outcome | 合法 `warmap-transcript.v1` 文件与参与人 personId | 运行 `infra/staging/smoke.sh` 后按 runbook §7 |
| 异机加密备份 + 真实恢复并续接 Conversation | 真实 SSH/SFTP 主机、SSH 私钥、age 公私钥、真实 `DATABASE_URL` | `infra/.env` |
| Caddy 真实 TLS 签发的 staging 域名 | 公网 80/443 可达域名 | `PUBLIC_DOMAIN` |

未收到上述真实值前，Ticket 16 保持 `claimed`，不写入 `resolved`，也不向 Master 发送完成信号。

## 6. 内部评审（Herdr · pi/deepseek-flash 只读）

- 命令：`herdr agent start t16-reviewer --kind pi --pane wH:p2 -- --provider deepseek --model deepseek-flash --exclude-tools edit,write`，提示要求只读、按 Standards/Spec 双轴给结论。
- 结论：Axis A green（无 blocking）、Axis B green（无过度声明）；确认无伪造通过、无隐藏 secret、未引入新依赖/额外基础设施，博查唯一、公众号严格账号级 MCP（用真实镜像源码逐条核对工具签名）、Caddy 唯一公网且直透、migration 前置于 listen 且无自动回滚、备份/恢复六要素齐备；票据正确保持 claimed。
- 主 agent 已修复的有效 non-blocking：
  - A1：`.dockerignore` 增加 `seed`、`backend`，真实人员名单/认知不再进入构建上下文。
  - A2：新增 `infra/staging/wechat-login.override.yml`（仅把扫码页绑到 127.0.0.1），runbook §5 给出可执行的扫码路径，解除 AC#5 的落地阻塞。
  - A3：docs/08 §4 的 `MODEL_BASE_URL/MODEL_API_KEY` 改为真实变量 `PI_BASE_URL/PI_API_KEY`；`.env.example` 补 `WECHAT_SITE_URL` 与宿主机备份用 `DATABASE_URL`。
  - A4：sidecar 镜像改为 `1.7.0@sha256:4723fcbbda1e...`，避免 tag 重推静默换代码。
- 未采纳/保留：A6（health search 与 Pi search 同源构造，保持现状）、A7（未单独落 ADR，决策已在 ticket Comments 与 docs/08）、B3（每次 tool 调用新建 MCP client，MVP 可接受）、B8（06 号历史票据描述不回改）。
