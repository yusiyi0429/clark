# 05: 补齐 Search、compaction 与 Runtime 恢复

Type: implementation
Status: resolved
Blocked by: 04 跑通 global 与对象 Conversation

## What to build

补齐 Conversation 和批处理 Agent 共用的受控 Runtime 能力：自主 Web Search、停止、超时保护、上下文压缩、损坏恢复和严格候选提交。

## Acceptance criteria

- [x] Chat 仅在当前对象和 CompanyMemory 不足时自主调用 Web Search，并区分内部证据、外部证据和推断。
- [x] 一次 turn 最长 180 秒、最多 8 次 Search；CEO 可停止正在运行的 turn。
- [x] 确定性 fake Search 覆盖免搜索、一次搜索、证据充分停止和异常次数终止。
- [x] compaction 只改变 runtime entries，PostgreSQL 原始 Conversation 消息保持完整。
- [x] entries 可经 JSON round-trip 和进程重建恢复；损坏时从当前对象与最近原始消息重建并留下可诊断记录。
- [x] 批处理 Agent 使用临时 Session 和严格 submit-candidate Tool，散文输出不能直接持久化为 Candidate Material。
- [x] 生产 Runtime 忽略用户级配置、Skills 和 Prompt，并关闭全部内置 coding tools。
- [x] AgentRun 保存输入快照、Prompt hash、状态、候选输出、错误、usage 与时间，失败不会自动重试或自动升档。

## Comments

- 实现：Conversation Runtime 新增可替换 Web Search adapter、8 次异常保护、180 秒 timeout/断线 abort、Pi 自动与恢复前 compaction checkpoint、entries 校验和最近 20 条原始消息重建；原始 Conversation 保持 append-only。
- 批处理：新增临时 Pi Session 的严格 `submit_candidate` seam；仅 Tool schema 通过的候选可返回，散文输出失败。Conversation 与批处理均保存 AgentRun 输入快照、Prompt hash、状态、输出/候选、错误、usage 与时间。
- 隔离：生产 ResourceLoader 继续返回零用户资源，Conversation 只开放 Web Search 与四个只读 CompanyMemory Tool，批处理只开放 `submit_candidate`，provider retry 关闭；确定性 fake Search 仅位于 test helper。真实 Search Provider 与凭据验收留 Ticket 16。
- Review：Herdr 只读 Standards/Spec 双轴 review 的 5 项有效发现已逐项修复并补 red→green：pre-aborted signal 不再调用模型、启用 Pi 自动 compaction 并 checkpoint、第 8 次 Search 返回 `SEARCH_BUDGET_EXHAUSTED`、fake 移出生产源码、移除未消费的 `HEAVY_MODEL` 必填配置。
- 验证：`pnpm test`（contracts 9、API 46）、`pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过；未改 `map.md`。
