# CEO WarMap MVP implementation map

Type: effort
Status: ready-for-agent
Spec: `spec.md`

## Goal

以可独立验收的 tracer bullets 实现 CEO WarMap MVP：新 Web 只渲染 Card 并提交 Action，API 持有业务、Pi、MCP、调度与持久化，Caddy 是唯一公网入口；最终在用户验收后切换入口并删除旧前端。

## Execution

- claim ticket 前把对应文件的 `Status` 改为 `claimed`。
- 只从 frontier 领取，即所有 `Blocked by` 均已 resolved。
- 完成后把 `Status` 改为 `resolved`，并在本文件 `Results` 追加结果摘要与验证证据。
- 每张 ticket 遵循已发布 Spec、领域词表、ADR 和对应技术分片；发生冲突时停止并报告，不自行改写产品边界。
- 17 是人工验收门槛；拆票批准不等于 cutover、删除数据或删除旧前端授权。

## Tickets

| ID | Ticket | Blocked by | Status |
|---|---|---|---|
| 01 | 冻结 CEO WarMap 视觉与交互证据 | None | resolved |
| 02 | 建立可登录的 Monorepo 纵向骨架 | None | resolved |
| 03 | 提供只读 CompanyMemory MCP 与稳定人员目录 | 02 | resolved |
| 04 | 跑通 global 与对象 Conversation | 02, 03 | resolved |
| 05 | 补齐 Search、compaction 与 Runtime 恢复 | 04 | resolved |
| 06 | 从真实来源生成可管理的 Signal | 02, 05 | resolved |
| 07 | 自动升级 Issue 并接收 DRI Issue | 03, 04, 05, 06 | resolved |
| 08 | 完成 Issue 预研与直接决定闭环 | 07 | resolved |
| 09 | 完成 Meeting 创建与会前准备 | 03, 05, 07 | resolved |
| 10 | 导入 Transcript 并抽取 MeetingOutcome | 09 | resolved |
| 11 | 逐项确认 MeetingOutcome 效果 | 06, 10 | ready-for-agent |
| 12 | 生成并协商 MonthlyPlan | 03, 05, 08 | resolved |
| 13 | 签发 MonthlyPlan 并刷新业务投影 | 06, 12 | ready-for-agent |
| 14 | 完成真实数据驱动的像素级 Web | 01, 08, 11, 13 | ready-for-agent |
| 15 | 建立全链测试、观测与安全门槛 | 14 | ready-for-agent |
| 16 | 完成 Compose 部署与真实外部验收 | 15 | ready-for-agent |
| 17 | 执行用户像素级验收与 cutover 授权 | 16 | ready-for-human |
| 18 | 切换生产入口并删除旧 frontend | 17 | ready-for-agent |

## Current frontier

- 11 逐项确认 MeetingOutcome 效果
- 13 签发 MonthlyPlan 并刷新业务投影

11 与 13 可以并行；其他 ticket 必须等待其真实 blocker resolved。

## Results

- 01 resolved：提交 `de96165`，冻结 46 张双视口截图、66 项公开交互断言、design tokens、health 与可重复采集工具；像素内容复跑一致，内部 Standards/Spec review 通过。
- 02 resolved：提交 `18f04cb`，跑通 Caddy → Web/API → PostgreSQL、CEO 登录、fixture Card、OpenAPI 客户端与 Action 幂等链；20 个测试、三包构建、Caddy/Compose/浏览器旅程通过，内部 Standards/Spec review 通过。
- 03 resolved：提交 `b5145b5`，提供四个只读 CompanyMemory MCP 工具、稳定 Person seed 校验与独立服务鉴权；contracts 6 + API 23 测试、构建和真实 endpoint smoke 通过。Master 消融审查删除了 603 行 CompanyMemory 重复副本，改为直接读取现有单一来源。
- 04 resolved：提交 `9826f0d`，跑通鉴权 Conversation HTTP/SSE、scope 隔离、可信 Card 快照、PostgreSQL 原始消息/runtime entries 恢复和受控 Pi + 只读 MCP；39 项测试、全 workspace typecheck/build 与双轴 review 通过。
- 05 resolved：提交 `92adfdb`，补齐自主 Search、180 秒/8 次保护、Pi compaction、entries 损坏重建、严格 Candidate Tool 与 AgentRun。Herdr review 的 5 项有效发现均经 red→green 修复；contracts 9 + API 46 测试、typecheck/build 通过。
- 06 resolved：提交 `cc2c2a5`，跑通 scheduled/manual Radar、Web/公众号来源规范化、严格候选到 Signal、独立 read/saved/dismissed 状态和真实 Card。Herdr review 修复全部有效发现；API 60 + contracts 11 测试、typecheck/build 通过。
- 07 resolved：提交 `77e7a48`，实现确定性 Signal promotion、Red deadline quote/location 门槛、DRI Issue import、pending research 和启动丢失恢复。Herdr reviewer 三轮收口无 blocking；contracts 12 + API 85 测试、typecheck/build 通过。
- 08 resolved：提交 `d1a0abb`，跑通唯一深度 ResearchDoc、CEO 直接决定与 Research Override、Dismissed Issue、统一 effect revoker 与幂等/冲突语义。Herdr deepseek-flash reviewer 三轮收口无 blocking；contracts 12 + API 106 测试、typecheck/build 通过。
- 09 resolved：提交 `8f85295`，跑通 Issue/DRI → Meeting、stable Person participant、Preflight、准备状态、Supplement Request 和 scheduled cancel。rebase 后 Herdr reviewer 确认 08/09 两条链无覆盖；contracts 15 + API 134 测试、typecheck/build 通过。
- 12 resolved：提交 `3818f78`，跑通 Company Day 唯一 MonthlyPlan draft、严格候选、显式 retry、versioned 编辑、stable Person todo 与 DRI feedback 幂等协商。Herdr deepseek-flash 双轴 review 无 blocking；contracts 19 + API 146 测试、typecheck/build 通过。
- 10 resolved：提交 `07c86d9`，跑通 Transcript v1 双入口整份校验、scheduled → held、严格 MeetingOutcome 抽取、失败重试和无 confirmed effect 时的危险替换。rebase 后 API 171 + contracts 22 测试、typecheck/build 通过。

## Comments
