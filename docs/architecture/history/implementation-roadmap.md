# 原始实施路线

本文记录最初的实施顺序，不表示阶段已通过验收。当前开发入口见[根 README](../../../README.md)，需求见[领域上下文](../../context.md)。

## 1. 目标

本路线把已确认 Spec 拆成可独立实现和验收的纵向切片。每个切片都要从用户可见入口贯穿到 API、PostgreSQL 和必要的 Agent／MCP，不先建设无法验收的通用平台。

最终目标：

```text
apps/web 只渲染 Card 和提交 Action
apps/api 拥有业务、Pi、MCP、调度和集成
PostgreSQL 保存业务事实与 Pi 执行态
旧 frontend 在新系统验收后整体删除
```

## 2. 技术分片

| 编号 | 分片 | 主要输出 | 依赖 |
|---|---|---|---|
| 01 | 基础设施与契约 | Monorepo、Fastify、TypeBox、OpenAPI、PostgreSQL、鉴权、Card/Action 基座 | 无 |
| 02 | Pi 与四层记忆 | 受控 Pi Runtime、Conversation、compaction、Web Search、Company / Personal（替代旧 MCP，ADR-0027） | 01 |
| 03 | Radar 与 Issue 预研 | Scheduler、Signal、自动升级、ResearchDoc、直接决定 | 01、02 |
| 04 | Meeting 与 Outcome | Preflight、Transcript v1、会后抽取、逐项效果与撤回 | 01、02、03 的 Issue |
| 05 | MonthlyPlan 与 DRI 集成 | 月初装配、普通待办、DRI import/export、战场投影 | 01、02 |
| 06 | Web 像素级重构 | 新 apps/web、稳定 URL、Card renderer、Action、SSE、视觉回归 | 01–05 Card/API |
| 07 | 测试、观测与安全 | 端到端 seam、LangSmith、健康检查、备份恢复、安全验证 | 横跨 01–06 |
| 08 | 联调与部署 | Compose、环境、真实 Provider、cutover、旧前端删除 | 01–07 |

## 3. 阶段实施顺序

### 阶段 0：冻结证据

先完成，不改业务代码：

- 冻结当前 CEO WarMap scope 内页面清单；
- 在 1440×900、1600×1000 生成视觉基线；
- 记录关键动画终态、焦点返回、Escape 和 reduced-motion；
- 固定一套仅用于视觉等长内容的 fixture；
- 保存当前可用入口与健康状态。

完成门槛：后续能客观判断“像素级重构”，而不是凭记忆比较。

### 阶段 1：建立可运行骨架

实现分片 01：

- 根 pnpm workspace，并把 Monorepo 职责与依赖边界写入 CLAUDE.md；
- apps/web、apps/api、packages/contracts；
- Caddy 统一 HTTPS 入口；
- PostgreSQL 和 SQL migration；
- CEO 登录；
- Card envelope、Action executor、错误 envelope；
- OpenAPI 与生成 Web client；
- 首页返回一个后端 fixture Card。

纵向验收：CEO 登录后，新 Web 能从 API 获取并渲染一张只读 Card。

### 阶段 2：先跑通 Conversation

实现分片 02：

- global Conversation；
- 一个对象 Conversation；
- Pi 自定义 ResourceLoader；
- 禁用 coding tools；
- Web Search Tool；
- Company / Personal（替代旧 MCP，ADR-0027）；
- SSE；
- runtime entries JSONB；
- compaction 和恢复。

纵向验收：global 与对象对话不串话，Search 自主调用，Pi entries 可在进程重启后恢复。

### 阶段 3：跑通第一条决策闭环

实现分片 03：

```text
真实外部来源
→ Signal
→ 自动 pending Issue
→ ResearchDoc
→ CEO 直接决定
→ Receipt
```

先支持一个 Web Search Provider。公众号渠道可以并行 PoC，但 Radar 不能在未接入时宣称完整。

