# 17: 执行用户像素级验收与 cutover 授权

Type: human-gate
Status: ready-for-human
Blocked by: 16 完成 Compose 部署与真实外部验收

## What to build

由用户在 staging 审阅完整 CEO WarMap，明确确认像素级交互、生产切换、回滚条件以及删除旧前端的授权。拆票或实现批准不能替代本门槛。

## Acceptance criteria

- [ ] 用户实际审阅首页、Issue、Meeting、Radar、Signal、MonthlyPlan、通知、战场翻转、Conversation 和引用交互。
- [ ] 用户确认 1440×900 与 1600×1000 的 scope 内视觉和关键微交互可接受。
- [ ] 用户确认真实 Radar、预研、决定、MeetingOutcome、MonthlyPlan 和 Conversation 旅程满足 MVP。
- [ ] 用户审阅 production cutover、观察窗口和回滚条件。
- [ ] 用户以明确文字授权切换生产入口。
- [ ] 用户以明确文字授权在切换稳定后整体删除旧 `frontend/`；未授权时 18 不得开始。

## Comments
