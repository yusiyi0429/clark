# Ticket 26 · 战场图结构化模型（A+B）

Type: feature
Status: planned
Blocked by: none
来源: 词元云集《战场图 V1》图片导入 + 用户选择 A+B
视觉基线: `UpgradeDesign.pen`
关系图: `docs/diagrams/CEOwarmap_业务对象关系.{architecture.json,html}`

## 决策（已定）

1. 六个核心实体不变：Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan、Conversation。
2. 新增/明确配置：CompanyStrategyConfig、BattlefieldConfig、CapabilityConfig、RadarConfig。
3. Mission 只作为 BattlefieldConfig 的内嵌值对象 `{code,title}`；没有表、状态机、进度、执行 UI。
4. Capability 的 `supportRefs` 是内嵌引用联合：
   - `{type:"mission", missionCode}`
   - `{type:"battlefield", battlefieldId}`
   - `{type:"all-battlefields"}`
5. Company LTCO、战场/能力六个月目标属于长期配置；当月公司/战场/能力 PCO 只属于 MonthlyPlan。
6. Person 仍来自只读企业知识人员目录；战场只存 `ownerId`，Card/管理投影现查 displayName。
7. 战场/能力 id 稳定，改名不改 id；`code` 与 `sortOrder` 独立于名称。
8. 用户选择 A 已授权删除旧 fixture「增长战场」；删除仍走现有级联归一化函数，禁止裸 SQL 绕过议题关系。
9. 图片中的战场、能力、LTCO、Mission、主要支撑、2026-09 战场/能力 PCO 均导入 staging；更新 confirmed MonthlyPlan 是本次 CEO 明确授权的数据修订，必须 version+1 并留证据。

## W1 · 领域契约、ADR、数据库

- 新 ADR `0018-strategy-map-config-and-mission-values.md`：说明六实体边界、长期配置、Mission 值对象、MonthlyPlan PCO。
- 更新 `CONTEXT.md` 与 spec 中“仅两配置/不使用 Mission”的旧表述：禁止的是 Mission 执行实体；允许只读战略映射值对象。
- migration 019：
  - `company_strategy_config(id='default', version, ltco, updated_at)`；
  - battlefield_config：`positioning -> six_month_outcome`、`owner -> owner_id`，新增 `code`、`sort_order`、`missions JSONB`；
  - capability_config：`description -> six_month_outcome`，新增 `code`、`sort_order`、`support_refs JSONB`；`group` 保留但允许空；
  - monthly_plans 新增 `capabilities JSONB NOT NULL DEFAULT '[]'`；
  - code 非空时同表唯一，sort_order 有界；JSONB 默认数组。
- 迁移不写图片业务数据；staging 数据在 W5 通过应用/API + 审计 SQL 导入。
- contracts：Create/Patch/Management/Card payload 全面使用结构化字段；ownerId 可空；code 必填、sortOrder 整数；新增 Strategy GET/PATCH 契约；MonthlyPlanCapability 加入 candidate/card/update。
- gen:client；contract tests。

## W2 · API 配置与投影

- `/api/config/strategy` GET/PATCH，CEO 鉴权，PATCH version+1。
- battlefield create/patch/list/card：code、sortOrder、name、ownerId、sixMonthOutcome、missions；ownerId 非空时必须命中 company-people.v1；按 sortOrder,code,id 排序；code/显示名冲突 409。
- capability create/patch/list/card：code、sortOrder、name、group（可空）、sixMonthOutcome、supportRefs；校验 missionCode 存在、battlefieldId 存在；按 sortOrder,code,id 排序。
- 战场 Card payload 提供 `{ownerId, ownerDisplayName}` 投影，不保存姓名副本。
- 保持旧 id 与 Issue/plan 引用；不做 id 改名迁移。
- 测试：人员校验、code 冲突、引用校验、稳定排序、空负责人、投影 displayName。

## W3 · MonthlyPlan 能力 PCO

