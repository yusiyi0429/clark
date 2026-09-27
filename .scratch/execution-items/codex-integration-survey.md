# Codex／Claude Code 同步天枢执行事项：只读调研与方案草图

调研日期：2026-09-27；范围：本机 CLI 帮助、仓库现状、官方文档。本文是方案，未实施连接或修改配置。
证据写法：`路径:行号` 指本仓库；外链指官方文档；`命令输出` 指本机只读命令。

## 1. Codex CLI 与外部 MCP

- 本机版本为 `codex-cli 0.156.1`。【依据：本机 `codex --version` 输出】
- 本机 `codex mcp add` 需要服务器名以及 `--url <URL>` 或 `-- <COMMAND>...` 二选一。【依据：本机 `codex mcp add --help` 输出】
- `-- <COMMAND>...` 启动本机 stdio 服务；`--env KEY=VALUE` 只适用于 stdio。【依据：本机 `codex mcp add --help` 输出；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- `--url` 连接 streamable HTTP；`--bearer-token-env-var` 只适用于 HTTP，值是环境变量名而非令牌本身。【依据：本机 `codex mcp add --help` 输出】
- 下面只是将来配置示意，不是本次执行的命令。【依据：本机 `codex mcp add --help` 输出】

```text
codex mcp add tianshu --url https://tianshu.example.com/mcp/me --bearer-token-env-var TIANSHU_MCP_TOKEN
codex mcp add tianshu-local --env TIANSHU_MCP_TOKEN=... -- node path/to/stdio-bridge.js
```

- stdio 桥接器需自己负责到天枢的网络请求；当前仓库只实现 HTTP 服务端，没有此桥接器。【依据：`apps/api/src/mcpCompanyMemory.ts:78-88`；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- 手写用户级 `~/.codex/config.toml` 可用 `command`、`args`、`env_vars`、`cwd` 指定 stdio 服务。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- `env_vars` 把 Codex 进程环境中的指定变量传给 stdio 子进程；`[...env]` 可写固定值，但不应把个人令牌写入仓库配置。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)】

```toml
[mcp_servers.tianshu_local]
command = "node"
args = ["path/to/stdio-bridge.js"]
env_vars = ["TIANSHU_MCP_TOKEN"]
```

- HTTP 写法使用 `url` 和 `bearer_token_env_var`；Codex 会把变量值用于 `Authorization: Bearer ...`。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)】

```toml
[mcp_servers.tianshu]
url = "https://tianshu.example.com/mcp/me"
bearer_token_env_var = "TIANSHU_MCP_TOKEN"
```

