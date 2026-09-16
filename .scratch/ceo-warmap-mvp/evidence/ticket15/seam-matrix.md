# Ticket 15 · Spec 行为 → 最高可观察 seam 矩阵

每个 Spec 行为只映射到一个最高 seam：能从 Card/Action/SSE/公开契约观察的，不再为私有 helper 重复写测试。
本矩阵记录 **已有** 检查（ticket 01–14 产生）与 **本 ticket 新增** 的阻断门槛；`apps/api` 用例名以文件内 `describe > it` 原文为准。

- Contracts：`packages/contracts/test/contract.test.ts`
- Web：`apps/web/src/cards/registry.test.tsx`、`apps/web/src/lib/actionResponse.test.ts`、`apps/web/src/conversation/sse.test.ts`、ticket 01/14 视觉证据
- API/Pi/MCP：`apps/api/test/*.test.ts`
- 真实验收：`.scratch/ceo-warmap-mvp/evidence/ticket15/acceptance-gates.md`（Ticket 16 staging gate）

## 新增阻断门槛（Ticket 15）

| 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| CEO 主旅程 Card→Action→SSE→PostgreSQL→受控 Pi→MCP | API + 真实 Pi/MCP adapter | `journey.test.ts > runs the CEO main journey through Card, Action, SSE, PostgreSQL, controlled Pi and MCP` |
| session 过期 / 篡改 | 鉴权 HTTP seam | `observabilitySecurity.test.ts > rejects an expired or tampered CEO session cookie` |
| 结构化日志字段 | 日志 stdout seam | `observabilitySecurity.test.ts > emits request, action and agent runs with the required fields and no secret values` |
| 敏感数据清除 | 纯函数 seam | `observabilitySecurity.test.ts > clears secrets, full CompanyMemory passages and full Transcripts while keeping safe fields` |
| health 区分 API/DB/必要依赖且无副作用 | `GET /healthz` + API seam | `observabilitySecurity.test.ts > separates API, database and necessary dependencies without model, Search or persistent side effects` |
| health 诚实降级 | `GET /healthz` | `observabilitySecurity.test.ts > reports a degraded API with the database clearly distinguished` |
| health 依赖字段反映真实 Provider 状态而非常量 | `GET /healthz` | `observabilitySecurity.test.ts > reflects real provider readiness instead of constants` |
| LangSmith 未配置 no-op | 可选 adapter seam | `observabilitySecurity.test.ts > is a no-op when unconfigured and never fails the business path` |
| LangSmith 记录 I/O/tool/usage + 脱敏 | trace payload seam | `observabilitySecurity.test.ts > records application-visible I/O, tool events, usage and status with credentials redacted` |
| LangSmith 故障仅 warning | 业务不变 seam | `observabilitySecurity.test.ts > downgrades a LangSmith failure to a warning without changing the AgentRun or business result` |
| 批处理 Agent trace（含失败） | `runCandidateAgent` seam | `candidateAgentRuntime.test.ts > records application-visible LangSmith traces for batch runs, including failures` |

## 1. 入口、Card 与 Action（US 1–8、106–112）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US1 鉴权入口 | HTTP | `journey.test.ts > rejects wrong password...`、`>` issues an HttpOnly...` |
| US4 统一 Issue 体验、US5 稳定 URL、US107 生成客户端 | 契约 + Web | `contract.test.ts > exposes the public API surface`；`registry.test.tsx`；ticket 14 路由证据 |
| US2/US3/US6/US7/US8 布局、驾驶舱、dock、键盘、桌面 | Web 视觉 | ticket 01 双视口基线；ticket 14 `evidence/web14/verification.json`；human gate 17 |
| 未登录/无同源/限速/服务身份分离 | HTTP 安全 | `journey.test.ts > rejects writes without a same-origin header`、`> rate limits login attempts per IP`、`> service tokens are a separate boundary...` |
| US106/US111 Web 不持有业务 | Web seam | `registry.test.tsx`、`actionResponse.test.ts`（Web 无业务 route，ticket 14 记录） |
| US108 固定 renderer | Web seam | `registry.test.tsx > has a fixed renderer for every supported kind`、`> fails loudly on an unknown kind` |
| US112 health/GET 无副作用 | API seam | `journey.test.ts > GET /api/cards/home performs no writes`；新增 health 用例 |
| Action 幂等 / version conflict / HMAC | Action seam | `action.test.ts > replays are idempotent...`、`> fingerprint miss on a stale version returns 409 with latestCard`、`> rejects tampered, unknown and unauthenticated actions`、`> actionId is deterministic...` |

