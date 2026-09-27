# 工单 06 · Codex／Claude Code 接入执行事项：个人令牌、MCP、进展记录 · 设计

日期：2026-09-28。依据：
- 方案 [design-codex-mcp.md](design-codex-mcp.md)，用户 2026-09-27 已确认：
  - 第一期做个人令牌、4 个工具、进展记录、连接页，不做自动钩子；
  - 同时给 Codex 和 Claude Code 的接入说明；
  - 进展由事项成员、拍板人、CEO 可见。
- 调研：[codex-integration-survey.md](codex-integration-survey.md)。
- 执行事项模型：[design-05.md](design-05.md)。

## 0. 要解决的事

员工在 Codex 或 Claude Code 里推进项目时，可以把进展写进天枢里自己的执行事项，也可以改状态。推进人、协作者、拍板人和 CEO 在天枢里都能看到，不用另外手写。

## 1. 数据：迁移 `037_personal_tokens_and_progress.sql`

```sql
-- 个人令牌：只存散列；client 决定进展的来源标注。
CREATE TABLE personal_tokens (
  id UUID PRIMARY KEY,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  client TEXT NOT NULL CHECK (client IN ('codex', 'claude')),
  secret_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX personal_tokens_person ON personal_tokens (person_id, created_at DESC);

-- 执行事项的进展记录：网页手写和外部工具写入都在这里。
CREATE TABLE task_progress (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'codex', 'claude', 'github')),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  links JSONB NOT NULL DEFAULT '[]',
  token_id UUID REFERENCES personal_tokens (id),
  client_event_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX task_progress_client_event ON task_progress (author_id, client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX task_progress_task ON task_progress (task_id, created_at DESC);
```

- 令牌格式：`tsm_<id 去横线>_<32 字节随机，base64url>`。
  - 库里只存随机部分的散列：sha256 加服务端 pepper，pepper 用现有的 sessionSecret。
  - 比对用定长比较。
  - 明文只在创建的响应里出现一次，不进日志。
- `github` 这个来源先留着（第二期 webhook 用），本单不写入。

## 2. 契约（packages/contracts；执行时照这里写，写完即冻结）

`tasks.ts` 增加：
- `TaskProgressSource = web | codex | claude | github`。
- `TaskProgressEntry {id, taskId, author: TaskPerson, source, body (1..2000), links: [{url (^https?://, ≤500), title? (≤120)}] (≤5), createdAt}`。
- `TaskView` 加 `latestProgress: {body, source, author: TaskPerson, createdAt} | null`，最近一条。
- `TaskDetailResponse` 加 `progress: TaskProgressEntry[]`，按时间倒序，最多 50 条。
- `AppendTaskProgressRequest {clientEventId: uuid, body, links?}`，返回 `TaskProgressEntry`。
- `MissionCardItemsResponse {missions: [{missionId, items: TaskView[]}]}`：个人卡页用，按个人任务列出它的执行事项。

新文件 `personalTokens.ts`：
- `PersonalTokenClient = codex | claude`。
- `PersonalTokenView {id, name, client, createdAt, expiresAt | null, lastUsedAt | null}`。已撤销的不返回。
- `ListPersonalTokensResponse {tokens: PersonalTokenView[], mcpPath: "/mcp/me"}`。
- `CreatePersonalTokenRequest {name (1..40), client, expiresInDays: 30 | 90 | null}`。
- `CreatePersonalTokenResponse {token: string, view: PersonalTokenView}`。

OpenAPI 登记：
- `GET/POST /api/me/tokens`
- `DELETE /api/me/tokens/{id}`（204）
- `POST /api/me/tasks/{id}/progress`
- 个人卡的执行事项读接口，路径跟现有个人卡路由同一前缀，例如 `GET /api/mission-cards/{cardId}/items`。

然后重新生成 web 客户端。

## 3. API 行为

**令牌**：
- 只有成员（role member）能建；CEO 没有执行事项，不给入口，接口返回 403。
- 每人最多 5 个有效令牌。
- `expiresInDays` 为 null 表示不过期。
- 撤销立即生效，下一次请求就返回 401。
- 列表不返回已撤销的。
- 令牌不能访问公司记忆 MCP，也不能当网页会话用。

**MCP 端点**：`POST/GET/DELETE /mcp/me`，streamable HTTP，照 `mcpCompanyMemory.ts` 的写法。
- 鉴权：`Authorization: Bearer <个人令牌>`。缺失、格式不对、散列不符、已撤销、已过期、人已不在人员名单里，一律返回 401，不区分原因。
- 每次调用都按数据库现状重新鉴权、查权限，更新 `last_used_at`。
- 限流：每个令牌每分钟 60 次调用，其中写 20 次。超了按 MCP 错误返回「调用太频繁，请稍后再试」。
- 审计：结构化日志事件 `mcp.tool`，字段有 tokenId、personId、tool、itemId、ok、errorCode。不记令牌，不记正文。

**工具**，描述写成中文加英文各一句，好让模型会用：
- `list_my_items {status?: "open" | "all"}`：本人推进的事项，默认只列未完成的。
  - 每条返回：id、标题、状态、version、所属个人任务和第几步、开始和截止日期、协作者、最新一条进展。
