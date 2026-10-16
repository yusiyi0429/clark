# AI 工具连接（OAuth）

默认使用远程 MCP + 浏览器授权，个人令牌作为备用。首次引导和账号菜单共用连接页面。

## 使用

Codex CLI：

```sh
codex mcp add tianshu --url https://你的天枢域名/mcp/me
codex mcp login tianshu
```

Claude Code：

```sh
claude mcp add --transport http --scope user tianshu https://你的天枢域名/mcp/me
claude mcp login tianshu
```

旧版本 Claude Code 可在会话中输入 `/mcp` 并选择登录。只支持回调到本机的工具（Codex、Claude Code 等命令行和读同一份配置的客户端）；Claude 网页版/桌面版连接器回调到 claude.ai，需要时再把其官方回调加入白名单。

已有 `tianshu` 配置时更新地址、移除旧的 `Authorization` 请求头，再登录；静态 Bearer 请求头会覆盖 OAuth。保留其他服务配置。

用户在浏览器登录天枢并确认账号、权限和连接名称。工具完成令牌交换后调用 `list_my_items`（成员）或 `list_pending`（CEO）验证。页面分别显示“已允许连接，等待工具完成验证”和“已连上天枢”。

## 部署

API 启动应用尚未执行的迁移，其中包含 `055_mcp_oauth.sql`。既有个人令牌保持有效。更新 API、Web 和 Caddy；Caddy 新增 `/.well-known/oauth-*` 到 API 的分流。宿主 Nginx 仍转发整个域名到 Caddy。

`PUBLIC_ORIGIN` 必须是用户实际访问的 HTTPS origin；本地开发可使用 HTTP 的 `localhost`、`127.0.0.1` 或 `::1`。连接页面优先使用 API 返回的 canonical MCP URL，确保 OAuth 的 resource 与发现元数据一致。Next 开发环境会代理 `/api/*`、`/mcp/*` 和 `/.well-known/*`。

部署后先检查：

- `/.well-known/oauth-protected-resource/mcp/me` 返回正确的 resource 与授权服务器。
- `/.well-known/oauth-authorization-server` 返回同一 issuer 和可访问的注册、授权、令牌、撤销端点。
- 无凭据访问 `/mcp/me` 返回 401 和带 resource metadata 的 `WWW-Authenticate`。
- 从实际 Codex、Claude Code 发起登录、完成浏览器确认，并调用工具验证；撤销后访问和续期均失败。

## 实现边界

- 首版支持公共客户端的动态注册（DCR），使用 MCP SDK 的客户端元数据和回环回调校验。回调只接受 `localhost`、`127.0.0.1`、`[::1]`：注册无需鉴权，放行任意 HTTPS 会让冒名客户端把授权码送到外部服务器。不声明 CIMD 支持，也不会抓取客户端提供的远程元数据。
- 仅支持授权码 + S256 PKCE。请求有效期 10 分钟，授权码有效期 60 秒并且只能交换一次。
- 访问令牌有效期 15 分钟；连接最长 90 天。刷新令牌每次使用后轮换，重放会撤销整条连接。
- 服务端只保存授权码和令牌的 HMAC 摘要。客户端按自己的凭据存储策略保管凭据。
- 请求、授权码、令牌都绑定客户端、回调和 MCP resource；回调包含 issuer 和原始 state。浏览器确认必须通过现有登录、同源检查和与账号绑定的 CSRF 校验。
- `tianshu:read` / `tianshu:write` 控制读写能力；既有个人身份和对象权限继续生效。只读授权不列出写工具，直接写入请求返回 403 与 scope challenge。
- 授权连接沿用 `personal_tokens` 的稳定连接 ID，进展来源、审计、数量限制和账号菜单撤销继续复用。同一人再次授权同名连接时撤销旧的那个，重新登录不会堆到 5 个上限；多台设备用不同名字区分。修改口令使既有 OAuth 连接失效。
- 连接不会创建每周同步任务。自动同步仍需独立设置，本机调度的补跑、同步结果回执与主动失败提醒不属于这次连接改动。

## 验证

`apps/api/test/mcpOAuth.test.ts` 覆盖发现、注册、PKCE、浏览器确认、拒绝授权、身份和 scope 隔离、读取/写入、过期、刷新轮换与重放、口令重置、撤销、连接数量限制，以及官方 MCP SDK 客户端的完整授权和续期。

前端覆盖默认 OAuth / PAT 备用切换、无秘密的连接说明，以及两种身份登录后返回授权页。历史浏览器验收使用隔离测试数据库，检查桌面和 390px 手机授权页，并走通真实登录、授权回调与首次 MCP 调用。
