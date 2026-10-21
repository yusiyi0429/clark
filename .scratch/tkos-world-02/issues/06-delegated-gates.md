# 06 · 代记门：月度计划签发、任务卡确认

Type: implementation
Status: in-progress（周期目标两门已实现，开关缺省关；Mission 两门已按斯一 10/21 答复设计，代码未写）
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
| CEO 签发月度计划（`monthlyPlans.ts` `executeSignMonthlyPlan`） | `world_commit_period_goal` | 实例配置 `unit_dris` 写明的 RU DRI（eo → 于斯一） | 已实现 |
| 同上 | `world_confirm_period_goal` | 人员名单里 ceo 角色的人 | 已实现（74ca02e、b04eb03、2e08112） |
| 本人确认任务卡（`personalMissionCards.ts` 写 `owner_confirmed_at`） | `world_commit_mission` | Mission DRI 本人 | 等斯一 |
| 战场 DRI 确认任务组合（`missionRounds.ts` `executeConfirmMissionRound`） | `world_confirm_mission` | 这次确认的战场 DRI（`confirmed_by`） | 等斯一 |

`executeDecideMissionRound` 现在一律返回 `OWNER_RECONFIRMATION_REQUIRED`，不是承诺入口；本人承诺在任务卡上。

## 周期目标两门（已实现，`apps/api/src/worldPeriodGoals.ts`）

- 开关 `TKOS_WORLD_PERIOD_GOAL_GATES=1` 且实例配置允许写才启用，缺省关；只管这两门，会议卡、周复盘写入不受影响。
- 签发后立即跑一次、每 10 分钟补跑；只看最近一份已签发的计划。
- 先承诺：同周期的草稿，只承诺签发时那一版（推出草稿的事件和每次修订都记在签发之前），不带候选。代谁：实例配置 `unit_dris` 按域写明（`domains` 的键 → 天枢 personId，再经 `people` 取本体主体），MVP 配置写的是 eo → 于斯一（10/21 铭泽定）。没写的域、或写的人没有本体主体，就不代（日志 `NO_UNIT_DRI`）。被代记的人要本人登记覆盖门族和这个分区的委托。
- 再确认：已承诺、承诺记在签发之前，或这条承诺就是这次签发代记的（外部记录 `tianshu:plan-sign:<planId>`）。
- 幂等键一个目标版本一个：承诺 `tianshu:plan-sign:<planId>:commit:<id>:<version>`，确认 `tianshu:plan-sign:<planId>:<id>:<version>`。成功或失败（403 等）不再自动重试，进管理员失败列表；网络失败按原键重放。
- 为什么写配置、不从天枢推：E&O 在天枢里不是战场，是能力域 05（本体里它的责任单元挂 `capability:05`）。能力域本身没有负责人，负责人在整个能力建设这一层，所以天枢里推不出 E&O 的 RU DRI。
- 签发时那位 RU DRI 在天枢里没有单独动作，外部记录用的是 CEO 那次签发。11 月的周期目标草稿谁建，没核实。

## 斯一 10/21 的规则（所有代记门通用）

- 委托：`on_behalf_of` 只带 `principal_id`、`external_record_id`、`external_confirmed_at` 三项，不加指定委托的字段。本体在覆盖该动作族和目标分区的有效委托里取最早登记的一条，实际用了哪条写在回执 `on_behalf_of.delegation_event_id`。天枢把它存进 `world_sync_ledger.delegation_event_id`（迁移 201）。开代记后头几次真写要读回核对：如果是 `1bc680df`，说明开早了，停下告诉铭泽。`1bc680df` 不撤，10/31 到期，之后再开代记。
- 判权：每条都按被代记的人判。他要在对象所在分区持对应角色，并且本人登记过覆盖门族和这个分区的有效委托。天枢不代登委托，也不读取、索取任何人的本人凭证。
- 现状（斯一 10/21 下午）：v0.8.0 已上线，带人用的门命令 `tkos-gate`，登委托用 `tkos-gate --api … delegate --to <受托方> --families gate --domains <分区,逗号无空格> --until <时刻>`（`--api` 在 `delegate` 前；一行一个 `--to`）。
  - 群通知由本体团队统一发，每人登两条：一条给天枢（只给门族，到 2026-12-31T23:59:59+08:00），一条给自己的 Agent。
  - 明华要跑的三份脚本已发在他的单聊里（只用系统 Python，粘 ceo.token、输 y；做过的会跳过）：`minghua-confirm-20261019.py`（确认三个六个月目标，并登给天枢的委托：门族，公司加 10 个单元分区，到 12/28，和其他人的 12/31 不同）、`minghua-lighthouse-gates-20261020.py`（灯塔三步）、`minghua-method-confirm-20261021.py`（确认 Method 10 月目标）。约他共享屏幕、本人跑，凭证不经我们手；跑完每份最后几行发斯一。
  - 秦梦怡、唐巨杰不提前单签：明华三份跑完、本体只读核过之后，10 人一起重签本人凭证，再登委托。他俩的周期目标承诺本来也要等明华确认他们的六个月目标（承诺守卫要求长期目标已确认）。赶不上 11/3 的，天枢代承诺被拒（403），记失败、不重试，他们拿到新凭证后用 tkos-gate 本人承诺。
  - 关键路径：明华跑完那三份。
  - 重签本人凭证不影响已登的委托（本体按委托人的主体和角色判，不看凭证）。
  - 任务卡确认只用门族；生命周期族（确认完成）V1 不用。
  - 第一次真写进 scope `a92430fd`。

