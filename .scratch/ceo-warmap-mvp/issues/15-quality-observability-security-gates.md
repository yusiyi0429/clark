# 15: 建立全链测试、观测与安全门槛

Type: implementation
Status: resolved
Blocked by: 14 完成真实数据驱动的像素级 Web

## What to build

建立能阻止错误发布的最高可观察 seam、结构化观测和安全边界，使每个 Spec 行为都有一条可信验证路径，失败能从页面、日志或 AgentRun 定位。

## Acceptance criteria

- [x] 每个 Spec 行为至少映射到 contract、API、Pi/MCP、Web、端到端或真实验收中的一个最高 seam。
- [x] CEO 主旅程贯穿 Web Card、Action、SSE、API、PostgreSQL、Pi 与 MCP，并验证外部可观察结果。
- [x] 核心矩阵覆盖 Signal/Issue、Meeting/Outcome、MonthlyPlan、Conversation、Action 幂等、version conflict 和 effect 撤回。
- [x] health 与 GET 不调用模型、搜索或产生持久化副作用，能够区分 API、数据库和必要依赖状态。
- [x] 结构化日志含 requestId、runId、scope、objectRef、actionType、agentKind、provider/model、duration、status 与 errorCode。
- [x] LangSmith 记录应用可见输入输出、Tool 事件、usage 和错误；故障只降级为 warning，不阻断业务。
- [x] 日志、Prompt 和 trace 清除密码、Cookie、token、模型 key、完整 CompanyMemory passage 与完整 Transcript。
- [x] 安全检查覆盖 session 过期、service token、MCP 未授权、Action HMAC、CSRF/Origin、上传大小、速率限制和生产 Pi 资源隔离。
- [x] CI 只运行确定性检查；付费 Provider、模型与备份恢复保留为带成本上限的上线验收。

## Comments

### 交付

- Spec 行为 → 最高 seam 矩阵：`.scratch/ceo-warmap-mvp/evidence/ticket15/seam-matrix.md`（US 1–120 逐段映射到既有契约/API/Pi-MCP/Web 用例，并列出本 ticket 新增阻断门槛）。
- 确定性 CI 与付费上线门槛：`.github/workflows/ci.yml` + `.scratch/ceo-warmap-mvp/evidence/ticket15/acceptance-gates.md`（真实 Provider/模型/备份恢复仅列 staging gate 与成本上限，未在 CI 执行）。
- 新增阻断门槛：
  - `apps/api/test/journey.test.ts > runs the CEO main journey through Card, Action, SSE, PostgreSQL, controlled Pi and MCP`：登录 → 真实首页 Card → DRI Issue 的 `issue.create_meeting` Action → PostgreSQL `meetings.status=scheduled` → meeting scope SSE → 真实 `createPiConversationRuntime` + 真 MCP 内存 transport（`search_people` 返回稳定 personId）→ assistant 消息与 AgentRun 可观察。
  - `apps/api/test/observabilitySecurity.test.ts`：session 过期/篡改、脱敏纯函数、请求与 AgentRun 日志字段、health 三态与真实 Provider 就绪、LangSmith 三态（未配置 no-op、记录 I/O/tool/usage/错误、失败仅 warning）。
  - `apps/api/test/candidateAgentRuntime.test.ts > records application-visible LangSmith traces for batch runs, including failures`。
- 实现：`apps/api/src/observability.ts`（`logEvent` + `redactSecrets`）、`apps/api/src/langsmith.ts`（可选 adapter，未配置 no-op，失败 `console.warn`）；`app.ts` 增加 `onResponse` 结构化日志、conversation 的 `agent.run` 日志与 trace、health 扩展；`candidateAgentRuntime.ts` 批处理日志/trace；`packages/contracts/src/health.ts` 扩展并重新生成 Web client。

### 验证证据

- `pnpm test`：contracts 26、apps/web 9、apps/api 210（较基线 199 净增 11；未为覆盖率复制低层测试）。
- `pnpm typecheck`、`pnpm build` 通过；`pnpm --filter @warmap/web gen:client` 幂等（openapi.json / schema.d.ts md5 两次一致），CI 的 `git diff --exit-code` 门槛可复现。
- 安全八项均由最高 seam 用例覆盖：session 过期/篡改（新增）、service token、MCP 未授权、Action HMAC/篡改、CSRF/Origin、上传大小（413 双入口）、登录速率限制、生产 Pi 资源隔离（无 coding tools、只读 MCP）。
- 日志字段实测落盘：`http.request` 带 requestId/durationMs/status/errorCode/actionType/objectRef/runId/scope；`agent.run` 带 requestId/runId/agentKind/provider/model/durationMs/status/errorCode/objectRef；脱敏实测不误删 `totalTokens`，命中密码/Cookie/token/apiKey/完整 passage/完整 transcript。

### 内部评审

Herdr 只读 `deepseek-flash` 双轴评审两轮：第一轮 Axis A green / Axis B green、无 blocking；主 agent 修复有效 non-blocking（批处理日志补 objectRef、conversation 日志补 requestId、trace 补 promptHash、health 依赖改读已装配对象并新增真实 Provider 就绪测试、删除仅测试使用的 `langSmithEnabled`）后第二轮复核确认修复生效、无回归，Axis A green / Axis B green、无 blocking。

### 已知边界（未伪造）

- 真实 Web Search/公众号/模型/CompanyMemory 真实 seed 与加密备份恢复属 Ticket 16 staging gate；本 ticket 只在 `acceptance-gates.md` 列出次数与成本上限。
- 浏览器级 Web e2e 与视觉回归 CI、旧前端删除分别属 Ticket 16/17/18；本 ticket 的 Web seam 为契约有效性 + 固定 renderer + 既有双视口证据。
- health 的 `piRuntime`/`modelSlots`/`companyMemoryMcp` 是启动不变量（构造失败则 API 不启动），运行中恒为 true；真正可变的是 `database` 与 `search`/`wechat` Provider 状态。
- 脱敏按字段名（含 camelCase 归一化）清除；未做 value 级扫描与复数 key 扩展，避免误删 `totalTokens` 等安全字段。
- 仓库无 lint 脚本，CI 未加 lint；未引入日志平台、测试框架或通用策略引擎。
- 未修改 map、未 push/merge、未触碰其他 ticket。