- `http_headers` 可设固定请求头，`env_http_headers` 可从环境变量取其他头；令牌优先用 bearer 环境变量，避免明文固定头。【依据：[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)】
- MCP OAuth 需服务端提供发现元数据、授权码与 PKCE 等协议能力；个人令牌端点自身不会因 `codex mcp login` 自动变成 OAuth。【依据：[OpenAI MCP 鉴权文档](https://developers.openai.com/plugins/build/auth)；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- 服务端具备 OAuth 后，用 `codex mcp login tianshu` 登录；本机帮助另支持 `--no-browser`、`--scopes`、`--oauth-client-registration AUTO|CIMD|DCR`。【依据：本机 `codex mcp login --help` 输出】
- `codex mcp add --help` 也列出 `--oauth-client-id`、`--oauth-client-registration`、`--oauth-resource`，注册策略只作用于即时登录。【依据：本机命令输出；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- 用户级或可信项目级 `.codex/config.toml` 可配 MCP；CLI、IDE 插件和同一宿主的 ChatGPT 桌面 Codex 共享配置。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；[配置基础](https://learn.chatgpt.com/docs/config-file/config-basic)】
- Codex 云端在独立容器和环境中运行，不能假定会读开发者电脑的 `~/.codex/config.toml` 或本机环境变量；需在云端环境另行配置可达端点与凭据。【依据：[云端环境文档](https://learn.chatgpt.com/docs/environments/cloud-environment)；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；据运行位置推导】
- 云端环境的普通环境变量贯穿任务，`secrets` 只在 setup 阶段可用且随后移除；个人 bearer 方案在云端需单独评估令牌如何进入代理阶段。【依据：[云端环境文档](https://learn.chatgpt.com/docs/environments/cloud-environment)】
- ChatGPT Web 也不读取本地 Codex 配置；若未来要接 Web，需要其插件／连接方式单独部署与授权。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】

## 2. 一轮结束与任务完成的钩子

- `notify = ["python3", "/path/to/notify.py"]` 会在受支持事件调用外部程序；当前只有 `agent-turn-complete`。【依据：[Codex 高级配置：Notifications](https://learn.chatgpt.com/docs/config-file/config-advanced)】
- `notify` 收到单个 JSON 命令行参数，含 `type`、`thread-id`、`turn-id`、`cwd`、`input-messages`、`last-assistant-message`。【依据：[Codex 高级配置：Notifications](https://learn.chatgpt.com/docs/config-file/config-advanced)】
- 它适合在每轮结束后触发轻量上报，但“轮结束”不等于事项完成；必须由明确的事项编号和用户确认／语义判断确定要写什么。【依据：[Codex 高级配置：Notifications](https://learn.chatgpt.com/docs/config-file/config-advanced)；据事件定义推导】
- `notify` 是宿主外部命令，项目级 `.codex/config.toml` 中该键被忽略；不能靠提交项目配置让全员自动运行。【依据：[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；[高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced)】
- hooks 可放 `~/.codex/hooks.json`、可信项目的 `.codex/hooks.json` 或 `config.toml`；可用 `command` 或 `mcp_tool` 处理器。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)】
- `Stop` 是主线程一次回复停止时的钩子，事件含 `turn_id`、`last_assistant_message`、`stop_hook_active`；可运行命令或调用已连接 MCP 工具。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)】
- `SessionEnd` 在主会话关闭、归档、删除或闲置后触发，切走会话不会立即触发；因此不适合实时进展同步。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)】
- `PostToolUse` 可观测工具调用，但一次任务会有多次工具事件，适合辅助采集而非认定“任务完成”。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)；据事件粒度推导】
- hooks 的非托管定义须经用户检查并信任；变更后重新审查；项目级 hook 仅在可信项目加载。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)】
- hooks 中多个匹配命令会并行启动；`SessionEnd` 默认超时短且只作提示，异步发送可能丢失，必须把幂等与重试放在接收端。【依据：[Codex Hooks 文档](https://learn.chatgpt.com/docs/hooks)；据时序推导】
- `AGENTS.md` 是启动时加载的项目指令，可要求“结束前主动更新天枢”；它不是确定执行的回调，模型可能不调用工具，也不能替代服务端鉴权。【依据：[AGENTS.md 文档](https://learn.chatgpt.com/docs/agent-configuration/agents-md)；[MCP 服务端鉴权文档](https://developers.openai.com/plugins/build/mcp-server)】
- 本仓库仅检到 `apps/web/AGENTS.md`，仓库根没有 `AGENTS.md`；如要通用约定，应另评审根文件，但本次未写。【依据：本机 `rg --files -g 'AGENTS.md'` 输出】
- 建议优先让人／代理显式调用 MCP 写工具；若需自动轮末提醒，再选 `Stop` 或 `notify` 生成待确认摘要，避免把普通轮次误报为完成。【依据：上述事件定义；方案推导】

## 3. Claude Code 连接同一服务

- Claude Code 的远程 HTTP 命令是 `claude mcp add --transport http tianshu https://tianshu.example.com/mcp/me`；可加 `--scope user` 跨项目使用。【依据：[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)；[OpenAI Docs MCP 示例](https://developers.openai.com/learn/docs-mcp)】
- bearer 可在添加命令里用 `--header "Authorization: Bearer ..."`；不要把令牌字面量提交到项目 `.mcp.json`，优先按客户端支持的 OAuth 流程登录。【依据：[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)；[GitHub 凭据安全建议](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)】
- Claude Code 的项目级 `.mcp.json` 与 Codex 的 TOML 不是同一客户端配置；只需共享同一个符合 MCP 的 HTTP URL、工具协议与服务端权限实现。【依据：[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- 若服务器实现标准 OAuth，Claude Code 可在 `/mcp` 走浏览器登录；两端各存自己的凭据，不共享客户端登录态。【依据：[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)；[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)】
- 因当前端点是标准 SDK 的 streamable HTTP，协议层原则上两边可用；当前公司记忆的服务令牌是服务身份，不应发给员工做个人事项写入。【依据：`apps/api/src/mcpCompanyMemory.ts:1-7,78-88`；`apps/api/src/routes/system.ts:38-49`；方案推导】

## 4. MVP 代码现状与个人 MCP 改动面

- 已依赖 `@modelcontextprotocol/sdk`（声明 `^1.30.0`，锁定 `1.30.0`）；服务由低层 `Server` 和 `StreamableHTTPServerTransport` 创建。【依据：`apps/api/package.json:21`；`pnpm-lock.yaml:32-34`；`apps/api/src/mcpCompanyMemory.ts:1-7,30-31,78-87`】
- 传输设置 `sessionIdGenerator: undefined`、`enableJsonResponse: true`，每个 POST 请求创建一次无状态 session，响应关闭时关闭 server。【依据：`apps/api/src/mcpCompanyMemory.ts:26-28,78-88`；`apps/api/src/routes/system.ts:39-49`】
- `/mcp/company-memory` 只有 POST 路由；GET／DELETE 未注册，注释写明交由无状态传输拒绝。【依据：`apps/api/src/routes/system.ts:38-50`】
- 四个工具是 `list_sections`、`search_sections`、`get_passages`、`search_people`，均标记 `readOnlyHint: true`，输入由 TypeBox 校验。【依据：`apps/api/src/mcpCompanyMemory.ts:22-23,33-72`】
- 该端点用 `COMPANY_MEMORY_MCP_TOKEN` 服务令牌，HTTP `Authorization: Bearer` 做定长／常时比较；未解析个人身份。【依据：`apps/api/src/server.ts:39`；`apps/api/src/routes/system.ts:40-41`；`apps/api/src/routes/shared.ts:150-165`】
- 浏览器个人接口通过 session cookie 和同源 Origin 门禁获得 `personId`；直接复用此门禁会让无 cookie 的 Codex／Claude bearer 调用失败。【依据：`apps/api/src/routes/shared.ts:115-138`；`apps/api/src/routes/me.ts:21-23,35-44`；推导】
- `tasks` 含 UUID、version、title、status、owner_id、创建来源、会议来源等；状态仅 `not_started/in_progress/done/returned`。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-29`】
- `task_members` 已有 `owner/collaborator` 角色和 `left_at`，但现有个人列表／状态更新仍只按 `tasks.owner_id` 判断。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:31-39`；`apps/api/src/tasks.ts:99-113`】
- 现有 `/api/me/home` 返回“我负责的执行事项”；`PATCH /api/me/tasks/:id` 只改负责人状态，按 version 冲突返回最新对象。【依据：`apps/api/src/routes/me.ts:15-27,35-44`；`apps/api/src/tasks.ts:110-155`】
- 当前没有执行事项进展日志表／追加接口／子事项接口；卡片只显示状态、截止、来源与退回原因。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-39`；`apps/api/src/routes/me.ts:21-44`；`apps/web/src/components/member/MemberTasks.tsx:76-103`】
- 要加个人端点，新增令牌表和生成／列出／撤销 API，以当前登录人员绑定 token；该 API 属于 `routes/me.ts` 或独立个人集成路由。【依据：`apps/api/src/routes/me.ts:12-44`；`apps/api/src/routes/shared.ts:131-138`；方案推导】
- 新增 bearer 门禁：读 `Authorization`，查 token 散列、到期／撤销状态和人员目录，得到 `personId`；不要复用服务令牌门禁。【依据：`apps/api/src/routes/shared.ts:115-165`；`apps/api/src/routes/system.ts:38-49`；方案推导】
- 新增个人 MCP server／session 工厂与 `/mcp/me` 路由，沿用 SDK 的 HTTP 处理方式，把验证身份显式传入每个工具处理器。【依据：`apps/api/src/mcpCompanyMemory.ts:30-88`；`apps/api/src/routes/system.ts:38-49`；方案推导】
- 新增服务层调用，而不是从 MCP 内部伪造 cookie 请求；状态更新可复用 `updateMyTaskStatus` 的 owner 锁与 version 逻辑。【依据：`apps/api/src/tasks.ts:110-155`；`apps/api/src/routes/me.ts:35-39`；方案推导】
- 追加进展需要新 `task_progress`／`task_events` 表、审计字段及查询／追加 API；拆分新建需要 parent_id 与新建权限、列表投影和前端展示。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-39`；`packages/contracts/src/tasks.ts:24-55`；方案推导】
- `@fastify/rate-limit` 已注册但非全局；个人 MCP 和令牌创建接口须配置独立限流。【依据：`apps/api/src/app.ts:232-234`；方案推导】

## 5. CI／Git 路线与 MCP 比较

- GitHub webhook 可订阅 `push`、`pull_request` 等事件，或用 Actions 的 `on: push`／`on: pull_request` 运行提取器。【依据：[GitHub Actions 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)】
- 约定显式编号，如 PR 标题或提交正文中的 `TSK-123`，服务端建立编号到 task UUID 的映射；当前任务只有 UUID、无短编号字段。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-29`；方案推导】
- Webhook 入口须用原始请求体验证 `X-Hub-Signature-256`，检查仓库、事件类型、action，并用 `X-GitHub-Delivery` 去重与支持重投。【依据：[GitHub 验签文档](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)；[Webhook 最佳实践](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)】
- 要把 GitHub 活动写进“本人事项”，还需维护 GitHub 账号到天枢 personId 的绑定；提交作者邮箱／PR 作者与实际负责人不能简单等同。【依据：`apps/api/src/tasks.ts:99-113`；[GitHub Actions 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)；方案推导】
- 建议 webhook 只追加带 SHA／PR URL 的“代码活动”记录；除非经负责人确认，不凭合并或提交自动改为 `done`。【依据：`apps/api/src/tasks.ts:116-155`；方案推导】
- Webhook 不依赖开发者安装 MCP，也能覆盖普通 Git／CI；但只能看到已推送代码，无法了解本地探索、受阻、计划和无代码工作。【依据：[GitHub Actions 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)；方案推导】
- MCP 可在工作当时读取本人事项并写结构化进展，能处理未提交工作；代价是每人连接与鉴权、代理误操作控制。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；`apps/api/src/tasks.ts:99-155`；方案推导】
- 两线可共用同一进展表：MCP 记人工／代理叙述，webhook 记可验证代码证据，按 source 与外部事件 ID 幂等。【依据：上述数据和事件结构；方案推导】

## 6. 推荐方案草图

### 身份与凭据

- 第一版采用个人 API 令牌而非完整 OAuth：本人在天枢“账号／集成”页生成，服务器展示一次随机高熵令牌，支持命名、到期、撤销。【依据：`apps/api/src/routes/auth.ts:37-70`；[MCP 鉴权要求](https://developers.openai.com/plugins/build/auth)；方案推导】
- 建议格式 `tsm_<tokenId>_<random>`；数据库保存 tokenId、personId、随机部分的 SHA-256／HMAC 散列、创建时间、最后使用时间、到期与撤销时间，不保存明文。【依据：`apps/api/src/routes/shared.ts:150-165` 的现有 bearer 校验方式；方案推导】
- 令牌以 TLS 传输，日志抹去 Authorization；现有观测代码已有敏感字段名过滤，需在新端点核对原始错误与 MCP tool 参数不回显令牌。【依据：`apps/api/src/observability.ts:7`；[MCP 鉴权要求](https://developers.openai.com/plugins/build/auth)；方案推导】
- 用户撤销后下一次请求即拒绝；停用人员、过期和删除目录成员也拒绝，服务令牌与个人令牌隔离。【依据：`apps/api/src/routes/shared.ts:115-165`；方案推导】
- 第二期如需跨 Codex／Claude／Web 无感登录，再实施 MCP OAuth 2.1 发现、PKCE、scope、refresh／revocation；不能只给 CLI 加 login 命令。【依据：[OpenAI MCP 鉴权文档](https://developers.openai.com/plugins/build/auth)；方案推导】

### MCP 工具契约（草案）

- `list_my_tasks`：输入 `{status?: string[], limit?: number, cursor?: string}`；输出 `{tasks:[{id,version,title,status,dueDate,role,updatedAt}],nextCursor?}`。【依据：`packages/contracts/src/tasks.ts:24-45`；`apps/api/src/tasks.ts:99-103`；方案推导】
- `get_my_task`：输入 `{taskId}`；输出 `{task,progress:[{id,text,createdAt,source}]}`，按当前参与权限返回 404。【依据：`apps/api/src/tasks.ts:110-113`；新进展表方案推导】
- `update_task_status`：输入 `{taskId,version,status}`，只接 `not_started/in_progress/done`；输出 `{task}` 或结构化 `VERSION_CONFLICT` 与 `latestTask`。【依据：`packages/contracts/src/tasks.ts:48-55`；`apps/api/src/routes/me.ts:15-18`】
- `append_task_progress`：输入 `{taskId,text,clientEventId?,sourceUrl?}`；输出 `{progressId,taskId,createdAt}`；限定文本长度，`clientEventId` 对同人同事项幂等。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-39` 无进展字段；方案推导】
- `create_subtask`（第二期）：输入 `{parentTaskId,title,dueDate?,ownerId?}`；输出 `{task}`；第一版只允许自己为 owner，后续再走指派流程。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-39` 无 parent_id；方案推导】
- 写工具带清晰描述与 MCP annotation，状态修改和新建不可标为只读；服务端每次重新检查权限。【依据：`apps/api/src/mcpCompanyMemory.ts:22-23`；[MCP 服务端文档](https://developers.openai.com/plugins/build/mcp-server)】

### 权限、界面、滥用与审计

- 第一版遵守现有 owner 边界：只能列／读／改 `tasks.owner_id = token.personId` 的事项；不能由工具输入 personId 代替令牌身份。【依据：`apps/api/src/tasks.ts:99-113`；方案推导】
- 若以后允许参与者，读取可扩到 `task_members.person_id` 且 `left_at IS NULL`；状态更新和拆分仍建议 owner，协作者仅追加进展，需明确定义权限表。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:31-39`；现有 owner 更新 `apps/api/src/tasks.ts:116-155`；方案推导】
- 进展显示在 `/me` 的执行事项卡片入口和详情时间线，保留状态、来源、截止与更新者；现有 `/me` 只有卡片，详情页尚未实现。【依据：`apps/web/src/components/member/MemberWorkspace.tsx:63-72`；`apps/web/src/components/member/MemberTasks.tsx:76-103`；本机 `rg --files apps/web/src/app | rg 'me|tasks'` 输出】
- 令牌创建、MCP 请求和写工具分别限流；请求体、文本长度、分页、每事项频率设上限，避免无限写入与模型循环。【依据：`apps/api/src/app.ts:232-259`；[MCP 服务端文档](https://developers.openai.com/plugins/build/mcp-server)；方案推导】
- 审计记录 tokenId／personId、tool、taskId、时间、请求 ID、结果、来源，不记录令牌和完整敏感正文；进展记录保留原文并可追溯来源。【依据：`apps/api/src/observability.ts:7`；`apps/api/src/app.ts:225-229`；方案推导】
- 写入使用数据库事务、version 检查或幂等键；同一轮重试、webhook 重投不能生成多条相同进展。【依据：`apps/api/src/tasks.ts:116-145`；[Webhook 最佳实践](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)；方案推导】

### 分期

- 阶段 1：个人令牌生成／撤销与散列存储，`/mcp/me` 的 `list_my_tasks`、`update_task_status`、`append_task_progress`，进展表、本人卡片时间线、审计和限流；只允许 owner。【依据：`apps/api/src/tasks.ts:99-155`；`apps/web/src/components/member/MemberTasks.tsx:76-103`；方案推导】
- 阶段 1 连接文档同时给出 Codex TOML 与 Claude HTTP 命令；让员工明确输入事项 UUID 或从列表选，结束时显式调用追加进展，避免自动推断完成。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)；方案推导】
- 阶段 2：子事项、协作者权限、OAuth、进展聚合摘要与 hook 辅助提醒；单独验证云端环境的网络和凭据路径。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:31-39`；[云端环境文档](https://learn.chatgpt.com/docs/environments/cloud-environment)；方案推导】
- 阶段 3：GitHub webhook／Actions 绑定账号和短编号，追加代码证据；不把 GitHub 事件当作任务完成的充分条件。【依据：[GitHub webhook 文档](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)；方案推导】

## 7. 实施前需要定下的产品语义

- “一轮结束”应解释为 Codex／Claude 当前回答结束，不应自动映射天枢 `done`；事项状态由明确工具调用改变。【依据：[Codex 高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced)；`packages/contracts/src/tasks.ts:5-11`；方案推导】
- “进展”建议是追加记录而非覆盖事项描述；这样可以保留每次工作过程、时间与来源。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:8-25` 现无日志；方案推导】
- 第一版的“完成”只代表负责人在天枢确认已完成；GitHub PR 合并是证据，不能替负责人声明业务验收。【依据：`apps/api/src/tasks.ts:116-155`；[GitHub PR 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)；方案推导】
- 进展文本需包含“做了什么、可验证证据、下一步／阻塞”，但字段可先用单段文字，避免第一版强制模型猜测结构。【依据：现有 `TaskView` 只有状态与标题，`packages/contracts/src/tasks.ts:24-40`；方案推导】
- source 建议枚举 `codex_mcp`、`claude_mcp`、`github_webhook`、`web`，并记录客户端提供的外部引用；来源标签用于界面和审计，不用于决定权限。【依据：`apps/api/src/tasks.ts:110-113`；[GitHub webhook 最佳实践](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)；方案推导】
- 个人 token 只决定访问者身份；MCP 工具的 `taskId` 必须再次按当前数据库 owner／成员关系授权，不能凭“模型已在列表看到”放行。【依据：`apps/api/src/tasks.ts:99-113`；[MCP 服务端文档](https://developers.openai.com/plugins/build/mcp-server)；方案推导】
- 允许协作者追加进展之前，要明确“参与”是否包括历史离开的成员；按现有 `left_at` 字段，应排除已离开者。【依据：`apps/api/migrations/026_tasks_and_notifications.sql:31-39`；方案推导】
- `returned` 已有专用退回接口和原因长度约束，`update_task_status` 不能通过通用状态值进入退回态。【依据：`packages/contracts/src/tasks.ts:48-63`；`apps/api/src/tasks.ts:158-169`】
- 重试冲突时工具应返回最新 version 和状态，并让调用方重新判断；不能静默覆盖他人在网页里的修改。【依据：`apps/api/src/routes/me.ts:15-18`；`apps/api/src/tasks.ts:126-139`；方案推导】
- 列表建议默认只返回未完成、未退回事项，并提供状态过滤查看历史；当前 API 返回全部状态，默认值是新的 MCP 体验决策。【依据：`apps/api/src/tasks.ts:99-103`；方案推导】
- 新 token 管理界面应显示令牌名称、创建／到期／末次使用和撤销按钮，不再展示明文；团队文档要提醒使用者自行安全保存。【依据：个人 token 散列设计；[GitHub 凭据安全建议](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)；方案推导】
- 若公司要求“无法被代理进程读取的凭据”，环境变量 bearer 方案不满足该边界，应选宿主托管 OAuth 或可信代理；云端尤其需要单独验证。【依据：[云端环境文档](https://learn.chatgpt.com/docs/environments/cloud-environment)；[MCP 鉴权文档](https://developers.openai.com/plugins/build/auth)；方案推导】
- 现有 `/mcp/company-memory` 继续作为服务级只读接口；个人端点应使用新路径、新令牌空间和独立工具目录，避免把企业记忆访问权隐式赋给个人 token。【依据：`apps/api/src/routes/system.ts:38-49`；`apps/api/src/mcpCompanyMemory.ts:33-39`；方案推导】
- MCP 错误建议区分未认证、无权／不存在、version 冲突、限流和服务故障；敏感对象使用相同的 404 表现以减少枚举。【依据：`apps/api/src/routes/me.ts:15-18`；`apps/api/src/app.ts:256-259`；方案推导】
- 个人 MCP 上线验收应覆盖：两客户端握手、个人隔离、撤销立即生效、重复上报幂等、冲突处理与页面可见。【依据：[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)；[Claude MCP 文档](https://code.claude.com/docs/en/mcp)；方案推导】
- CI 路线上线验收另覆盖：伪造签名拒绝、同一 delivery 重投去重、无编号事件忽略、账号未绑定不代写个人进展。【依据：[GitHub 验签文档](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)；[Webhook 最佳实践](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)；方案推导】

## 本次只读核查说明

- 执行了 `codex --version`、`codex mcp add --help`、`codex mcp login --help` 和仓库只读检索；没有执行 `codex mcp add/login`。【依据：本次命令记录】
- 读了官方 OpenAI、Anthropic、GitHub 文档；未读取本机密钥或 Codex 配置文件，也未启动服务。【依据：本次操作记录】
- 调研前后 `git status --short` 中已有一组 `apps/web` 未提交改动，本次没有操作这些文件或 Git 索引。【依据：本次两次 `git status --short` 输出】
