# 06 · 代记门：月度计划签发、任务卡确认

Type: implementation
Status: in-progress（周期目标两门已实现，开关缺省关；Mission 两门等斯一答复）
Blocked by: 01、02

## 要做什么

人在天枢里完成确认后，天枢以代记写进本体的门（按 tkos.world/0.3）：

- 月度计划签发 = `world_commit_period_goal`（代 RU DRI）+ `world_confirm_period_goal`（代 CEO 刘明华）。
- 任务卡确认 = `world_commit_mission`（代 Mission DRI）+ `world_confirm_mission`（代 RU DRI）；承诺时带上天枢里本人改过的正式内容（候选随承诺提交）。
- 每次写入带 `on_behalf_of {principal_id, external_record_id:<天枢确认记录 id>, external_confirmed_at:<天枢确认时刻 +08:00>}`，不带写入声明；门事件时刻由服务端取写入时刻。

## 0.3 对照（2026-10-21，按本体仓库 origin/main 的 `docs/contracts/tkos-world-0.3.md`、`docs/world-v03-tianshu-examples.md` §5）

- 门表（契约 9.1）：承诺周期目标由 RU DRI（策略角色 DOMAIN_DRI）；确认由 CEO；承诺 Mission 由该 Mission 的 Mission DRI 本人（OWNER）；确认 Mission 由 RU DRI（DOMAIN_DRI）。门都属门族，可代记，只走 HTTP。
- 周期目标守卫（10.3）：承诺与确认接受都要「形成锚定」——`goal_ref` 指向已确认的长期目标，`review_ref` 指向已确认的公司复盘快照（首期可空）。
- Mission 守卫（10.4）：承诺与确认接受都要求父周期目标已确认；0.3 起承诺还要带 Task 全景（`execution_plan` 至少一条 `plan_item`，写 Task 名称与 `responsible`）。
- 候选（12）：草稿时承诺可带可不带；带了，确认接受时写回；不带，确认接受的是当时最新修订。Mission 的候选可含正式块、DRI 维护块（`mission_plan`，0.3 新类）与活动块（Task 全景）。
- 代记（14）：按被代记的人判权；委托过期、族或域不覆盖都回 `FORBIDDEN`。新增的建对象、修订两族要本人另行登记。

## 天枢动作 ↔ 门

| 天枢动作 | 门 | 代谁 | 状态 |
|-|-|-|-|
| CEO 签发月度计划（`monthlyPlans.ts` `executeSignMonthlyPlan`） | `world_commit_period_goal` | 该域的战场 DRI | 已实现 |
| 同上 | `world_confirm_period_goal` | 人员名单里 ceo 角色的人 | 已实现（74ca02e、b04eb03、2e08112） |
| 本人确认任务卡（`personalMissionCards.ts` 写 `owner_confirmed_at`） | `world_commit_mission` | Mission DRI 本人 | 等斯一 |
| 战场 DRI 确认任务组合（`missionRounds.ts` `executeConfirmMissionRound`） | `world_confirm_mission` | 这次确认的战场 DRI（`confirmed_by`） | 等斯一 |

`executeDecideMissionRound` 现在一律返回 `OWNER_RECONFIRMATION_REQUIRED`，不是承诺入口；本人承诺在任务卡上。

## 周期目标两门（已实现，`apps/api/src/worldPeriodGoals.ts`）

- 开关 `TKOS_WORLD_PERIOD_GOAL_GATES=1` 且实例配置允许写才启用，缺省关；只管这两门，会议卡、周复盘写入不受影响。
- 签发后立即跑一次、每 10 分钟补跑；只看最近一份已签发的计划。
- 先承诺：同周期的草稿，只承诺签发时那一版（推出草稿的事件和每次修订都记在签发之前），不带候选。代谁：本体里该域挂天枢战场（外部引用 `tianshu` / `battlefield:<id>`）的责任单元 → `battlefield_config.owner_id`；对不上唯一一位、或这个人在实例配置里没有本体主体，就不代（日志 `NO_UNIT_DRI`）。
- 再确认：已承诺、承诺记在签发之前，或这条承诺就是这次签发代记的（外部记录 `tianshu:plan-sign:<planId>`）。
- 幂等键一个目标版本一个：承诺 `tianshu:plan-sign:<planId>:commit:<id>:<version>`，确认 `tianshu:plan-sign:<planId>:<id>:<version>`。成功或失败（403 等）不再自动重试，进管理员失败列表；网络失败按原键重放。
- 没核实：TK 试用 scope 的 E&O 责任单元有没有挂 `battlefield:<id>`；天枢 E&O 战场的 `owner_id` 是谁；11 月的周期目标草稿谁建。签发时那位 RU DRI 在天枢里没有单独动作，外部记录用的是 CEO 那次签发。