纵向验收：一条真实 Signal 完成自动升级和决定。

### 阶段 4：跑通 Meeting 闭环

实现分片 04：

```text
Issue
→ Meeting
→ Preflight
→ Transcript v1
→ MeetingOutcome
→ 逐项确认／忽略
→ Receipt／Todo export／Radar anchor
```

纵向验收：至少两个 item 分开处理，撤回一个不影响另一个。

### 阶段 5：跑通月度协商

实现分片 05：

```text
月初 Scheduler
→ MonthlyPlan draft
→ DRI feedback
→ CEO sign
→ 战场 Card + Radar anchors
```

纵向验收：同一 period 只创建一个计划，通知与详情投影同一对象。

### 阶段 6：完成新 Web

实现分片 06：

- 将阶段 0 的视觉基线迁到 apps/web；
- 接入全部目标 Card kinds；
- 稳定对象 URL；
- 通知浮卡和战场翻转；
- Conversation dock 与引用托盘；
- scope 外状态使用已有视觉语言；
- 删除新 Web 中所有 fixture 分支。

纵向验收：目标页面全部接真实 API，scope 内视觉回归通过。

### 阶段 7：联调与上线

实现分片 07、08：

- 真实 Search／公众号／模型／MCP；
- 全链 smoke；
- LangSmith 与结构化日志；
- 安全验证；
- 宿主机 cron 执行 PostgreSQL 异机加密备份和真实恢复；
- 新入口 cutover；
- 用户像素级验收；
- 删除旧 frontend。

## 4. 依赖图

```text
阶段 0 视觉证据 ──────────────────────────────→ 06 Web

01 基础设施与契约
  ├─→ 02 Pi 与四层记忆
  │     ├─→ 03 Radar／Issue
  │     ├─→ 04 Meeting／Outcome
  │     └─→ 05 MonthlyPlan
  └──────────────────────────────────────────→ 06 Web

01–06 ─→ 07 测试／观测／安全 ─→ 08 联调／部署／cutover
```

04 需要 03 已有可用 Issue，但不需要 Radar 完整接入公众号；可以使用 DRI Issue fixture 联调。

## 5. 每个分片的统一交付格式

每个技术分片必须明确：

1. 模块职责与禁止职责；
2. TypeBox／OpenAPI 契约；
3. PostgreSQL 数据与事务边界；
4. HTTP、SSE、MCP 或 Agent 调用；
5. 状态机与并发规则；
6. 错误、失败和重试；
7. 最少测试 seam；
8. 完成条件；
9. 本分片明确不做的内容。

## 6. 合并策略

每个阶段保持主干可运行：

- 先合 contracts 和 migration；
- 再合 API 行为；
- 再合 Web renderer；
- 最后删除该阶段 fixture；
- 一个 PR 不同时跨两个未完成的领域链路；
- 不在功能 PR 中顺手清理旧 frontend；
- 旧 frontend 只在最终 cutover ticket 删除。

## 7. 验收层级

### 模块级

TypeBox、domain rule、repository 和 Tool 的外部行为测试。

### 分片级

从 Card／integration endpoint 到 PostgreSQL 与 Agent adapter 的 API 测试。

### 产品级

浏览器完成真实用户旅程，验证 URL、Card、Action、Conversation 和视觉。

### 上线级

真实 Provider、备份恢复、健康检查、鉴权和 cutover。

## 8. 风险前置

进入完整开发前先验证：

- Pi SDK 在固定 Node LTS 下运行；
- 当前模型端点支持严格 Tool call；
- 一个 Web Search Provider 可返回 URL 与摘录；
- 一个公众号渠道能按账号拉取；
- PeopleDirectory 能加载通过 `company-people.v1` 校验的真实人员 seed，并提供稳定 personId；
- PostgreSQL JSONB 可以恢复 Pi entries；
- 旧 Web 视觉基线可稳定复现。

PoC 失败只调整对应 adapter 或模型，不重新打开业务对象和页面意图。