- `get_item {itemId}`：本人推进或协作的事项都能读。
  - 返回详情、完成定义、判断、最近 20 条进展。
- `append_progress {itemId, body, links?, clientEventId?}`：推进人和协作者都能写。
  - 来源取令牌的 client。
  - 同一个 clientEventId 重复提交只记一次，返回原来那条。
- `update_status {itemId, status: not_started | in_progress | done, version}`：只有推进人能改。
  - version 不一致时返回当前 version，让代理重试。
  - 不能改成退回。
- 不是本人推进或协作的事项：一律返回「找不到这件执行事项」，不泄露存在与否。

**网页写进展**：`POST /api/me/tasks/:id/progress`，推进人和在职协作者可写，来源 `web`，按 (本人, clientEventId) 幂等。

**谁能看进展**（用户已定：事项成员、拍板人、CEO）：
- 事项成员：详情里的完整进展列表，首页卡片上的最新一条。
- 拍板人和 CEO：在个人卡页读 `MissionCardItemsResponse`。
  - 能看这张个人卡的人都能调用：卡的主人、这一轮的拍板人、CEO。
  - 返回每项个人任务下的执行事项，含最新一条进展。
  - 不是事项成员的人只读摘要，点不进详情。
- 独立事项没有所属个人卡，只有事项成员能看。

## 4. Web

**连接页**：个人菜单加一项「连接 Codex / Claude Code」，只对成员显示。点开是和「我的雷达」「我的声纹」同一种对话框。内容：
- 已有令牌列表：名称、用于 Codex 还是 Claude Code、创建时间、到期、最后使用。每个都能撤销，撤销前要确认。
- 「生成令牌」：
  - 填名称，比如「我的笔记本」；
  - 选用于 Codex 还是 Claude Code；
  - 选有效期：30 天、90 天或不过期。
- 生成后只显示一次：令牌加一个复制按钮，写明「关掉后就看不到了」。下面是填好地址和令牌的命令，可以直接复制：
  - Codex：先设环境变量。
    - Windows PowerShell：`[Environment]::SetEnvironmentVariable("TIANSHU_TOKEN", "<令牌>", "User")`；
    - macOS／Linux：`export TIANSHU_TOKEN=<令牌>`。
    - 然后运行 `codex mcp add tianshu --url <站点地址>/mcp/me --bearer-token-env-var TIANSHU_TOKEN`。
  - Claude Code：`claude mcp add --transport http tianshu <站点地址>/mcp/me --header "Authorization: Bearer <令牌>"`。
  - 一段可以放进项目 `AGENTS.md` 或 `CLAUDE.md` 的建议：
    > 推进天枢里的执行事项时，开始前用 tianshu 的 list_my_items 找到对应事项；收尾时用 append_progress 写一条进展：做了什么、证据链接、下一步或阻塞；做完用 update_status 标完成。
- 站点地址用当前页面的 origin。`apps/web/next.config.ts` 加一条 `/mcp/:path*` 到 API 的转发，和 `/api` 一样，保证用网页地址就能连上。

**执行事项详情**：在「报进度」之后加「进展」一块。
- 按时间倒序列出进展，每条：来源小标（网页、Codex、Claude Code、GitHub）、谁、什么时间、正文、链接。
- 推进人和协作者有一个输入框「写一条进展」加「保存」，失败时保留输入。
- 空的时候写一句：「还没有进展。可以在这里写，也可以从 Codex 或 Claude Code 同步。」

**首页卡片**：有最新进展时，卡片底部加一行淡色小字：「最新进展 · Codex · 10/5 14:20」，悬停或读屏能读到正文前 60 字。

**个人卡页**：每项个人任务下面的执行事项行，对所有能看这张卡的人都显示，数据来自新的读接口。
- 每行加最新进展的一行小字。
- 是事项成员的人，点行能打开详情；其他人只能看。
- 卡的主人现在看到的计划和行不变。

## 5. 测试

**API**：
- 令牌：只显示一次；库里没有明文；撤销后 401；过期后 401；CEO 不能建；每人最多 5 个。
- MCP：
  - 走一遍 initialize → tools/list → 4 个工具调用，带 bearer；
  - 权限：别人的事项读不到，协作者能写进展但不能改状态；
  - 状态 version 冲突；
  - clientEventId 幂等；
  - 限流。
- 网页写进展和幂等。
- 个人卡的执行事项读接口：拍板人和 CEO 能读，其他人 404；非成员拿不到详情。
- 原有测试全部通过。

**Web**：
- 连接对话框：生成后令牌和命令只出现一次、撤销要确认；
- 详情里的进展块和写入；
- 首页卡片的最新进展；
- 个人卡的执行事项行在拍板人视角下出现、点不进去；
- 手机 390 宽不横向溢出。

## 6. 本单不做

- Codex Stop 钩子提醒、GitHub webhook、OAuth、Codex 云端。这些是第二期。
- 从 Codex 新建执行事项（`create_item`）。
- CEO 查看全部执行事项的看板。
