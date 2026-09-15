# 01: 冻结 CEO WarMap 视觉与交互证据

Type: implementation
Status: resolved
Blocked by: None (can start immediately)

## What to build

冻结旧 CEO WarMap 在目标 scope 内的可复现视觉与交互证据，使后续新 Web 能依据客观基线完成像素级验收，而不是依靠记忆比较。

## Acceptance criteria

- [ ] 目标页面、入口和状态清单覆盖首页、Issue、Meeting、Radar、Signal、MonthlyPlan、通知浮卡、战场翻转、Conversation dock 与引用托盘。
- [ ] 在 1440×900 和 1600×1000 保存稳定截图，并记录字体、颜色、阴影、间距和 Card 几何。
- [ ] 记录关键动画终态、键盘焦点、Escape 返回和 reduced-motion 行为。
- [ ] 建立仅用于视觉比较的等长 fixture；它不成为新系统业务数据源。
- [ ] 记录旧入口与 health 状态，所有证据可由后续视觉检查重复使用。
- [ ] 本 ticket 不修改目标业务行为，也不删除旧前端。

## Comments