## Mission 两门（设计，等斯一答复再写代码）

问斯一的两点：

1. 战场 DRI 一次确认整个战场的任务组合，能否按每个 Mission 各记一条 `world_confirm_mission`（外部记录都指同一次组合确认）。
2. 承诺要求 Task 全景至少一条计划条目；本人确认任务卡时还没有执行事项，怎么办。

按两点都答「可以」的设计：

- 承诺：本人确认任务卡后（异步，写法同周期目标服务），对卡上每个已挂本体的 Mission（外部引用 `mission:<code>`）代 Mission DRI 承诺，带候选：
  - `definition`：outcome → `outcome`（组件 id `outcome`）；successEvidence 逐条 → `acceptance_criterion`（`ac-1`…）；why → `contribution`；boundaries → `scope_boundary`；timeBoundary → `time_boundary`。
  - `mission_plan`：keyPath → `core_path`；milestones 逐条 → `milestone`；dependencies、risk → `constraint_dependency`；tradeoffs → `key_trade_off`（有则写）。
  - `execution_plan`：按第 2 点的答复。
  - 外部记录 `tianshu:card-confirm:<cardId>:<window_seq>`，时刻取 `owner_confirmed_at`。
- 确认：战场 DRI 确认组合后，对本轮每个 Mission 代 `confirmed_by` 记 `outcome: accepted`；外部记录 `tianshu:round-confirm:<roundId>:<window_seq>`。
- 硬拦截（10/10 对斯一说过）：确认人就是该 Mission 的 Mission DRI 时不写这一条。
- 还没定：
  - 拦截落在哪：拒掉天枢里的组合确认，或者组合照常确认、只是这一条不写并进失败列表。
  - 战场 DRI 退回任务卡时，本体那边已承诺的 Mission 要不要代记一条 `outcome: returned`。
  - 11 月的本体 Mission 谁建、怎么挂外部引用。现在只有 10 月三条硬编码（`worldMissions.ts` `WORLD_MISSION_LINKS`）。
  - 用同一个开关，还是另设一个。
- 前提：父周期目标已确认，所以周期目标两门要先跑通。

## 完成定义

- 示例 §5 请求／返回的桩测试；委托失效或范围外返回 403 时如实暴露、不重试；同一确认重放不产生第二条门事件。

## Content Pact（2026-09-30 本体告知；**已定：10/8 切换**，10/9 联调起按新块）

切换后承诺时带的候选只能用新块，带旧块（`acceptance`、`play`、`outcome`、`realization_logic`、`constraint`）prepare 即 422。依据：飞书接口清单第十四项、实测示例第 5 节（`world/0.2-pact` 分支）。

- 周期目标（`world_commit_period_goal`）：`target` 块，组件 `outcome`、`acceptance_criterion`（逐条）、`realization_logic`、`time_boundary`；`alignment` 可不带；无 `constraint`。
- Mission（`world_commit_mission`）：`definition` 块，组件 `outcome`（组件 id 用 `outcome`）、`acceptance_criterion`（沿用种子里的 `ac-1`、`ac-2`…）、`contribution`（天枢 why）、`scope_boundary`（boundaries）、`time_boundary`；`mission_plan` 块，组件 `core_path`（keyPath）、`milestone`（milestones 逐条）、`constraint_dependency`（dependencies、risk）、`key_trade_off`（有则写）。
- 叫法：Mission Owner → Mission DRI，Task 责任人 → Task DRI，单元 DRI → RU DRI（角色码与判权不变）。

## 2026-10-09 本体变化

- E&O 现有两位 RU DRI：于斯一、刘人豪（ids-20261009.json 里 eo-owner 新增 eo 域 DOMAIN_DRI）。代记 RU DRI 的门时按天枢里实际确认的人取 principal，不写死于斯一；代刘人豪走他已登记的委托。本体说这条还没实测，第一次写入留意返回。
- 待问本体：刘人豪的两个 Mission，Mission DRI 与 RU DRI 同为他本人时，同一人先承诺再确认是否允许。
