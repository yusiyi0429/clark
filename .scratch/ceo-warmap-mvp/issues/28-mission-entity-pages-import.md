# Ticket 28 · Mission 独立实体、页面、配置与 21 条真实导入

Type: feature
Status: planned
Blocked by: none
来源: 用户明确要求新建 Mission 页面/编辑配置页，并用 lark-cli 读取 7 份真实 Mission Card 后导入和匹配战场。
视觉基线（已完成）:
- `页面 / Mission 总览`（ImWct，x=26610）
- `页面 / Mission 详情`（I8FJ86，x=29250）
- `页面 / Mission 配置`（K5wz5i，x=31890）
- 首页入口 `Mission Overview Button`（jrJ3I）、配置入口 `Manage Mission Button`（z3ZeG）、战场卡 `Mission Count`（rqrgz）
- `Mission Editor` Footer（dmohw）已用 fill_container spacer 吸底；同时检查战场管理 3 卡、能力管理、月度计划、Mission 总览与 LTCO 卡，需吸底者均已吸底。
关系图: `docs/diagrams/CEOwarmap_业务对象关系.{architecture.json,html}` 已更新为七实体候选并通过 Archify showcase 9/9 + visual-check。

## 领域决策（用户请求覆盖旧边界）

1. Mission 从 BattlefieldConfig 内嵌 `{code,title}` 升为第七个核心业务实体；它是版本化 Organization Fact，拥有稳定 id、周期、唯一 DRI、Outcome、证据、里程碑、依赖、风险和来源。
2. Mission 不承担 Task/Activity 执行状态、完成百分比、项目管理或自动进度；外部 DRI 流程仍负责执行。
3. 一个 Mission 有一个主要能力域（`capabilityId`），可以关联 0..N 个战场（`battlefieldIds`），通过 `period` 承接同周期 MonthlyPlan PCO。
4. BattlefieldConfig 旧 `missions[]` 改名为 `missionAnchors[]`，只表示战场图上的战略锚点，不再承载 Mission Card。
5. Capability `supportRefs` 里的旧 `{type:"mission",missionCode}` 改为 `{type:"mission-anchor",missionCode}`，语义仍是能力对战场战略锚点的支撑；真实 Mission 与能力的关系由 Mission.capabilityId 表达。
6. Mission 编辑走 opaque Action `mission.edit`（version 锚 + fingerprint 幂等）；创建/导入没有既有版本，走 CEO config POST。
7. Mission 来源飞书文档只做导入输入和 source metadata；正文不复制到仓库、测试 fixture 或证据目录。正式字段落库后，飞书后续变化不会自动覆盖。
8. Mission code 在 Mission 表内唯一；与 missionAnchor code 属不同命名空间，可重复。
9. 秦梦怡来源文档写 Domain 07，但当前正式能力注册表中 Talent & Organization 是 code 08；保留源 Mission code `07-*`，`capabilityId=talent-organization`，不改写来源。

## Mission 实体

建议表 `missions`：

- `id TEXT PK`（初次导入由 slug(code + title) 或 UUID，之后稳定）
- `version INTEGER > 0`
- `code TEXT UNIQUE NOT NULL`
- `period TEXT NOT NULL`（YYYY-MM）
- `title TEXT NOT NULL`
- `owner_id TEXT NOT NULL`（企业知识 personId）
- `capability_id TEXT NOT NULL`（已登记能力）
- `battlefield_ids JSONB NOT NULL DEFAULT []`
- `outcome TEXT NOT NULL`
- `why TEXT NOT NULL DEFAULT ''`
- `success_evidence JSONB NOT NULL DEFAULT []`（string[]）
- `milestones JSONB NOT NULL DEFAULT []`（string[]，保留来源表述）
- `dependencies TEXT NOT NULL DEFAULT ''`
- `risk TEXT NOT NULL DEFAULT ''`
- `boundaries TEXT NOT NULL DEFAULT ''`
- `source_ref TEXT NOT NULL`
- `source_document_id TEXT NOT NULL`
- `source_revision INTEGER NOT NULL`
- `source_title TEXT NOT NULL`
- `created_at/updated_at`

不增加 status：是否为当前 Mission 由 period 表达；归档/撤销没有本票真实需求。

## W1 · 领域、迁移、契约