## 2. Radar、Signal 与 Issue（US 9–26）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US9–US12 每日/手动同一管线、Web/公众号 | Radar API seam | `radar.test.ts > authenticates manual scans, shares the scheduled pipeline...`、`> normalizes recorded Web and account-level WeChat responses without keyword substitution`、`> uses the PostgreSQL lock to reject overlap...` |
| US13/US14 Signal 展示、read/saved/dismissed 独立 | Card seam | `radar.test.ts > shows unconfigured WeChat honestly and keeps read, saved, dismissed independent` |
| US15–US20 自动升级、red 门、dismissed 去重 | Issue Card/API seam | `issues.test.ts > atomically links the Signal...`、`> collapses normalized duplicates...`、`> does not promote a red candidate whose decisionByEvidence is not contiguous...`、`> keeps the Signal but does not promote when options are duplicated` |
| US21–US24 DRI Issue 导入与校验 | 服务 API seam | `issues.test.ts > rejects anonymous, wrong-token and CEO-session callers`、`> creates an immediately queryable pending Issue...`、`> rejects 未知 participant...`（Meeting 同源） |
| US25/US26 单一归属与 Strategic | Card/API seam | `issues.test.ts > turns a multi-battlefield issue into one Strategic company Issue...`、`> rejects a company location that names fewer than two battlefields` |
| 去重指纹与来源保留 | Card/API seam | `issueDecision.test.ts > keeps origin and promotion fingerprint without deleting the Issue`、`issues.test.ts > collapses normalized duplicates...` |
| US113/US114 scheduler 锁与 Company Day | 持久化 seam | `radar.test.ts > marks an interrupted running scan as failed...`、`> settles stale Radar AgentRuns`；`monthlyPlan.test.ts > creates at most one plan per Asia/Shanghai period` |

## 3. 预研与 CEO 决定（US 27–36）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US27/US28 research 四态 | Issue Card/API | `issueDecision.test.ts > observes pending -> running -> ready...`、`issues.test.ts > marks a stale pending research as failed:trigger_not_started...` |
| US29/US30/US31 失败、整份重跑、仅 pending | Action seam | `issueDecision.test.ts > surfaces a failed run in place...`、`> replaces the whole doc...`、`> refuses to re-run while the current run is still running`、`> only allows pending Issues` |
| US32 ResearchDoc 字段 | 契约 | `contract.test.ts`（ResearchDoc）；`issueDecision.test.ts > rejects a candidate that violates the strict ResearchDoc schema` |
| US33/US34/US35/US36 决定、最终文本、Override、记录 | Action/Receipt seam | `issueDecision.test.ts > decides from ready research...`、`> requires second confirmation and records override...`、`> allows override only while research is pending or failed` |
| Conversation 不能改 ResearchDoc | API seam | `issueDecision.test.ts > never lets a Conversation turn change the ResearchDoc` |
| 统一 effect revoker | Action seam | `issueDecision.test.ts > revokes exactly one Receipt, restores the Issue state, and never claims to restore unsupported effects` |

