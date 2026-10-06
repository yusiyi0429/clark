# 06 · 代记门：月度计划签发、任务卡确认

Type: implementation
Status: needs-triage
Blocked by: 01、02

## 要做什么

人在天枢里完成确认后，天枢以代记写进本体的门：

- 月度计划签发 = `world_commit_period_goal`（代 E&O DRI 于斯一）+ `world_confirm_period_goal`（代 CEO 刘明华）；目标是 E&O 十月周期目标（本体已建草稿）。
- 任务卡确认 = `world_commit_mission`（代 Owner）+ `world_confirm_mission`（代 DRI）；承诺时带上天枢里本人改过的正式内容（候选随承诺提交）。
- 每次写入带 `on_behalf_of {principal_id, external_record_id:<天枢确认记录 id>, external_confirmed_at:<天枢确认时刻 +08:00>}`，不带写入声明；门事件时刻由服务端取写入时刻。

## 待定（triage）

- 天枢里「Owner 承诺」与「DRI 确认」分别对应哪个动作：任务卡流程在 `apps/api/src/missionRounds.ts`（`executeDecideMissionRound`／`executeConfirmMissionRound`），月度计划在 `apps/api/src/monthlyPlans.ts`（`executeSignMonthlyPlan`）。需要确认天枢是否有「Owner 本人承诺」这一步；没有时是否在 DRI 确认时同时代记两条（先 Owner 承诺、后 DRI 确认）。
- 候选内容字段如何从天枢个人任务映射到 Mission 块（定义、验收标准、打法等），对照示例 §5 与 0.2 登记。

## 完成定义

- 示例 §5 请求／返回的桩测试；委托失效或范围外返回 403 时如实暴露、不重试；同一确认重放不产生第二条门事件。

## Content Pact（2026-09-30 本体告知；**已定：10/8 切换**，10/9 联调起按新块）

切换后承诺时带的候选只能用新块，带旧块（`acceptance`、`play`、`outcome`、`realization_logic`、`constraint`）prepare 即 422。依据：飞书接口清单第十四项、实测示例第 5 节（`world/0.2-pact` 分支）。

- 周期目标（`world_commit_period_goal`）：`target` 块，组件 `outcome`、`acceptance_criterion`（逐条）、`realization_logic`、`time_boundary`；`alignment` 可不带；无 `constraint`。
- Mission（`world_commit_mission`）：`definition` 块，组件 `outcome`（组件 id 用 `outcome`）、`acceptance_criterion`（沿用种子里的 `ac-1`、`ac-2`…）、`contribution`（天枢 why）、`scope_boundary`（boundaries）、`time_boundary`；`mission_plan` 块，组件 `core_path`（keyPath）、`milestone`（milestones 逐条）、`constraint_dependency`（dependencies、risk）、`key_trade_off`（有则写）。
- 叫法：Mission Owner → Mission DRI，Task 责任人 → Task DRI，单元 DRI → RU DRI（角色码与判权不变）。