- 新 ADR 0019：Mission 从战略锚点升为独立实体；明确七实体、与 PCO/能力/战场/DRI 的关系以及禁止 Task 执行化。
- 更新 CONTEXT、spec、技术文档与 ADR 0018 中“六实体/Mission 值对象”的旧口径。
- migration 021：
  - rename `battlefield_config.missions -> mission_anchors`；
  - capability support_refs 内 `type=mission` 迁为 `mission-anchor`；
  - 创建 `missions` 表与 code 唯一、period 格式、JSON array 检查。
- contracts：Mission schema、MissionCardPayload、create request、edit Action input、列表/管理投影；Battlefield/Capability 字段同步改名；Card kind 新增 `mission`。
- gen:client；contracts/migration tests。

## W2 · API、Card、关系完整性

- repository/projector：Mission 按 period desc、capability sortOrder、code 排序；owner displayName 只在投影时从企业知识解析。
- `POST /api/config/missions`：CEO 鉴权，校验 code/name、ownerId、capabilityId、battlefieldIds、period；创建 v1 Mission Card。
- `GET /api/config/missions`：Mission 配置页一次投影；`GET /api/cards/missions`、`GET /api/cards/missions/:id`。
- `mission.edit` opaque Action：字段 diff input，锁行、version、fingerprint；source metadata 默认不可从 Web 编辑。
- `/api/cards/home` 加 Mission Card，HomeBoard/BattlefieldCard/Capability panel 用 collection 做数量与导航，不保存汇总。
- deleteBattlefield 同事务从 missions.battlefield_ids 移除 id，仅受影响 Mission version+1；历史 MonthlyPlan 不回写。
- capability 没有 delete API；未来删除时需先处理 Mission，本票不新增。
- Conversation 暂不扩展 Mission scope；用户未要求 Mission 对话。
- 测试：权限、外键式校验、code 冲突、排序、幂等/版本冲突、战场删除级联、首页投影。

## W3 · Web 页面与关联入口

- `/missions`：总览统计、战场/能力域/DRI 筛选、Mission 行；数据来自 API Card/管理投影，不在 Web 聚合持久事实。
- `/missions/[id]`：详情页展示 Outcome、DRI、period、能力域、战场、成功证据、里程碑、依赖、风险、边界、飞书来源 revision；提供“编辑 Mission”入口。
- `/config/missions`：左列表 + 右编辑表单，保存走 `mission.edit` Action；Config 顶栏入口。
- 首页：战场 toolbar 进入 `/missions`；每张战场卡显示 Mission 数并可进入过滤后的 `/missions?battlefieldId=...`；能力面板显示 Mission 数/入口。
- Mission 总览/详情/配置响应式与 a11y；Footer 吸底 CSS 与 Pen 一致。
- registry、payload、server loaders 与测试。

## W4 · 真实数据导入与 staging

### 飞书来源（已由 lark-cli user identity 读取）

| DRI | source URL | document_id | revision | Mission 数 |
|---|---|---|---:|---:|
| 刘人豪 | `https://tokenking.feishu.cn/docx/UvSrdWhPzoGGtCxE47fcHAPlnic` | `UvSrdWhPzoGGtCxE47fcHAPlnic` | 33 | 3 |
| 白田田 | `https://tokenking.feishu.cn/docx/PxWNdgTPFo2Z4oxpWYrcy9AEndf` | `PxWNdgTPFo2Z4oxpWYrcy9AEndf` | 9 | 4 |
| 秦梦怡 | `https://tokenking.feishu.cn/docx/XcAKdRseSobfYYxDeKKcpyFHnqb` | `XcAKdRseSobfYYxDeKKcpyFHnqb` | 17 | 5 |
| 陈溪南 | `https://tokenking.feishu.cn/wiki/OfoHwC4gYie1x6kUlxMcNTzCnip?fromScene=spaceOverview` | `SsVbduAu7ocyFpxjF4uc6DkGnWg` | 337 | 2 |
| 于斯一 | `https://tokenking.feishu.cn/docx/IY0ndAzK2okR2yx09pLcyh8KnDf` | `IY0ndAzK2okR2yx09pLcyh8KnDf` | 5 | 1 |
| 唐巨杰 | `https://tokenking.feishu.cn/docx/AASMdveweoIl1wx81cXcIHwin8b?from=auth_notice&hash=a7b9d8c513f1e8e26257ee8a6836e79e` | `AASMdveweoIl1wx81cXcIHwin8b` | 19 | 4 |
| 孙铭泽 | `https://tokenking.feishu.cn/wiki/YL64wBD0XiSgu3kS15RcMiKVnhf` | `YiR7dyjYwoBa8ixFeRycaSPKnQU` | 34 | 2 |