## 4. Meeting 与会前（US 37–46）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US37/US38 从 Issue 创建/加入 | Card/Action seam | `meetings.test.ts > creates a scheduled Meeting from an Issue...`、`> joins an existing scheduled Meeting from another Issue and stays idempotent on replay` |
| US39 participant 来自目录 | Action seam | `meetings.test.ts > creates a scheduled Meeting...`（身份快照）；`companyMemoryMcp.test.ts > search_people 返回 company-people.v1 稳定身份` |
| US40 DRI Meeting 导入 | 服务 API seam | `meetings.test.ts > rejects anonymous, wrong-token and CEO-session callers`、`> imports legal metadata...` |
| US41/US42/US43 Preflight 与准备状态 | Card/Action seam | `meetings.test.ts > persists read, carried, checked and note state...`、`> clears the check of an entry as soon as its content is edited`、`> regenerates the preflight...` |
| US44/US45 Supplement 诚实状态 | Action/导出 seam | `meetings.test.ts > keeps pending_export when no real channel is configured...`、`> records delivered only from a real channel receipt...` |
| US46 取消 scheduled | Action seam | `meetings.test.ts > cancels only a scheduled Meeting...`、`> refuses to cancel a %s Meeting` |

## 5. Transcript 与 MeetingOutcome（US 47–66）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US47/US48 双入口上传 | HTTP seam | `transcript.test.ts > requires authentication on both entrypoints...` |
| US49/US50 整份拒绝、speaker 匹配 | Transcript 契约 seam | `transcript.test.ts > rejects ... 整份且不改变 Meeting（两个入口）`、`> enforces the same size limit on %s` |
| US51 held + 抽取 | Meeting Card seam | `transcript.test.ts > replaces the transcript through the dangerous Action...` |
| US52 失败保留并显式重试 | API seam | `transcript.test.ts > keeps the raw transcript, exposes the failure and only retries on an explicit Action` |
| US53/US54 引文绑定、未知 speaker | 候选校验 seam | `transcript.test.ts > keeps a candidate whose quote only exists in another turn out of review items...`、`> rejects unknown owners, owners not derivable from the turn...` |
| US55–US66 逐项 confirm/dismiss、精确 effect、reopenWhen、reviewed | Action/Card seam | `outcomeEffects.test.ts` 全部用例（含 `> confirms two items independently and revoking one leaves the other effect intact`、`> replays a confirm action fingerprint...`、`> only confirms a reopenWhen after its parent decision...`、`> cleans child conditions and anchors when the parent decision is dismissed or revoked`、`> delegates a meeting Receipt revoke from the Issue page...`） |
| US60/US64 诚实导出与不可撤回 | 导出 seam | `outcomeEffects.test.ts > records a failed export without rolling back the confirmed item`、`> refuses to revoke a delivered todo...` |

## 6. MonthlyPlan（US 67–77）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US67 Company Day 唯一创建、补跑 | 持久化 seam | `monthlyPlan.test.ts > creates at most one plan per Asia/Shanghai period...`、`> marks an unfinished draft as failed on boot...` |
| US68 失败可见并显式重试 | API seam | `monthlyPlan.test.ts > saves a strictly validated Candidate Material...` |
| US69/US70/US71 编辑、todo、字段 | Action/Card seam | `monthlyPlan.test.ts > edits company outcome...`、`> rejects unknown todo owners and stale versions...` |
| US72/US73 DRI feedback 同源 | 服务 API seam | `monthlyPlan.test.ts > appends externalId-deduplicated narrative feedback...`、`> appends todo feedback without changing todo state...` |
| US74 CEO-only 签发 | Action seam | `monthlyPlanSign.test.ts > only a CEO session can sign...` |
| US75 刷新战场/anchors | 投影 seam | `monthlyPlanSign.test.ts > confirms one plan, projects it into battlefield/notification and rebuilds ontology Radar anchors` |
| US76/US77 战场翻面、无百分比 | Card 契约/投影 | `monthlyPlanSign.test.ts > projects pending issues, todos and the latest battlefield feedback by battlefieldId`、`> does not create Mission/Todo entities, percentages...`；ticket 01/14 视觉证据 |

