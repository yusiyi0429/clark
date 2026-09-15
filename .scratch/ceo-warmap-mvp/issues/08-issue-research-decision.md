# 08: 完成 Issue 预研与直接决定闭环

Type: implementation
Status: ready-for-agent
Blocked by: 07 自动升级 Issue 并接收 DRI Issue

## What to build

从 pending Issue 跑通唯一深度的 ResearchDoc、CEO 直接决定、Research Override、Dismissed Issue 和精确撤回，使正式 Organization Fact 只来自确定性 Action。

## Acceptance criteria

- [ ] research 状态可观察为 pending、running、ready、failed，失败原因在 Issue Card 原位展示。
- [ ] ResearchDoc 包含摘要、选择、后果、证据、未知和来源，并由严格 candidate schema 校验后整份保存。
- [ ] 只有 pending Issue 可显式重跑预研；重跑整份替换当前 doc，旧 run 保留，Conversation 不能局部改写。
- [ ] ready research 下 CEO 可选择建议并编辑最终决定文本；Receipt 保存最终文本与当时 research 状态。
- [ ] pending 或 failed research 只能经二次确认执行 Research Override，Receipt 明确记录 override。
- [ ] CEO 可将误升级 Issue 变为 dismissed，保留 originRef 与 promotion fingerprint且不物理删除。
- [ ] 重放相同 Action 只产生一个 Receipt/effect；旧 version 的新 fingerprint 返回冲突和最新 Card。
- [ ] 所有撤回进入统一 effect revoker，并恢复准确 Issue 状态；外部不可逆效果不得声称已全部恢复。
- [ ] Issue 页面、Card、通知投影和独立 Conversation 使用同一持久业务对象。

## Comments
