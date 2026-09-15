# 05: 补齐 Search、compaction 与 Runtime 恢复

Type: implementation
Status: ready-for-agent
Blocked by: 04 跑通 global 与对象 Conversation

## What to build

补齐 Conversation 和批处理 Agent 共用的受控 Runtime 能力：自主 Web Search、停止、超时保护、上下文压缩、损坏恢复和严格候选提交。

## Acceptance criteria

- [ ] Chat 仅在当前对象和 CompanyMemory 不足时自主调用 Web Search，并区分内部证据、外部证据和推断。
- [ ] 一次 turn 最长 180 秒、最多 8 次 Search；CEO 可停止正在运行的 turn。
- [ ] 确定性 fake Search 覆盖免搜索、一次搜索、证据充分停止和异常次数终止。
- [ ] compaction 只改变 runtime entries，PostgreSQL 原始 Conversation 消息保持完整。
- [ ] entries 可经 JSON round-trip 和进程重建恢复；损坏时从当前对象与最近原始消息重建并留下可诊断记录。
- [ ] 批处理 Agent 使用临时 Session 和严格 submit-candidate Tool，散文输出不能直接持久化为 Candidate Material。
- [ ] 生产 Runtime 忽略用户级配置、Skills 和 Prompt，并关闭全部内置 coding tools。
- [ ] AgentRun 保存输入快照、Prompt hash、状态、候选输出、错误、usage 与时间，失败不会自动重试或自动升档。

## Comments
