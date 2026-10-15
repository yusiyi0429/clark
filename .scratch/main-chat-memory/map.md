# 主私聊记忆改造 · 执行入口

Status: implementation-in-progress

用户已确认 7 张垂直切片、公共测试边界与最终 review 基线 `b32e531eb2df7e0396393877aa509569364fde9a`。

| # | Ticket | Blocked by | Status |
| --- | --- | --- | --- |
| 01 | [01-people-directory](issues/01-people-directory.md) | 无 | ready-for-agent |
| 02 | [02-scene-anchor](issues/02-scene-anchor.md) | 无 | ready-for-agent |
| 03 | [03-world-company](issues/03-world-company.md) | 01 | ready-for-agent |
| 04 | [04-personal-memory](issues/04-personal-memory.md) | 01 | ready-for-agent |
| 05 | [05-natural-distillation](issues/05-natural-distillation.md) | 04 | ready-for-agent |
| 06 | [06-remove-legacy-mcp](issues/06-remove-legacy-mcp.md) | 01、03 | ready-for-agent |
| 07 | [07-integrate-review](issues/07-integrate-review.md) | 02–06 | ready-for-agent |

[批准的拆分与测试边界](ticket-breakdown.md) · [上下文规格](context-contract.md) · [记忆设计](memory-design.md) · [研究与预验证](validation.md) · [验收样例](evaluation-cases.json)

原六张横向工单移入 design-history，仅作为历史，不派发。每票记录 TDD、测试、两轴 review 与提交，最终整体做 PR 级审查。真实 World/模型联调限制如实保留，不以本地桩通过代替。
