# 11: 逐项确认 MeetingOutcome 效果

Type: implementation
Status: ready-for-agent
Blocked by: 06 从真实来源生成可管理的 Signal; 10 导入 Transcript 并抽取 MeetingOutcome

## What to build

让 CEO 分别处理 MeetingOutcome 的 decision、todo、CEO judgment 和 reopenWhen；每项确认后立即产生精确效果，忽略或撤回一项不影响其他项。

## Acceptance criteria

- [ ] 每个可审阅 item 独立处于 pending、confirmed 或 dismissed，open item 只展示且不能创建 Issue。
- [ ] decision confirmation 创建精确 Issue Receipt；todo confirmation 创建带真实状态的 DRI Handoff。
- [ ] CEO judgment 保留在 MeetingOutcome，不直接写入 CompanyMemory。
- [ ] reopenWhen 只能在父 decision confirmed 后确认并写入 Radar anchor；父 decision dismissed 或撤回时同步清理子条件和 anchor。
- [ ] confirm 与 dismiss 使用 Outcome version 串行，重复 action fingerprint 不产生第二个 effect。
- [ ] `revokeEffect(effectRef)` 同步处理 Outcome item、Receipt、Radar anchor、Handoff 可撤销部分和 Meeting 派生状态。
- [ ] 已 delivered 的外部效果按契约禁用撤回或返回明确 warning，不报告虚假恢复。
- [ ] 至少两个 item 可分别确认；撤回其中一个后另一个 effect 保持不变。
- [ ] 全部可审阅 item 已 confirmed 或 dismissed 时 Meeting 自动进入 reviewed。

## Comments
