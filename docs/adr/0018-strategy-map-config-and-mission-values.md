# 结构化战场图配置与 Mission 值对象

CEO WarMap 的战场图把长期战略映射（公司 LTCO、战场/能力六个月目标、Mission、主要支撑）与当月执行结果（MonthlyPlan 的 PCO）分开保存。长期配置是新的 Organization Fact 注册表：`CompanyStrategyConfig`、`BattlefieldConfig`、`CapabilityConfig` 与既有的 `RadarConfig`。当月公司/战场/能力结果仍然只属于 MonthlyPlan。

## 决策

1. **六个核心实体不变**：Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan、Conversation。战场图不引入第七个业务实体。
2. **Mission 是值对象**：`BattlefieldConfig.missions` 里只存 `{code,title}`。没有 Mission 表、状态机、进度、负责人或执行 UI；它只是战场内可被能力引用的只读战略映射。
3. **能力的主要支撑是内嵌引用联合**：`supportRefs` 允许 `{type:"mission",missionCode}`、`{type:"battlefield",battlefieldId}`、`{type:"all-battlefields"}`。引用必须命中已登记的战场或该战场的 mission code；不复制被引用对象的标题。
4. **长期配置与当月 PCO 分开**：Company LTCO、战场/能力六个月目标属于长期配置；当月公司结果、战场结果与能力结果（PCO）只属于 MonthlyPlan。MonthlyPlan 新增 `capabilities: [{capabilityId,outcome}]`，与既有 `battlefields` 同构。
5. **负责人只存 personId**：`battlefield_config.owner_id` 只保存 `company-people.v1` 的稳定 personId，投影 Card 与管理页时现查 displayName；不在注册表保存姓名副本。
6. **id 与显示属性解耦**：战场/能力 id 稳定，改名不改 id；`code`（显示编号）与 `sort_order` 独立于名称，列表按 `sort_order, code, id` 排序。

## 影响

- 长期配置由 CEO 通过确定性配置路由（`/api/config/strategy`、`/api/config/battlefields`、`/api/config/capabilities`）写入，不走 opaque-action；MonthlyPlan 的能力 PCO 仍走既有 versioned Action。
- 删除战场仍必须经过 `deleteBattlefield()` 的级联归一化，禁止裸 SQL 绕过议题关系。
- 迁移只改结构，不硬编码图片业务数据；staging 数据通过 API 与受控 SQL 事务导入，更新已签发 MonthlyPlan 必须 version+1 留证据。
- 关系图（`docs/diagrams/CEOwarmap_业务对象关系.*`）与 CONTEXT.md 的表述随之更新：禁止的是 Mission 执行实体，允许只读战略映射值对象。
