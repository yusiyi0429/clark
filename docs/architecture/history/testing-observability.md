# 原始测试、观测与安全方案

本文保留早期验收设计，不表示检查已执行。当前 SDK、完整业务观测和凭据边界见[工程规范](../../standards.md)。当前验收步骤见[本地记忆验收](../../guides/local-memory-langsmith.md)。

## 1. 测试原则

优先最高可观察 seam：

```text
Web 用户旅程
→ Card/Action/SSE
→ API/domain
→ PostgreSQL/Pi/MCP adapter
```

能从 HTTP/Card 观察的行为不重复测试私有 helper。外部 Provider 使用 stub 做常规测试，保留少量真实验收。

## 2. 测试层

### Contracts

- TypeBox valid/invalid；
- OpenAPI snapshot；
- Web 生成 client 无 diff；
- Transcript/DRI/MCP schema。

### Domain/API

- 状态机、事务、version、幂等；
- Card projector；
- Action 确定性 token、fingerprint 幂等和 version 顺序；
- auth；
- scheduler；
- integration endpoints。

使用真实测试 PostgreSQL，不用与生产行为不同的内存数据库。

### Pi/MCP

- fake Search Tool；
- fake model adapter 用于确定性分支；
- 少量真实模型 smoke；
- compaction 和 entries round-trip；
- MCP contract/auth/read-only。

### Web

- Card renderer；
- Action/SSE；
- scope；
- URL；
- focus/keyboard；
- visual regression。

### 端到端

五条验收：Radar 决策、DRI Meeting、MonthlyPlan、Conversation 隔离/压缩、备份恢复。

## 3. 核心测试矩阵

### Issue

- Radar/DRI 两种来源；
- 单战场/多战场/capability；
- red deadline quote 门；
- promotion fingerprint 规范化；
- pending trigger 丢失转 failed；
- pending/decided/dismissed；
- Research ready/failed/retry；
- Research Override；
- Receipt 精确撤回。

### Signal

- URL fingerprint；
- promotion fingerprint；
- read/save/dismiss 独立；
- 自动升级事务；
- dismissed 防重复升级。

### Meeting/Outcome

- participant ID；
- preflight edits/checks；
- Supplement Request；
- Transcript 全量拒绝；
- QuoteRef turn；
- speaker/owner/CEO kind；
- confirm/dismiss；
- parent decision 与 reopenWhen 约束；
- deterministic effect；
- Issue/Outcome 统一 revokeEffect；
- Transcript 替换使旧 candidate/actionId 失效；
- delivered todo 撤回限制；
- Meeting reviewed 派生。

### MonthlyPlan

- 同月唯一；
- scheduler catch-up；
- 带 battlefieldId 的 todo/叙述性 feedback；
- feedback idempotency；
- sign + Radar anchors；
- 战场无百分比；
- todo 无执行状态。

### Conversation

- scope 隔离；
- 引用 snapshot；
- no-search/search；
- 8 次保护；
- timeout/abort；
- compaction；
- entries 恢复/损坏重建；
- 原始消息保留。

## 4. 视觉测试

基线视口：1440×900、1600×1000。

- fixture 保持文本长度稳定；
- 动态 glyph 可遮罩；
- 容器、间距、颜色、图标、阴影、圆角不可遮罩；
- 动画比较终态；
- focus、Escape、reduced-motion 单独行为测试；
- scope 外新增页面由人工按既有风格走查。

视觉差异只有用户确认后才能更新 baseline。

## 5. 真实验收

- 一个 Web Search Provider 查询；
- 一个微信公众号账号拉取；
- light/heavy/compaction 模型各一次；
- 一个完整 Pi Tool loop；
- 一个 Pi compaction/recovery；
- 一个合法 Transcript；
- 一个真实 backup restore。

真实测试设置成本上限，不在常规 CI 运行。

## 6. 结构化日志

字段：requestId、runId、scope、objectRef、actionType、agentKind、provider/model、duration、status、errorCode。

不记录：密码、Cookie、token、模型 key、完整 CompanyMemory passage、完整 Transcript。

## 7. LangSmith

记录应用可见的完整 Agent 输入输出、Prompt hash、Pi Tool 事件、usage、耗时、错误和 objectRef。发送前清除凭据。

LangSmith 失败只写 warning，不改变 AgentRun 或业务结果。

## 8. Health

Web health 只报告进程和 BUILD_SHA。

API health 报告安全状态：database、Pi 初始化、模型槽位、Search、公众号、MCP、scheduler tick、BUILD_SHA。不得发起模型/Search 调用或返回 secret。

## 9. 安全测试

- 密码错误和限速；
- Cookie 签名/过期/Secure/SameSite；
- Origin 校验；
- DRI/MCP token 隔离；
- Action HMAC 篡改；
- Card version conflict；
- JSON/multipart 大小限制；
- Transcript speaker 越权；
- Prompt injection 外部内容；
- Pi coding tools 不存在；
- production seed 禁用；
- 日志/trace secret 扫描。

## 10. Agent 安全

- 外部网页、公众号、Transcript、DRI 文本均标记为不可信数据；
- Tool 结果不能修改 system Prompt；
- Pi 只读 Tool allowlist；
- `submit_candidate` 不写数据库；
- 业务写只走 API command handler；
- 模型输出必须 schema + domain 双校验。

## 11. 性能边界

MVP 目标不是高并发。验证：

- 首页 Card query 无 N+1；
- Conversation SSE 首个事件及时返回；
- 同 scope 并发返回 409；
- Transcript 大小限制；
- Radar batch 有固定上限；
- Search 单次和整 turn timeout；
- PostgreSQL 索引覆盖通知与首页 query。

未测出问题前不加 Redis/cache。

## 12. CI 门槛

```text
contracts check
lint/typecheck
unit/API tests
Web component tests
OpenAPI generated-client clean check
production build
visual regression（稳定环境）
```

真实 Provider 与恢复测试属于 staging gate，不属于每次 CI。

## 13. 发布门槛

- CI 全绿；
- staging 五条真实验收通过；
- health 正常；
- secret scan 通过；
- 宿主机备份脚本、异机目标和 restore 通过；
- 用户视觉确认；
- 才允许 cutover 和删除旧 frontend。

## 14. 完成条件

每个 Spec 行为至少落在一个最高 seam；无为了覆盖率重复实现逻辑的测试；失败能从对象页面、日志和 AgentRun 定位；安全边界不依赖 Prompt 自律。