## 7. Conversation、四层记忆与 Pi（US 78–105）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US78/US79 scope 隔离 | SSE/HTTP seam | `conversation.test.ts > keeps global and object messages plus runtime entries isolated across turns`、`> serves a real Issue Card with its own stable Conversation scope` |
| US80/US81/US82 引用快照 | HTTP seam | `conversation.test.ts > builds reference snapshots from current Card ID/version and rejects stale or missing cards` |
| US83/US84/US85/US86 对象优先、自主搜索、证据分层、停止 | Pi loop 公开 seam | `piConversationRuntime.test.ts > makes Search available but does not call it when internal context is sufficient`、`> searches once for missing current facts and stops...` |
| US87/US88 180s、8 次、停止 | SSE seam | `conversation.test.ts > returns a distinct SSE error when the eighth Search exhausts the budget`、`> enforces the public 180 second turn timeout...`、`> aborts Pi when the SSE client disconnects...` |
| US89/US90 compaction 保留原始消息 | 持久化 seam | `conversation.test.ts > checkpoints compaction entries without deleting raw messages even if the turn later fails`、`> recovers Pi runtime entries from PostgreSQL after an app rebuild without rewriting raw messages` |
| US91/US92 entries 恢复与损坏重建 | 持久化 seam | `conversation.test.ts > publishes and persists the runtime rebuild result while retaining raw messages`、`piConversationRuntime.test.ts > rebuilds corrupted entries from recent raw messages...` |
| US93–US97 CompanyMemory 只读、可复用 | MCP 契约 seam | `companyMemoryMcp.test.ts > 握手后工具目录只含四个只读工具`、`> 不存在 CompanyMemory 写入方法...`、`> get_passages 读取指定章节段落并带来源` |
| US98/US99 Candidate Material 无写工具、严格 submit | Pi 公开 seam | `candidateAgentRuntime.test.ts > accepts only a strict submit_candidate Tool result...`、`> rejects prose output...`；`issueDecision.test.ts > submits the doc through the strict submit_candidate tool...` |
| US100/US101/US102 版本化 Prompt、生产 Pi 忽略用户配置、无 coding tools | Pi resource loader seam | `piConversationRuntime.test.ts > loads no user/coding resources, exposes only read-only CompanyMemory tools...` |
| US103 环境变量模型槽位 | health/契约 | 新增 health `dependencies.modelSlots`；`server.ts` requiredEnv 三槽位 |
| US104/US105 LangSmith 与凭据清除 | 观测 seam | 新增 LangSmith + redaction 用例 |
| US96/US97 CompanyMemory 不被 Action 直接修改 | Action 投影 | `monthlyPlanSign.test.ts > does not create Mission/Todo entities... or write CompanyMemory`、`outcomeEffects.test.ts > confirms a CEO judgment without touching CompanyMemory` |

## 8. 部署、备份与旧前端（US 106–120）

| Spec 行为 | 最高 seam | 可执行检查 |
|---|---|---|
| US106/US111 Web/API 独立、US107 生成 client | CI 确定性门槛 | `.github/workflows/ci.yml`（gen:client + git diff --exit-code） |
| US109/US110 视觉与 scope 外状态 | Web 视觉 | ticket 01 基线 + ticket 14 证据 + human gate 17 |
| US112 health 无副作用 | API seam | 新增 health 用例 |
| US113/US114 锁、Company Day、UTC | 持久化 seam | Radar/MonthlyPlan scheduler 用例 |
| US115/US116 加密备份与真实恢复 | staging gate | `.scratch/ceo-warmap-mvp/evidence/ticket15/acceptance-gates.md`（Ticket 16） |
| US117/US118 从空 Web、不迁移旧数据 | 结构 + Web seam | ticket 02/14 证据；旧 `frontend/` 删除属 ticket 18 |
| US119/US120 删除前置门槛与用户审阅 | human gate | ticket 17/18 |
