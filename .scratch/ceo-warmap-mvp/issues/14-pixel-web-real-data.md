# 14: 完成真实数据驱动的像素级 Web

Type: implementation
Status: ready-for-agent
Blocked by: 01 冻结 CEO WarMap 视觉与交互证据; 08 完成 Issue 预研与直接决定闭环; 11 逐项确认 MeetingOutcome 效果; 13 签发 MonthlyPlan 并刷新业务投影

## What to build

把全部目标 Card、Action 和 Conversation 接入新 Web，在真实 API 数据上恢复 CEO WarMap 已确认的桌面布局、微交互和稳定对象导航。

## Acceptance criteria

- [ ] 登录、首页、Issue、Meeting、Radar、Signal 和 MonthlyPlan 具有稳定 URL，刷新、回退和直接打开均可定位对象。
- [ ] 每种 Card kind 使用固定 React renderer；未知 kind 明确失败，不引入通用布局 DSL。
- [ ] 首页展示公司战略、战场、能力、Radar 和对象投影通知，所有 Issue 入口进入统一 Issue 页面。
- [ ] 通知浮卡、战场翻转、对象页过渡、底部 Conversation dock 和引用托盘接真实 API。
- [ ] Action client 只提交 opaque actionId、version 与合法 input，展示 pending、conflict、error 和 retry 状态。
- [ ] Web 不保存业务数据、状态迁移或模型选择，不使用 localStorage 持久化业务状态，也不包含业务 API route。
- [ ] 1440×900 和 1600×1000 的 scope 内视觉回归满足冻结基线；动画、焦点、Escape、reduced-motion 和 accessible name 单独通过。
- [ ] 新增失败、上传和重试状态复用现有视觉语言，全部后端 fixture 分支从目标路由移除。
- [ ] 本 ticket 不删除旧前端。

## Comments