- `capabilities: [{capabilityId,outcome}]` 贯穿 DB row、candidate、更新 Action、checkedItemIds(`capability:<id>`)、签发校验、Card 和 draft agent。
- Agent prompt/校验与现有战场模式同源；必须引用已登记能力 id，不要求虚构 todo。
- 签发后仍只投影目标/anchor，不创建 Mission、CapabilityProgress 或 todo 状态。
- Web MonthlyPlanCard 新增“能力 PCO”编辑与核对区，沿用现有公司/战场结果交互语言。
- 单测覆盖生成、编辑、核对、签发、非法 capabilityId。

## W4 · Web A+B 展示与表单

- 首页桌面战场三列；中宽两列；窄屏一列。
- 战场卡正面增加 ownerDisplayName（空则待指派）与两行六个月目标；待决策列表仍是主内容。
- 公司能力面板按 sortOrder 展示 code/name/group、两行六个月目标和待决策 Issue；无 Issue 时不再只显示空态。
- 配置页新增 Company LTCO textarea；战场/能力表单使用 code、sortOrder、六个月目标 textarea，战场 ownerId 可“待指派”。
- 战场管理编辑 code/order/name/owner/sixMonthOutcome/missions；能力管理编辑 code/order/name/group/sixMonthOutcome/supportRefs。
- 表单仍是确定性 CEO 写入；Web 不持久化事实。
- responsive/a11y 最小测试；1440×900 和 2560×1440 浏览器验收。

## W5 · 图中数据导入、关系图、staging

- 导入 Company LTCO 全文。
- 战场（最终仅 3 个，名称不含编号前缀）：
  - 01 灯塔项目；sort 10；4 个 Mission 01-1..01-4；
  - 02 Token Ops；sort 20；Mission 02-1；
  - 03 002 客户；sort 30；无 Mission。
- 能力 7 个：code 02/03/04/05/07/08/09，sort 20..90；group 清空；sixMonthOutcome 用图片全文；supportRefs 按图片（03 是 battlefield ref，“全战场”是 all-battlefields）。
- 2026-09 MonthlyPlan：保留 companyOutcome/todos/feedback/exports；battlefields 替换为图片 3 条 9月 PCO；capabilities 写入图片 7 条 9月 PCO；version+1、updated_at 前进。
- 删除旧 `growth` 必须调用 `deleteBattlefield()`；先记录 detachedIssues，若不为 0 停止并报告，不静默改议题。
- 更新关系图 JSON/HTML（若实现字段名变化需同步），Archify showcase 9/9 + visual-check 全 viewport pass；README 加入口。
- staging 重建 API/Web，curl 验证 3/7/1/10 数据，浏览器验首页、配置、两个管理页、月度计划。
- API/web/contracts 全量测试与 typecheck ×3；每 W 一个 commit，不 push。

## 图片文本（导入事实）

### Company LTCO
春节前，完成词元云集从“战略与产品定义”到“核心业务第一次被真实证明”的跨越：跑通“Re-architecture 进入客户 → TKOS 持续经营”的企业 AI 转型主线，形成可复制的产品、交付和商业模式；同时跑通 TokenHub / TokenOps 的商业闭环，验证第二条业务线的真实价值。

### Missions
- 01-1 未来组织范式设计与确认
- 01-2 CEO Agent 常态化使用
- 01-3 DRI / Manager Agent 常态化使用
- 01-4 Co-Agent 常态化使用
- 02-1 TokenHub 进入生产化使用并形成首批真实客户调用

### Capability supportRefs
- Re-architecture: mission 01-1 + battlefield 03
- Method: mission 01-1/01-2/01-3/01-4
- Agents: mission 01-2/01-3/01-4
- E&O: mission 01-2/01-3/01-4
- TokenHub: mission 02-1
- Talent & Organization: all-battlefields
- Finance, Compliance & Operations: mission 02-1 + all-battlefields

## 完成条件

- staging 首页只有 3 个战场、7 个能力，顺序与图片一致；核心六实体未增加。
- LTCO、六个月目标、负责人、当月战场/能力 PCO 在对应页面可见。
- Mission 只有配置引用，无执行状态。
- 关系图与代码一致且通过 Archify 验证。
- 工作区干净，未 push。
