# 02: 建立可登录的 Monorepo 纵向骨架

Type: implementation
Status: resolved
Blocked by: None (can start immediately)

## What to build

建立从 Caddy、Web、API 到 PostgreSQL 的最小可运行纵向链。CEO 通过统一 HTTPS 入口登录后，Web 使用 OpenAPI 生成客户端读取并渲染一张后端 fixture Card。

## Acceptance criteria

- [x] Web、API 与共享 contracts 可独立构建，Web 不包含业务 API handler。
- [x] Caddy 是唯一暴露公网端口的服务，正确转发 Web、API、MCP 路径、SSE 和 multipart 请求。
- [x] PostgreSQL 空库可以按顺序 migration，所有存储时间使用 UTC。
- [x] CEO 登录签发 HttpOnly、Secure、SameSite cookie；未登录访问业务 Card 被拒绝。
- [x] 服务身份与 CEO session 使用不同凭据和鉴权边界。
- [x] Card envelope、错误 envelope、ActionDescriptor 和版本冲突响应由 TypeBox 定义并生成 OpenAPI 客户端。
- [x] CEO 登录后可在新 Web 看到后端 fixture Card；GET 与 health 不产生写入或外部调用。
- [x] Action 入口具备确定性 actionId、fingerprint 优先幂等返回、再校验 version 的基础执行顺序，且不建立 Action 实体。

## Comments

- 结构：根 pnpm workspace + `packages/contracts`（TypeBox schema、OpenAPI 生成入口）+ `apps/api`（Fastify、migration、auth、fixture Card、Action executor、服务身份 stub）+ `apps/web`（Next.js，openapi-typescript 生成类型 + openapi-fetch，kind→renderer registry，无任何业务 route handler）+ `infra/`（Caddyfile、docker-compose、verify.sh）。
- 鉴权：HMAC session cookie（HttpOnly/Secure/SameSite=Strict）、scrypt 密码散列 constant-time 校验、登录按 IP 限速、写请求校验 Origin；`DRI_SERVICE_TOKEN` 与 `COMPANY_MEMORY_MCP_TOKEN` 为独立 bearer 边界（未授权 401，已授权 501 stub，真实实现分别在 Ticket 03/07）。
- Action：actionId 为确定性 HMAC token（actionType+object+version+itemId，无随机 nonce）；fingerprint = HMAC(actionId+规范化 input)；执行顺序为行锁 → fingerprint 命中直接返回当前 Card → 未命中才校验 version（409 + latestCard）→ 显式 UPDATE 并记录 fingerprint，事务提交。fingerprint 存于 `fixture_home.notice_fingerprint`（所属业务效果上），无 Action 表。
- 验证证据：
  - contracts 6 tests（OpenAPI 契约 + envelope schema）、api 14 tests（空库 migration 幂等/UTC、登录→Card 旅程、cookie flags、Origin、限速、GET 无写入、logout、服务边界、actionId 确定性、执行/重放幂等/409 latestCard、防伪）。
  - `infra/caddy/verify.sh`：/ → web、/api/* 与 /mcp/* → api、multipart 透传、SSE 流式不缓冲（stub + docker caddy 可重复执行）；生产 Caddyfile `caddy validate` 通过。
  - Compose 全栈 E2E：仅 edge 暴露 80/443；经 Caddy 登录拿 cookie → fixture Card → Action v1→v2 → 重放幂等 → 不同 input 409+latestCard → 未登录 401/307 跳登录页；真实浏览器旅程（chrome-devtools）：登录页 → 登录 → 渲染 fixture Card → 点击 Action 后版本与 dismissed 状态刷新 → logout 回登录页。
- 实现取舍（记录给后续 ticket）：
  - API 生产运行用 tsx 直接跑 TS（contracts 以 TS 源导出，省去跨包 dist 编排）；ticket 16 精简镜像时可再评估。
  - fixture Card 目前是首页唯一来源；`production 禁止启用 fixture` 的环境门控留到 ticket 16/18 部署落地时处理。
  - 登录限速为进程内计数器（单进程 MVP 足够，代码内有 ponytail 注释）。
  - API/迁移测试需要 PostgreSQL：`TEST_PG_URL`（默认 `localhost:54329`，本机已有 `warmap-pg` 容器）；集成环境用 `infra/.env`（模板见根 `.env.example`）。
