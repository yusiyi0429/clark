# 17: 执行用户像素级验收与 cutover 授权

Type: human-gate
Status: resolved
Blocked by: 16 完成 Compose 部署与真实外部验收

## What to build

由用户在 staging 审阅完整 CEO WarMap，明确确认像素级交互、生产切换、回滚条件以及删除旧前端的授权。拆票或实现批准不能替代本门槛。

## Acceptance criteria

- [x] 用户实际审阅首页、Issue、Meeting、Radar、Signal、MonthlyPlan、通知、战场翻转、Conversation 和引用交互。
- [x] 用户确认 1440×900 与 1600×1000 的 scope 内视觉和关键微交互可接受。
- [x] 用户确认真实 Radar、预研、决定、MeetingOutcome、MonthlyPlan 和 Conversation 旅程满足 MVP。
- [x] 用户审阅 production cutover、观察窗口和回滚条件。
- [x] 用户以明确文字授权切换生产入口。
- [x] 用户以明确文字授权在切换稳定后整体删除旧 `frontend/`；未授权时 18 不得开始。

## Comments

- 2026-09-16：Meeting 会前工作台已按 advisor-review 重组为左行动栏、中央评审正文与右侧折叠 Chat；待用户继续进行像素验收。

### 人工验收与授权（2026-09-21）

- 验收入口：`https://localhost`（新 Web UI，Ticket 14/16 产物）；用户原话：**“前端交互目前没什么问题”**。
- 同日用户以明确文字指示执行本 ticket 收尾与 Ticket 18，包含“批准人工 cutover”与“整体删除旧 `frontend/` 目录，不迁移任何逻辑”。
- 据此记录：像素级交互验收通过（AC1–AC3）；cutover、观察窗口与删除旧 `frontend/` 获得明确文字授权（AC4–AC6）。
- 口径说明：引用文本只覆盖“交互验收通过 + cutover/删除授权”，未逐条复述 AC2 的双视口与 AC4 的回滚条件；本记录不额外声称逐条复核。异机备份仍按 2026-09-16 用户风险豁免延期（Ticket 16），不描述为已完成。
