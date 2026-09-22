# Ticket 26 · 战场图结构化模型（A+B）

Type: feature
Status: resolved
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

## Comments

### W5 完成记录（2026-09-22）

提交：W1 `bd3fd29`、W2 `762b918`、W3 `520f6ed`、W4 `3b9a1da`、W5（本次）。

**迁移与对象关系**：migration `019_strategy_map_config.sql` 只改结构（`battlefield_config` 增加 `code/sort_order/owner_id/six_month_outcome/missions`，唯一索引 `battlefield_config_code_key … WHERE code <> ''`，CHECK `sort_order BETWEEN 0 AND 9999`；新建 `company_strategy_config`，仅插入 `('default',1,'')`；`capability_config` 增加 `code/sort_order/group/support_refs`），不写任何图片业务数据。数据由 W5 通过 API 与受控 SQL 事务导入。

**数据导入（全部经 API，未直写业务表）**：
- `PATCH /api/config/strategy` → `{version:2, ltco:春节前…真实价值。}`。
- `PATCH /api/config/battlefields/{id}`：`01-灯塔项目`（code 01/10、4 个 Mission）、`02-token-ops`（code 02/20、1 个 Mission）、`03-002-客户`（code 03/30、无 Mission）；`ownerId` 未设置，保持「待指派」。
- `PATCH /api/config/capabilities/{id}`：7 项，`code/sortOrder` 为 02/20…09/90，`group` 清空，`supportRefs` 按 ticket 事实写入。
- `DELETE /api/config/battlefields/growth`（走 `deleteBattlefield`）：删除前用 SQL 记录受影响议题 = **0**（`detachedIssues = 0`，无 `growth` 引用），响应 204；删除后战场 = 3。
- 已签发 2026-09 MonthlyPlan（id `ffc24db5-8b4e-4766-ac64-4a7cdaf00aeb`）经授权用受控 SQL 事务修订：`version 5 → 6`，写入 3 个战场 PCO + 7 个能力 PCO，`negotiation.checkedItemIds` 补全为 11 项；`company_outcome` 占位、`todos`/`feedback`/`exports` 未动。API 对已签发计划返回 409 `MONTHLY_PLAN_CONFIRMED`，故必须走受控事务。

**测试**：typecheck ×3 通过；contracts 32；web 21 文件 / 123；API 27 文件 / 328（326 通过，`outletSources.test.ts` 2 项为与本次无关的既有时间窗波动）。

**staging（重建 api+web、迁移 019 已应用）**：
- `GET /api/config/battlefields` → 3 项，code/sortOrder 01/10、02/20、03/30，负责人均为空（待指派），Mission 4/1/0。
- `GET /api/config/capabilities` → 7 项，02/20…09/90，`group` 空，`supportRefs` 与 ticket 一致。
- `GET /api/cards/home` → 3 张 battlefield + 7 张 capability，顺序与图片一致。
- `GET /api/cards/monthly-plans` → 2026-09 confirmed v6，3 战场 PCO + 7 能力 PCO，已核对 11 项。

**浏览器验收（Chrome DevTools MCP，1440 / 2560 宽）**：首页 3 战场（灯塔项目/Token Ops/002 客户，负责人「待指派」、六个月目标全文）+ 7 能力（02…09 按 sortOrder）；列数 1440=3、1200=2、800=1，四页均无横向溢出。配置页 LTCO 文本与「保存长期目标」可见。战场管理 3 行（`负责人 待指派 · 0 个议题`）；能力管理 7 行（02/03/04/05/07/08/09）。月度计划页 `已签发`，显示 3 战场 PCO + 7 能力 PCO 与「已核对 11 项」。截图与 OCR 文本已核对（截图存于临时目录，未入库）。

**关系图**：`docs/diagrams/CEOwarmap_业务对象关系.architecture.json` 的 `supportMissionCodes[]` 改为 `supportRefs[]`；Archify `validate --quality showcase` 9/9 通过（composition 0 error/0 warning），`deliver` 产物 sha256 `297ff9b3…e652a6`，`visual-check` 在 1440x900/1600x1000/1920x1080/2048x1320 明暗两套下 status pass、containment pass、无溢出；`rg supportMissionCodes docs/diagrams/` 已无残留。README 架构图列表已加入该 HTML。

**未做/限制**：`growth` 删除只清结构，历史 MonthlyPlan JSONB 快照不重写（按 `deleteBattlefield` 既有语义）；2026-09 计划的 `company_outcome` 仍是占位文本（无已确认公司结果材料，未编造）；`outletSources.test.ts` 2 项既有波动未修（超出本 ticket 范围）；未 push。
