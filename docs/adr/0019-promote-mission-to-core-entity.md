# Mission 升为独立核心实体

本文保留实体提升的决策。当前挂卡编辑、本人确认和更正权限以[任务卡契约](../contracts/mission-card-preparation-review.v0.1.md)为准。下文“七个实体”是当时范围，不是当前完整数据表清单。

Mission 从 `BattlefieldConfig` 内嵌的只读值对象升为版本化 Organization Fact，WarMap 的核心实体从六个变为七个：Signal、Issue、Meeting、MeetingOutcome、MonthlyPlan、Conversation 与 Mission。Mission 承载一个周期的结果承诺（Outcome）、唯一 DRI、一个主要能力域、零到多个战场、成功证据、关键里程碑、关键依赖、风险、边界与来源元数据，通过 `period` 承接同周期 MonthlyPlan 的 PCO；Mission 不保存 Task、Activity、执行状态或完成率。

> 2026-09-27 修订：[ADR-0022](./0022-persist-monthly-mission-card-rounds.md) 引入本月 Mission Card 制定轮次。挂在个人卡上的 Mission 可以先以草稿入库，整轮确认前属于候选，不是已生效的 Organization Fact；月度计划签发不代替个人承诺确认。

## 决策

1. **七个核心实体**：核心实体新增 Mission；其余六个生命周期不变。
2. **已确认 Mission 是版本化 Organization Fact**：`missions` 表持有稳定 id、`version`、`period`、`code`、`title`、`owner_id`、`capability_id`、`battlefield_ids`、Outcome、Why、成功证据、关键里程碑、关键依赖、风险、边界与飞书来源元数据；本月个人卡补齐关键路径、资源与权限、人-Agent 分工、复盘沉淀。挂卡 Mission 是否已经确认由 `personalCard.status` 表达，`placeholder` 只标来源。`code` 只在 Mission 表内唯一；它与战场战略锚点的 code 是两套命名空间，可以重名。
3. **旧 `BattlefieldConfig.missions` 改名 `missionAnchors`**：战场图上的 `{code,title}` 只是战略锚点，不再是 Mission Card；`CapabilityConfig.supportRefs` 的 `{type:"mission"}` 同步改为 `{type:"mission-anchor"}`，语义仍是“这个能力支撑某个战场战略锚点”。
4. **编辑路径按是否挂个人卡区分**：未挂卡的 Mission 仍用 `mission.edit`（`version` 锚 + fingerprint 幂等，冲突返回 latestCard），首次登记走 `/api/config/missions` 的 CEO 配置写入。挂卡 Mission 在所有阶段都禁止普通编辑，返回 409 `MISSION_IN_MISSION_CARD`；草稿整理走拍板人的 `mission-round.draft` 或共用函数的导入脚本，确认写回由 `mission-round.confirm` 在整轮事务中承担，只更新已采纳字段，每个涉及采纳修改的 Mission 仅升一次版本。已确定后不能用普通编辑绕过，最小纠错方式仍待 GAP-04 定义。
5. **关系必须命中已登记对象**：`owner_id` 命中 `company-people.v1`，`capability_id` 命中 `capability_config`，`battlefield_ids` 命中 `battlefield_config`，`period` 是 `YYYY-MM`。战场下已有 Mission Card 轮次时删除返回 409；没有轮次时，删除仍须在同一事务里把该战场从所有 Mission 的 `battlefield_ids` 移除并 `version+1`，与既有的议题归一化同级联。
6. **来源可追溯，不自动覆盖**：Mission Card 的飞书全文只作为导入输入，仓库、Card 与证据目录不保存全文副本；结构化个人任务字段与来源元数据可以持久化。来源以 `source_document_id` + `source_revision` 固定，外部文档更新不会自动覆盖已确认字段。10 月讨论候选从 9 月个人卡整理，使用只读 `mission-card-drafts.v1`，明确保留占位说明、原文档版本与文件 sha256；同文件重跑不改内容，变更文件拒绝覆盖，确认后也保留占位来源标记。

## 影响

- 契约新增 Mission 领域 schema（Card payload、创建请求、编辑 Action 输入）与 `/api/config/missions`、`/api/cards/missions`、`/api/cards/missions/{id}` 读路径；Web 新增 Mission 总览、详情与配置页面。
- 迁移 `021` 重命名 `battlefield_config.mission_anchors`、把 `capability_config.support_refs` 的 `mission` 改写为 `mission-anchor`，并新建 `missions` 表；迁移只改结构，21 条真实 Mission 通过 API 导入。
- `docs/diagrams/CEOwarmap_业务对象关系.*` 已按七实体口径更新；ADR 0018 的“Mission 值对象”结论由本 ADR 取代。