## Mission 两门（设计，按斯一 10/21 答复；代码未写）

- 承诺：本人确认任务卡后（异步，写法同周期目标服务），对卡上每个已挂本体的 Mission（外部引用 `mission:<code>`）代 Mission DRI 承诺，带候选：
  - `definition`：outcome → `outcome`（组件 id `outcome`）；successEvidence 逐条 → `acceptance_criterion`（`ac-1`…）；why → `contribution`；boundaries → `scope_boundary`；timeBoundary → `time_boundary`。
  - `mission_plan`：keyPath → `core_path`；milestones 逐条 → `milestone`；dependencies、risk → `constraint_dependency`；tradeoffs → `key_trade_off`（有则写）。
  - `execution_plan`：这个 Mission 下真实的 Task，每条写名称和 Task DRI（`responsible`），组件 id 用天枢执行事项 id；随承诺的候选一起带，不先单独修订。
  - 一条真实的 Task 都没有就不发承诺，提示 Mission DRI 先补 Task；不生成占位条目。
  - 外部记录 `tianshu:card-confirm:<cardId>:<window_seq>`，时刻取 `owner_confirmed_at`。
- 确认：战场 DRI 一次确认整个组合，落到本体时每个 Mission 一条 `world_confirm_mission`（`outcome: accepted`）。
  - 代谁：Mission 所在单元的 RU DRI，不是天枢里点确认的战场 DRI（斯一 10/21）。E&O 按 10/10 的对应关系：人豪的 Mission（renhao-202610-b、c）由斯一确认，斯一的 siyi-202610-1 由人豪确认。斯一保留 E&O 的 DOMAIN_DRI 就是为此。
  - 待定：天枢里点确认的人和本体里被代记的 RU DRI 不是同一个人时，外部记录指向的是战场 DRI 的那次确认，同周期目标承诺一样。
  - 每条单独请求、单独事务、各用各的幂等键。
  - 可以共用外部记录 `tianshu:round-confirm:<roundId>:<window_seq>` 和确认时刻（不晚于记录时刻）。
  - 每条单独成败：某个 Mission 还没承诺、父周期目标没确认、委托不覆盖等，只有这一条失败，其他照常。失败的 Mission 和原因单独告诉确认人，已成功的不受影响。
- 硬拦截（10/10 对斯一说过）：被代记的 RU DRI 就是该 Mission 的 Mission DRI 时不写这一条；E&O 有两位 RU DRI，按上面的对应关系取另一位。
- 还没定：
  - 拦截落在哪：拒掉天枢里的组合确认，或者组合照常确认、只是这一条不写，告诉确认人。
  - 战场 DRI 退回任务卡时，本体那边已承诺的 Mission 要不要代记一条 `outcome: returned`。
  - 11 月的本体 Mission 谁建、怎么挂外部引用。现在只有 10 月三条硬编码（`worldMissions.ts` `WORLD_MISSION_LINKS`）。
  - 天枢里 Task 什么时候有。本人确认任务卡时多半还没有执行事项，按上面的规则就不承诺，要等 Task 出来再补发；补发由什么触发要定。
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
