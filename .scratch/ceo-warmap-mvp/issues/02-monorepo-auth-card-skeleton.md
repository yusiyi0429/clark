# 02: 建立可登录的 Monorepo 纵向骨架

Type: implementation
Status: ready-for-agent
Blocked by: None (can start immediately)

## What to build

建立从 Caddy、Web、API 到 PostgreSQL 的最小可运行纵向链。CEO 通过统一 HTTPS 入口登录后，Web 使用 OpenAPI 生成客户端读取并渲染一张后端 fixture Card。

## Acceptance criteria

- [ ] Web、API 与共享 contracts 可独立构建，Web 不包含业务 API handler。
- [ ] Caddy 是唯一暴露公网端口的服务，正确转发 Web、API、MCP 路径、SSE 和 multipart 请求。
- [ ] PostgreSQL 空库可以按顺序 migration，所有存储时间使用 UTC。
- [ ] CEO 登录签发 HttpOnly、Secure、SameSite cookie；未登录访问业务 Card 被拒绝。
- [ ] 服务身份与 CEO session 使用不同凭据和鉴权边界。
- [ ] Card envelope、错误 envelope、ActionDescriptor 和版本冲突响应由 TypeBox 定义并生成 OpenAPI 客户端。
- [ ] CEO 登录后可在新 Web 看到后端 fixture Card；GET 与 health 不产生写入或外部调用。
- [ ] Action 入口具备确定性 actionId、fingerprint 优先幂等返回、再校验 version 的基础执行顺序，且不建立 Action 实体。

## Comments
