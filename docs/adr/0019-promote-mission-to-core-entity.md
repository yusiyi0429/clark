# Mission 升为第七个核心实体

Mission 从 `BattlefieldConfig` 内嵌的只读值对象升为版本化 Organization Fact，WarMap 的核心实体从六个变为七个：Signal、Issue、Meeting、MeetingOutcome、MonthlyPlan、Conversation 与 Mission。Mission 承载一个周期的结果承诺（Outcome）、唯一 DRI、一个主要能力域、零到多个战场、成功证据、关键里程碑、关键依赖、风险、边界与来源元数据，通过 `period` 承接同周期 MonthlyPlan 的 PCO；执行过程仍留在外部 DRI 流程，WarMap 不保存 Task、Activity、执行状态或完成率。

## 决策

1. **七个核心实体**：核心实体新增 Mission；其余六个生命周期不变。
2. **Mission 是版本化 Organization Fact**：`missions` 表持有稳定 id、`version`、`period`、`code`、`title`、`owner_id`、`capability_id`、`battlefield_ids`、Outcome、Why、成功证据、关键里程碑、关键依赖、风险、边界与飞书来源元数据。`code` 只在 Mission 表内唯一；它与战场战略锚点的 code 是两套命名空间，可以重名。
3. **旧 `BattlefieldConfig.missions` 改名 `missionAnchors`**：战场图上的 `{code,title}` 只是战略锚点，不再是 Mission Card；`CapabilityConfig.supportRefs` 的 `{type:"mission"}` 同步改为 `{type:"mission-anchor"}`，语义仍是“这个能力支撑某个战场战略锚点”。
4. **编辑走 opaque Action，首次导入走 CEO 配置 POST**：Mission 已有版本，编辑必须是 `mission.edit`（`version` 锚 + fingerprint 幂等，冲突返回 latestCard）；首次导入没有既有版本可锚，走 `/api/config/missions` 的 CEO 配置写入。
5. **关系必须命中已登记对象**：`owner_id` 命中 `company-people.v1`，`capability_id` 命中 `capability_config`，`battlefield_ids` 命中 `battlefield_config`，`period` 是 `YYYY-MM`。删除战场必须在同一事务里把该战场从所有 Mission 的 `battlefield_ids` 移除并 `version+1`，与既有的议题归一化同级联。
6. **来源只做一次性导入**：Mission Card 的飞书正文只在导入时读取；仓库、Card 与证据目录不保存正文副本。来源以 `source_document_id` + `source_revision` 固定，外部文档更新不会自动覆盖已确认字段。

## 影响

- 契约新增 Mission 领域 schema（Card payload、创建请求、编辑 Action 输入）与 `/api/config/missions`、`/api/cards/missions`、`/api/cards/missions/{id}` 读路径；Web 新增 Mission 总览、详情与配置页面。
- 迁移 `021` 重命名 `battlefield_config.mission_anchors`、把 `capability_config.support_refs` 的 `mission` 改写为 `mission-anchor`，并新建 `missions` 表；迁移只改结构，21 条真实 Mission 通过 API 导入。
- `docs/diagrams/CEOwarmap_业务对象关系.*` 已按七实体口径更新；ADR 0018 的“Mission 值对象”结论由本 ADR 取代。