### 21 条 code / 能力域 / 战场匹配

Battlefield IDs：`01-灯塔项目` / `02-token-ops` / `03-002-客户`。

| DRI | code | 标题（来源原义） | capabilityId | battlefieldIds |
|---|---|---|---|---|
| 刘人豪 | LHR-A | CEO Agent Architecture & Quality | agents | 01 |
| 刘人豪 | LHR-B | Ontology & Data Grounding | e-o | 01,03 |
| 刘人豪 | LHR-C | ENO / Engine Blueprint | e-o | 01,03 |
| 白田田 | 03-1 | M1-A 真实战略工作持续运行，Agent 专业质量达到 01 部署标准 | method | 01 |
| 白田田 | 03-2 | M1-B 真实 Formation / Review + Agent 专业质量 | method | 01,03 |
| 白田田 | 03-3 | M2.1 真实运行 + M2.2/2.3 必要 L4 | method | 01,03 |
| 白田田 | 03-4 | MF 最小经营反馈机制 | method | 01,02,03 |
| 秦梦怡 | 07-1 | 识别组织能力 Gap 并形成补位决策 | talent-organization | 01,02,03 |
| 秦梦怡 | 07-2 | 推动核心人才到岗 | talent-organization | 01,02,03 |
| 秦梦怡 | 07-3 | 推动人才评价机制进入运行 | talent-organization | 01,02,03 |
| 秦梦怡 | 07-4 | 推动长期激励机制进入运行 | talent-organization | 01,02,03 |
| 秦梦怡 | 07-5 | 建立新人加入与融入机制 | talent-organization | 01,02,03 |
| 陈溪南 | PA-1 | M1-B 经营协同 MVP 与真实实践 | agents | 01,03 |
| 陈溪南 | PA-2 | TKOS 产品全景蓝图与概念性交互 | agents | 01,03 |
| 于斯一 | 05-1 | Clark Ontology & Memory v0.1 | e-o | 01,03 |
| 唐巨杰 | 09-1 | 基础财务与运营稳定运行 | finance-compliance-operations | 01,02,03 |
| 唐巨杰 | 09-2 | Token 市场、供应与合作模式基线 | finance-compliance-operations | 02 |
| 唐巨杰 | 09-3 | TokenHub 经营边界矩阵 | finance-compliance-operations | 02 |
| 唐巨杰 | 09-4 | 灯塔项目成本与经济性基线 | finance-compliance-operations | 01 |
| 孙铭泽 | 04-1 | CEO Agent 核心体验产品化与真实使用 | agents | 01 |
| 孙铭泽 | 04-2 | DRI Agent V1 核心体验与真实验证 | agents | 01,03 |

导入规则：
- `period=2026-09`；ownerId 用企业知识精确人员 ID；
- outcome/why/successEvidence/milestones/dependencies/risk/boundaries 按每份来源对应章节原义导入，不编造缺失字段；缺失填空字符串/空数组；
- 飞书完整正文只在 `/tmp/missioncards-lark/*.json` 临时存在，禁止 git add；
- 通过 API 创建（Organization Fact），重复 code 409；导入后 exact 21。

### 验证

- typecheck ×3；contracts/web/API 全量。
- staging rebuild api+web；API 断言 Mission=21、owner=7、capability 分布 agents5/e-o3/method4/talent5/finance4；战场关联计数 01=19、02=9、03=15。
- 浏览器验 `/missions`、任一详情、`/config/missions`、首页入口与战场过滤；1440×900 / 2560×1440 无横向溢出。
- 临时验证对象做完清理；真实 21 条保留。
- 每 W 一个 commit，不 push；Ticket/map 收口。

## 边界

- 不从飞书持续同步，不建立 webhook/定时任务；本票是一次性 CEO 授权导入。
- 不保存任务完成率、红黄绿、Task/Activity 或执行日志。
- 不自动依据文本推断进度；页面展示正式承诺与关系。
- 不提交飞书正文或访问凭据。
