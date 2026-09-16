# 14: 完成真实数据驱动的像素级 Web

Type: implementation
Status: resolved
Blocked by: 01 冻结 CEO WarMap 视觉与交互证据; 08 完成 Issue 预研与直接决定闭环; 11 逐项确认 MeetingOutcome 效果; 13 签发 MonthlyPlan 并刷新业务投影

## What to build

把全部目标 Card、Action 和 Conversation 接入新 Web，在真实 API 数据上恢复 CEO WarMap 已确认的桌面布局、微交互和稳定对象导航。

## Acceptance criteria

- [x] 登录、首页、Issue、Meeting、Radar、Signal 和 MonthlyPlan 具有稳定 URL，刷新、回退和直接打开均可定位对象。
- [x] 每种 Card kind 使用固定 React renderer；未知 kind 明确失败，不引入通用布局 DSL。
- [x] 首页展示公司战略、战场、能力、Radar 和对象投影通知，所有 Issue 入口进入统一 Issue 页面。
- [x] 通知浮卡、战场翻转、对象页过渡、底部 Conversation dock 和引用托盘接真实 API。
- [x] Action client 只提交 opaque actionId、version 与合法 input，展示 pending、conflict、error 和 retry 状态。
- [x] Web 不保存业务数据、状态迁移或模型选择，不使用 localStorage 持久化业务状态，也不包含业务 API route。
- [x] 1440×900 和 1600×1000 的 scope 内视觉回归满足冻结基线；动画、焦点、Escape、reduced-motion 和 accessible name 单独通过。
- [x] 新增失败、上传和重试状态复用现有视觉语言，全部后端 fixture 分支从目标路由移除。
- [x] 本 ticket 不删除旧前端。

## Comments

- 路由集合：`/access`、`/`、`/issues/[id]`、`/meetings/[id]`、`/radar`、`/radar/signals/[id]`、`/plans/[period]`；刷新/回退/直达均验证过，旧 `login` 与 `signals` 路由已移除。
- Card renderer 注册表固定 6 个 kind；未知 kind 走 `UnsupportedCard`（role=alert）且有自动化检查（`registry.test.tsx`）。
- Action 只提交 `actionId` + input，409 用 `latestCard` 刷新并要求重新核对；纯函数 seam `interpretActionResponse` 有 409/401/400 检查（`actionResponse.test.ts`）。
- Web 侧无业务 localStorage、无 `app/api` 业务 route（仅 `/healthz`）；全部业务读写走 apps/api。
- API 侧清理：`/api/cards/home` 改为真实组合，删除 fixture 回退与 `src/fixture.ts`/`src/actions.ts`，新增 `012_drop_fixture_tables.sql` 删除两张 fixture 表。
- 对象页过渡：来源矩形由首页点击写入模块变量，直达 URL 只渲染终态；测量到 948→412 的 380ms 展开且 reduced-motion 下 duration=0。
- 视觉复核记录见 `.scratch/ceo-warmap-mvp/evidence/web14/verification.json`（几何、交互、reduced-motion 取证方式、已知偏差、内部评审结论）。
- 内部评审：Herdr 只读 `deepseek-flash` 双轴评审，第一轮 AxisA red / AxisB red（3 条 red：MonthlyPlan 核对项与服务端漂移、监测范围对话框无 Escape/焦点、对象页展开动画缺失），修复后第二轮 AxisA green / AxisB green；第二轮新增的 3 条问题（重置吞掉未保存输入、来源矩形无生命周期、引用选择器未进 Escape 分层）也已修复复测。
- 已知偏差（未伪造）：capability/战场归属文案直接展示真实 `capabilityId`/`battlefieldId`（API 无能力名称注册表）；Signal 状态与 Radar 补扫沿用既有专用端点（契约无对应 Action）；无面向 CEO 的人员目录端点故未实现 create-meeting UI；监测范围对话框只读；本地 PI provider 无效，Conversation 成功流与 Agent 成功路径只能验证如实失败态。
