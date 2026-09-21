# CEO WarMap 目标设计 v0.3（意图对齐定稿）

## 0. 文档定位

本文是 CEO WarMap 的目标产品与实现边界，覆盖页面、交互、六个业务实体、四层记忆、Pi Agent Runtime、Card KV、前后端分离、外部输入和旧前端清理。

设计依据：

- `需求文档.md`
- `seed/memory/CompanyMemory.md`
- 根目录 `CONTEXT.md`
- `docs/adr/` 中已确认决策
- 当前 `frontend/src/components/ceo-warmap/` 的视觉与微交互证据

当前前端只作为视觉和交互基线。旧业务对象、硬编码数据、`localStorage` 状态、旧 Agent、旧 API 和旧页面不构成目标约束，也不迁移到新系统。

---

## 1. 产品边界

### 1.1 产品定义

CEO WarMap 是**单公司、单 CEO、桌面 Web 决策驾驶舱**。

它负责：

- 监测外部变化并形成 Signal；
- 将高价值 Signal 自动升级为 Issue；
- 接收 DRI 提交的 Issue；
- 为 Issue 自动完成预研；
- 支持 CEO 直接决定或带入 Meeting；
- 装配会前材料并从结构化 Transcript 提取 MeetingOutcome；
- 支持 CEO 在通知卡中逐项确认会后结果；
- 生成、协商并签发 MonthlyPlan；
- 在 global 与对象 scope 中提供带四层记忆的 Agent 对话。

它不负责：

- 项目管理和任务执行；
- DRI 工作台或多人协作；
- 日历和外部会议系统同步；
- 录音、ASR、说话人映射或逐字稿格式转换；
- 移动端验收或原生 App；
- 实时语音对话；
- 深研升级；
- Conversation 创建或修改业务对象；
- Meeting 未决项自动或手动转成 Issue；
- 当前版本直接更新 CompanyMemory。

### 1.2 MVP 完成条件

1. 一条真实 Web／公众号信号自动升级 Issue，完成预研和 CEO 决定。
2. 一条真实 DRI Issue 完成会前预审、Transcript 导入、Outcome 抽取和逐项确认。
3. 一个月度计划完成自动装配、DRI 反馈导入和 CEO 签发。
4. global 与至少两个对象 Conversation 完全隔离。
5. Pi 完成一次真实 Tool loop、compaction 和 runtime entries 恢复。
6. PostgreSQL 完成一次异机备份恢复。
7. 新 `apps/web` 不包含业务对象、业务状态、模型调用、调度或状态迁移逻辑。
8. 当前 UI scope 内的页面完成像素级重构；scope 外新增内容遵循既有视觉和交互语言。

---

## 2. 页面和交互

### 2.1 页面树

```text
/access
└─ 单 CEO 登录

/
├─ 右侧内容区
│  ├─ 公司战略议题卡
│  │  └─ /issues/:id
│  ├─ 战场卡
│  │  ├─ 正面：目标 + pending Issue
│  │  ├─ 背面：普通待办 + 负责人 + 最新反馈
│  │  └─ /issues/:id
│  ├─ 公司能力卡
│  │  └─ 卡内 Issue → /issues/:id
│  └─ 雷达信号卡
│     └─ /radar
│        └─ /radar/signals/:id
├─ 左侧通知栏
│  ├─ 红色待判断 Issue → /issues/:id
│  ├─ 会前预审 Meeting 集合 → /meetings/:id
│  ├─ 会后确认 → 通知浮卡内逐项处理
│  └─ 月度目标与任务 → /plans/:period
└─ 底部唯一 Conversation 输入框
```

### 2.2 对话规则

- 首页使用 `global` scope。
- Issue、Signal、Meeting、MonthlyPlan 各有独立 scope。
- 二级和三级页面继续使用同一个底部输入框，不新增右侧聊天区。
- 对象 Conversation 不读取 global 或其他对象 Conversation。
- 首页可以选择多张可注入卡片；引用只对本次消息生效。
- 引用提升注意力，不提升可信度，也不等于确认。
- Conversation 只能回答、解释和外部取证，不能创建 Issue、更新 ResearchDoc、确认、分派、签发或撤回。

### 2.3 稳定 URL 与既有展开体验

对象页面必须支持刷新和复制链接。前端路由使用稳定 URL，但页面切换继续保留当前 CEO WarMap 的全屏展开、浮层和返回动画；不能为了 URL 化退回普通后台表格页面。

会后确认不创建新页面类型。需要完整上下文时进入已有 `/meetings/:id`。

### 2.4 战场卡

保留当前正反面翻转交互：

- 正面展示当前目标和 pending Issue；
- 背面展示普通待办、负责人和最近一次 DRI 反馈。

不展示：

- Agent 估算完成百分比；
- 红黄绿健康评分；
- 独立 BattlefieldProgress 对象；
- 旧 LTCO 演练逻辑。

### 2.5 像素级重构规则

#### scope 内：像素级保留

下列已有交互属于保留 scope。新 `apps/web` 应以当前桌面截图和 CSS 为基线，保持布局、尺寸、间距、字体、颜色、圆角、阴影、层级、动画节奏、焦点和键盘行为：

| 目标区域 | 当前视觉／交互依据 | 保留内容 |
|---|---|---|
| 首页壳与底部输入框 | `workspace.tsx`、`workspace.module.css`、`conversation-dock.module.css` | 主布局、底部输入、思考态、停止、对象标签 |
| 首页四类内容卡 | `home-board.tsx`、`home-board.module.css`、`progress-card.*`、`radar.module.css` | 卡片比例、排布、层级、战场翻转、Issue 行 |
| 通知栏与浮卡 | `notifications.tsx`、`notifications.module.css` | 左栏密度、颜色、浮卡展开、确认和撤回反馈 |
| Issue 页面 | `issue-workspace.*` | 全屏材料面、判断区、选项、证据、来源、返回 |
| Meeting 页面 | `meeting-workspace.*`、`heavy-workspace.*` | 会前材料布局、逐项核对、编辑、提交的视觉语言 |
| MonthlyPlan 页面 | `heavy-workspace.*` | 逐项检查、文本编辑、底部动作区的视觉语言 |
| 雷达列表和详情 | `radar-feed.*`、`anchor-editor.*` | 筛选、排序、阅读页、来源详情、配置浮层 |
| Conversation | `conversation-transcript.*` | Markdown、来源折叠、耗时、思考态和停止 |
| 多卡引用 | `card-references.*` | 引用按钮、引用托盘、已选状态和移除 |
| 品牌与登录 | 当前品牌字体、标识、`/access` | 品牌视觉、口令输入、错误和退出反馈 |

像素级保留只约束展示与交互，不允许复制旧硬编码数据、对象类型、状态机、命令解析或 `localStorage`。

验收方式：

1. 在旧前端用固定 fixture 对 scope 内页面生成桌面基线截图。
2. 在 `1440×900` 与 `1600×1000` 对新 Web 使用等长 fixture 复现。
3. 对动态文本区遮罩文本像素，只比较容器几何和视觉 token。
4. 检查关键动画终态、键盘焦点、Escape 返回和 reduced-motion。
5. 业务内容变化不能作为任意改变间距、排版和卡片比例的理由。

#### scope 外：同风格新增

以下目标能力当前没有完整交互，允许新增，但必须复用邻近组件的视觉语言：

- Research pending／running／failed／重试；
- 预研未完成时的二次确认旁路；
- “移出议题”；
- Issue 加入已有 Meeting／新建 Meeting；
- Transcript JSON 上传和整份解析失败；
- Meeting cancelled；
- Outcome 多条 item 的确认／忽略／撤回；
- DRI Handoff 的 `pending_export`；
- 稳定 URL 加载和 not-found；
- Pi Session 恢复提示；
- API／MCP 未配置状态。

新增元素不得引入新的后台设计系统、第二套卡片风格或表格型管理台。优先从现有按钮、浮卡、材料页、错误文案和状态标签组合。

---

## 3. Monorepo 与职责边界

### 3.1 目标目录

```text
apps/
  web/                          # Next.js：页面、组件、CSS、展示态
  api/                          # Fastify：业务对象、Card、Action、Pi、调度、鉴权
packages/
  contracts/                    # TypeBox schema、OpenAPI 生成入口
prompts/
  warmap/                       # 场景 Prompt
infra/
  docker-compose.yml
  backup/
docs/
  adr/
  contracts/
```

`apps/web` 和 `apps/api` 独立构建、独立容器。Caddy 作为 Docker Compose 中唯一公网入口与 TLS 终止点：

```text
/                     → apps/web
/api/*                 → apps/api
/mcp/company-memory    → apps/api
```

Web、API 与 PostgreSQL 只在 Compose 内网；DRI service API、Conversation SSE、Transcript multipart 与 MCP 均直接经 Caddy 转发，不经过 Next rewrite。

### 3.2 Web 允许的职责

- 解析类型化 Card；
- 渲染固定 React 组件；
- 页面导航、展开、动画和无障碍；
- 临时表单输入；
- 展示排序和筛选；
- 选择引用；
- 提交后端给出的 opaque `actionId`；
- 展示 API 流和 Pi 事件流。

Web 禁止：

- 保存业务对象或业务状态；
- 用 `localStorage` 保存决定、预审、通知或计划；
- 计算升级门槛、最终评分或对象状态；
- 硬编码业务对象 ID；
- 调用模型、搜索或 CompanyMemory；
- 承担 scheduler；
- 通过自然语言解析执行组织动作。

### 3.3 API 职责

- 六个实体和两类配置；
- PostgreSQL 持久化；
- Card 投影和 Action 状态迁移；
- Pi Session、Tool、compaction 和事件流；
- Prompt 和模型槽位；
- Radar／Monthly scheduler；
- CompanyMemory MCP；
- DRI 导入／导出；
- Transcript 校验；
- LangSmith 应用级 trace；
- 单 CEO 和服务凭据鉴权。

### 3.4 Contracts

Fastify 和 Pi Tool 使用 TypeBox schema。OpenAPI 从同一 schema 生成，Web 自动生成 TypeScript 客户端，不手写第二套 DTO。

Card schema 与业务实体 schema 分开：Web 只消费 Card 和 Action，不直接获取可任意修改的领域实体。

---

## 4. 四层记忆

### 4.1 产品四层

```text
Layer 1 · 当前运行上下文
  当前消息、当前对象快照、选中 Card、Tool 结果

Layer 2 · 对象 Conversation
  原始消息、Pi runtime entries、compaction 执行态

Layer 3 · 业务对象记忆
  Issue、Signal、Meeting、MeetingOutcome、MonthlyPlan 及确认结果

Layer 4 · CompanyMemory
  公司战略、Outcome、Domain、经营原则、人员目录和来源证据
```

工作、情景、语义、程序记忆描述 Runtime 如何使用这些层，不另建一套数据模型。

### 4.2 所有权

| 层 | 事实源 | Pi 的角色 |
|---|---|---|
| 当前运行上下文 | 当前 API 请求 | 运行 agent loop |
| Conversation | PostgreSQL 原始消息 | 保存可替换的压缩执行态 |
| 业务对象 | PostgreSQL | 只读当前对象快照 |
| CompanyMemory | CompanyMemory MCP 后端 | 按需调用只读 Tool |

Pi 不是业务数据库。Runtime 丢失不能导致 Conversation、业务对象或 CompanyMemory 丢失。

### 4.3 Conversation 与 Pi Session

```text
Conversation {
  id,
  scope: 'global' | 'issue:{id}' | 'signal:{id}' | 'meeting:{id}' | 'plan:{period}',
  messages: [{ id, role, content, referencesSnapshot?, runId?, at }],
  runtime: {
    piSessionId,
    entriesJson,
    updatedAt,
    recreatedAt?
  },
  createdAt, updatedAt
}
```

规则：

- 原始消息只追加，是产品事实源。
- 每次 `agent_end` 和 compaction 后保存 Pi entries JSONB。
- 恢复时使用 `SessionManager.inMemory(..., entries)`。
- entries 损坏时从当前对象和最近 20 条原始消息重建，并明确记录 `recreatedAt`。
- 不要求普通 UI 展示 compaction summary。
- selected Card 只提交 ID/version；后端生成 `referencesSnapshot`。

### 4.4 未来每日认知复盘

本次不实现，但保留接入条件：所有业务对象有稳定 ID、`createdAt/updatedAt`、来源和确认状态，Conversation 原文可按时间查询。

未来链路：

```text
产出文件 + 已确认业务对象 + 全部 Conversation
  → 每日认知复盘
  → 与 CompanyMemory 对比
  → Memory Update Proposal
  → CEO 确认
  → 更新 CompanyMemory
```

当前任何单次决定、对话或 Agent 候选都不直接写 CompanyMemory。

---

## 5. 领域模型

### 5.1 模型总览

**六个实体：** `Issue`、`Signal`、`Meeting`、`MeetingOutcome`、`MonthlyPlan`、`Conversation`

**两类配置：** `RadarConfig`、`BattlefieldConfig`

**内嵌 shape：** Research、Receipt、Preflight、Transcript、OutcomeItemReview、Todo、ReferenceSnapshot

**纯投影：** 四类通知、Radar 态势、Outcome 处理进度、战场正反面

不建立 Notification、ResearchJob、ScanRun、Action、Approval、BattlefieldProgress 或 Todo 实体。

### 5.2 Issue

Issue 是唯一决策对象，只能由 Radar 自动升级或 DRI 提交。

```text
Issue {
  id, title,
  origin: 'radar' | 'dri',
  originRef,
  submittedByPersonId?,
  location:
    | { level: 'company', relatedBattlefieldIds[] }
    | { level: 'battlefield', battlefieldId }
    | { level: 'capability' },
  urgency: {
    level: 'red' | 'yellow' | 'gray',
    reason?,
    decisionBy?,
    decisionByEvidence?: { quote, sourceRef }
  },
  status: 'pending' | 'decided' | 'dismissed',
  research: {
    status: 'pending' | 'running' | 'ready' | 'failed',
    pendingSince?,
    runId?,
    previousRunIds[],
    error?,
    doc?: ResearchDoc
  },
  meetingIds[],
  receipts: Receipt[],
  dismissed?: { at, reason },
  createdAt, updatedAt
}

ResearchDoc {
  summary,
  options: [{ id, text, consequence }],
  evidence: [{ text, sourceRef }],
  unknown,
  sources: [{ sourceRef, title, url?, excerpt }],
  generatedAt
}

Receipt {
  id,
  decisionText,
  source:
    | { kind: 'issue-action', actionId }
    | { kind: 'meeting-item', meetingId, outcomeItemId },
  researchRunId?,
  researchStatusAtDecision,
  at,
  revokedAt?
}
```

规则：

- 一个 Issue 只有一个 location。
- 影响多个战场时成为 company 战略议题，只在战略区域显示。
- `red` 必须有可核对的 `decisionBy + reason`。
- Radar red 还必须有连续存在于来源 excerpt、可解析时间窗口的 decisionByEvidence；DRI red 由提交参数明确提供。
- 判断、选项、依据和未知只存在 ResearchDoc。
- Issue 创建后立即投影到页面，不等待预研完成。
- pending Issue 可显式重新预研，整份替换当前 doc；旧 run 由运行记录追溯。
- decided Issue 不允许重新预研。
- Research 未 ready 时默认禁用决定；CEO 可二次确认旁路，Receipt 必须保存当时状态。
- CEO 可选择 option 或编辑最终 `decisionText`。
- “移出议题”进入 dismissed，保留来源和去重指纹，不能重新自动升级。
- MVP 不支持 deferred。
- Conversation、Meeting open item 和 CEO 自由输入都不能创建 Issue。

生命周期：

```text
pending ──CEO 决定────────> decided
pending ──移出议题────────> dismissed
pending ──加入 Meeting────> pending
```

### 5.3 Signal

```text
Signal {
  id,                            # 规范化 URL 指纹
  title, url, source,
  publishedAt?, collectedAt,
  anchorId, anchorTitle,
  excerpt,
  assessment {
    summary, implication, unknown,
    dimensions,
    score                        # 代码聚合
  },
  readAt?, savedAt?, dismissedAt?,
  promotedIssueId?,
  promotionFingerprint?,
  createdAt, updatedAt
}
```

规则：

- 阅读、收藏、隐藏独立可逆。
- 达到门槛时自动创建 Issue，不提供“形成议题”按钮。
- 自动升级门槛要求：CEO 决策类型、2–4 个去重选项、连续原文引句、合法归属、代码评分和去重全部通过。
- Agent 提出语义候选；代码负责结构、引文、评分、归属和去重。
- `promotedIssueId` 单向绑定；dismissed Issue 阻止同一问题再次升级。

### 5.4 Meeting

```text
Meeting {
  id, title, time,
  source: 'issue-action' | 'dri-import',
  leadDriId,
  ceoParticipantId,
  participants: [{ personId, nameSnapshot, roleSnapshot }],
  issueIds[],
  status: 'scheduled' | 'held' | 'reviewed' | 'cancelled',
  preflight {
    entries: [{
      id, issueId?, title, proposal,
      basis: [{ text, sourceRef, needsVerification }],
      brief?: { whyNow, decisionWindow, reversibility, todoRefs[], readMinutes }
    }],
    draft {
      checkedEntryIds[], editsByEntryId{}, readIssueIds[], pinnedIssueIds[],
      supplementRequests: [{ id, entryId, text, exportStatus, exportRef? }],
      note
    },
    submittedAt?
  },
  transcript?: {
    schemaVersion: 'warmap-transcript.v1',
    importedAt,
    turns: [{ id, speakerId, startedAt?, text }]
  },
  createdAt, updatedAt
}
```

规则：

- CEO 从 Issue 选择已有 Meeting 或新建 Meeting；不建会议管理页。
- DRI 可通过导入 API 创建 Meeting。
- participants 必须来自通过 `company-people.v1` 校验的 CompanyMemory 人员目录，不得从显示姓名临时生成 personId。
- Agent 不能创建 Meeting。
- 会前只允许已阅、请补充、带到会议、编辑和提交预审，不替 CEO 表态。
- Supplement Request 保存成功只代表已记录；真实渠道回执后才显示已发送。
- 成功导入 Transcript 后进入 held 并自动触发 Outcome 抽取。
- 仅在不存在 confirmed effect 时允许二次确认后替换 Transcript；替换事务整体使旧未确认 Outcome 与 actionId 失效，提交后重新抽取。
- 未召开 Meeting 可由 CEO 取消。
- Outcome 全部处理后进入 reviewed。

### 5.5 Transcript 合同

唯一格式见 `docs/contracts/warmap-transcript.v1.md`。

硬规则：

- `schemaVersion` 精确匹配；
- meetingId 存在；
- turn ID 唯一；
- speakerId 必须属于 Meeting participant；
- text 非空；
- startedAt 有值时必须带时区且顺序合法；
- 任一项失败则整份拒绝；
- 不部分导入、不猜 speaker、不调用 Agent。

### 5.6 MeetingOutcome

```text
QuoteRef { turnId, quote }
Review {
  status: 'pending' | 'confirmed' | 'dismissed',
  at?, effectRef?, note?
}

MeetingOutcome {
  meetingId,
  transcriptImportedAt,
  summary,
  decisions: [{
    id, text, issueId?, quoteRef,
    reopenWhen: [{ id, text, review }],
    review
  }],
  todos: [{
    id, title, ownerPersonId?, dueAt?, sourceRef?, issueId?, quoteRef, review
  }],
  open: [{ id, text, quoteRef }],
  ceoJudgments: [{ id, text, whyCeo, kind, quoteRef, review }],
  warnings: [{ candidate, reason }],
  runId,
  createdAt, updatedAt
}
```

`kind` 只允许：

```text
company_direction
resource_allocation
external_commitment
major_risk
mission_boundary
```

处理进度由所有带 Review 的条目派生：

```text
存在待审条目且全部 pending      → draft
部分 confirmed/dismissed         → reviewing
全部 confirmed/dismissed         → confirmed
没有待审条目                    → confirmed
```

reopenWhen 依赖父 decision：只有父 decision confirmed 后才可确认；父 decision dismissed 时自动 dismiss 其 pending reopenWhen；撤回父 decision 时同步撤回已确认的子 Radar anchors。

逐项效果：

| 条目 | confirmed 效果 |
|---|---|
| decision | 向关联 Issue 写精确来源 Receipt |
| todo | 生成 DRI Handoff；无渠道时为 `pending_export` |
| ceoJudgment | 保留为 MeetingOutcome 中已确认组织事实，未来认知复盘可读取 |
| reopenWhen | 写入 RadarConfig anchor，来源为 `meeting-reopen` |
| dismissed | 只记录不采用，不产生外部效果 |

撤回统一进入 `revokeEffect(effectRef)`。Issue 页面遇到 meeting-item Receipt 时必须委托该用例，同步 Outcome item、Receipt、Radar anchor 与 Meeting 状态；外部效果不可撤销时，Action 必须禁用或明确返回 warning，不能声称全部恢复。

引文校验：

1. turnId 存在；
2. quote 连续存在于该 turn；
3. speaker 从 turn 取得；
4. speaker 未知不能生成 owner 或 CEO 判断；
5. “我来”只指向该 turn speaker；
6. CEO 判断只认 CEO turn 和五类权限；
7. 不合格候选进入 warnings。

open 条目只展示，不提供“形成议题”。

### 5.7 MonthlyPlan

```text
MonthlyPlan {
  period,
  status: 'draft' | 'negotiating' | 'confirmed',
  companyOutcome,
  battlefields: [{ battlefieldId, outcome }],
  todos: [{ id, battlefieldId?, title, ownerId, dueAt?, sourceRef }],
  negotiation {
    edits{}, checkedItemIds[],
    feedback: [{ id, driId, todoId?, battlefieldId?, text, evidenceRef?, observedAt, sourceRef, at }],
    note?
  },
  runId?, error?, confirmedAt?,
  createdAt, updatedAt
}
```

规则：

- 每月首个自然日按 `Asia/Shanghai` 自动创建一次。
- 失败可见并允许显式重试，不重复创建同月计划。
- todo 是普通待办，不是 Mission；WarMap 不保存其执行状态。
- dueAt 不填时默认月末。
- DRI 反馈通过导入进入同一个 MonthlyPlan；todo feedback 只追加叙述、证据与 observedAt，不修改 todo 状态。
- 战场背面按 todo/feedback 的 battlefieldId 投影，空值表示公司级，不能通过 owner 反推战场。
- 只有 CEO 可以签发。
- 签发后以 `source=ontology`、`originRef=monthly-plan:<period>` 重建受影响的基础锚点，但不直接写 CompanyMemory。

### 5.8 配置

```text
RadarConfig {
  timezone: 'Asia/Shanghai',
  anchors: [{
    id, title, material,
    source: 'ontology' | 'manual' | 'meeting-reopen',
    originRef?, battlefieldIds[]
  }],
  sources: [{
    id, name,
    type: 'wechat-account' | 'site',
    ref, enabled
  }],
  scanState {
    lastScheduledAt?,
    lastRun?: { at, trigger: 'scheduled' | 'manual', status, found, promoted, warnings[] }
  }
}

BattlefieldConfig { id, name, positioning }
```

promotion fingerprint 固定为 `SHA-256(v1 + decisionKind + normalizedDecisionQuestion + normalizedLocation)`；问题文本执行 Unicode NFKC、trim、合并空白和移除句末标点，多战场 ID 排序。该 MVP 规则保证确定性，不承诺识别所有语义改写。

公众号账号级来源必须经过真实渠道 PoC。`site:mp.weixin.qq.com` 只是站点搜索，不得宣称为账号订阅。

---

## 6. 通知和 Card KV

### 6.1 通知是投影

| 通知 | 投影条件 |
|---|---|
| 红色待判断 | `Issue.status=pending && urgency.level=red` |
| 会前预审 | `Meeting.status=scheduled` |
| 会后确认 | MeetingOutcome 存在 pending Review item |
| 月度目标与任务 | 当前 MonthlyPlan 非 confirmed 或本月需查看 |

通知不独立落库，不拥有第二套确认状态。单 CEO MVP 不保存跨设备通知已读／收起状态。

### 6.2 Card Envelope

```text
Card {
  schemaVersion,
  id,
  version,
  kind,
  objectRef: { type, id },
  title,
  badge?, urgency?,
  payload,
  navigation?: { target, params },
  conversation?: {
    scope,
    injectable,
    referenceLabel?,
    referencePreview?
  },
  actions: ActionDescriptor[]
}

ActionDescriptor {
  actionId,
  label,
  style?: 'primary' | 'secondary' | 'danger',
  inputSchema?,
  confirmText?,
  disabledReason?
}

ExecuteActionRequest {
  actionId,
  cardVersion,
  input?
}
```

`actionId` 对 Web 不透明，由 action type、object、version 和 item 确定性签名，不使用随机 nonce。API 根据 actionId 与 canonical input 计算 fingerprint；已有同 fingerprint 效果时先幂等返回，未命中才校验对象版本和状态。Web 不根据 kind 推断业务效果。

### 6.3 Card kinds

```text
strategy-issues
battlefield
capability
radar-overview
signal-list
signal-detail
notice-red
notice-preflight
notice-postmeeting
notice-monthly
issue-detail
meeting-detail
monthly-detail
conversation
```

每个 kind 对应固定 React 组件，不允许后端 JSON 描述任意布局。

### 6.4 可注入矩阵

| 内容 | global 可注入 |
|---|---|
| 单个 Issue | 是 |
| 单个 Signal | 是 |
| 单场 Meeting 材料 | 是 |
| 单条 MeetingOutcome item | 是 |
| MonthlyPlan 或其中单项 | 是 |
| 战场／战略／能力集合和 Radar 概览 | 否 |
| 整个对象详情页 | 否；已在对象 scope |

### 6.5 查询边界

- GET／query 只读取对象和 Card 投影。
- 查询不得触发模型、扫描、重算或写盘。
- 状态变化只来自 Action、scheduler 或外部导入处理器。
- 同一个 Action 重放不能产生重复 Receipt、Todo、anchor 或签发。
- 版本冲突返回最新 Card，要求 CEO 重新核对。

---

## 7. 核心链路

### 7.1 Radar → Issue → 预研

```text
RadarConfig anchors + enabled sources
  ↓
每日 scheduled scan 或 CEO manual 补扫
  ↓
Web Search + 公众号账号拉取
  ↓
规范化、时间窗、URL 去重
  ↓
Pi 雷达研判 Agent 生成候选
  ↓
代码校验选项、引文、归属、分值、red 时间和去重
  ├─ 未达门槛 → Signal 池
  └─ 达门槛 → 自动创建 pending Issue
                    ↓
               立即投影首页
                    ↓
               自动执行预研
                    ↓
       research running → ready / failed
```

scheduled scan 按公司日期每天最多启动一次；manual 补扫不占 scheduled 轮次。两者复用同一管线，同一时刻只运行一轮。

失败不自动重试。下一天 scheduled scan 是新运行，不是隐藏重试。Issue 创建后、预研启动前崩溃留下的超时 pending research 在启动恢复时标为 `failed:trigger_not_started`，等待 CEO 显式重试。

### 7.2 DRI Issue → 预研

DRI 最低输入：

```text
submitterPersonId
title
whyNow
source material / sourceRef
proposed location
red 时额外 decisionBy + reason
```

DRI 不必提供选项。输入通过 schema、身份和 location 校验后直接创建 pending Issue，并执行统一预研；缺字段在接口层拒绝，不建立 CandidateIssue。

### 7.3 CEO 直接决定

```text
Issue ready
  ↓
CEO 选择 option 或编辑 decisionText
  ↓
确认卡展示最终文本、归属和依据状态
  ↓
Action 写 Receipt + Issue.decided
```

Research 未 ready 时默认禁用。CEO 选择旁路后必须二次确认，Receipt 保存 `researchStatusAtDecision`。

### 7.4 Issue → Meeting → Outcome

```text
Issue 加入已有／新建 Meeting
  ↓
会前 Agent 生成 preflight entries
  ↓
CEO 核对、编辑、请补充、带到会议、提交预审
  ↓
外部产生 warmap-transcript.v1
  ↓
CEO 页面或受鉴权 API 上传
  ↓
整份硬校验通过 → Meeting.held
  ↓
Pi 会后复盘 Agent 生成 Outcome candidate
  ↓
turn / speaker / owner / CEO 权限校验
  ↓
通知浮卡逐项 confirmed / dismissed
  ↓
Receipt / DRI Handoff / CEO judgment / Radar anchor
  ↓
全部处理 → Meeting.reviewed
```

### 7.5 MonthlyPlan

```text
每月首日 scheduler
  ↓
读取已确认方向、上月复盘、DRI 反馈和 CompanyMemory
  ↓
Pi 月度装配 Agent → draft
  ↓
CEO 二级页逐项核对、编辑
  ↓
导入 DRI 反馈 → negotiating
  ↓
CEO 签发 → confirmed
  ↓
刷新战场目标和 Radar 基础锚点
```

### 7.6 Conversation

```text
Web 提交 message + scope + selected Card IDs/versions
  ↓
API 保存 user message
  ↓
恢复该 scope 的 Pi entries
  ↓
注入当前对象最新快照 + reference snapshots
  ↓
Pi Agent 自主回答／调用 CompanyMemory MCP／Web Search
  ↓
流式返回事件
  ↓
API 保存 assistant message + runtime entries
```

---

## 8. Pi Agent Runtime

### 8.1 生产隔离

生产 API 使用自定义 ResourceLoader：

- 不读取 `~/.pi`；
- 不发现用户 Skills、AGENTS、Prompt、Extension；
- 禁用 `read`、`bash`、`edit`、`write` 等全部内置 coding tools；
- 不给 Agent 任何业务写 Tool；
- 每个场景只加载自己的 Prompt 和明确 Tool。

### 8.2 Chat tools

```text
web_search
list_company_memory_sections
search_company_memory
get_company_memory_passages
```

当前业务对象和 Card 引用由 API 每轮直接注入，不开放业务库遍历 Tool。

### 8.3 Search 策略

真实 Pi 探针结果：

- 简单问题 0 次搜索；
- 单一外部事实 1 次搜索；
- 对象不清楚时不盲搜；
- 要求两组独立来源时自然执行 3 次后停止。

生产规则：

- Agent 自主判断搜索次数；
- Prompt 要求证据足够后停止；
- 单 turn 180 秒超时；
- 单 turn 8 次 Search 为异常保护，不是正常预算；
- 达到保护值时 Tool 返回预算耗尽并终止；
- 记录次数、耗时、usage 和来源；
- 不因一次实验把正常上限固定为 3。

### 8.4 Compaction

真实探针已验证：

- 200 条消息可压缩为 1 条 compactionSummary + 154 条保留消息；
- 返回 firstKeptEntryId、tokensBefore、estimatedTokensAfter 和 usage；
- entries JSON round-trip 后可恢复相同有效上下文。

压缩只改变 Layer 2 执行态，不删除 PostgreSQL 原始 Conversation。

### 8.5 批处理 Agent

Radar、预研、预审、会后复盘和月度装配使用临时 Pi Session。每个 Session 只开放必要只读 Tool 和严格 TypeBox schema 的 `submit_candidate`。

`submit_candidate`：

- 只把候选交给编排器；
- 不写数据库；
- schema 不合法则不接受；
- 成功后终止 loop；
- 编排器执行第二次领域校验并保存候选。

### 8.6 Prompt 文件

```text
prompts/warmap/radar-plan.md
prompts/warmap/radar-assess.md
prompts/warmap/pre-research.md
prompts/warmap/preflight.md
prompts/warmap/postmeeting.md
prompts/warmap/monthly-draft.md
prompts/warmap/chat.md
prompts/warmap/compaction.md
```

每个 Prompt 有独立版本。Prompt 不内嵌在 React、route 或通用 Agent 类中。

### 8.7 模型槽位

```text
LIGHT_MODEL
HEAVY_MODEL
COMPACTION_MODEL
```

- light：Radar、预审、月度、普通 Chat；
- heavy：预研、会后复盘、复杂 Chat；
- compaction：Conversation 压缩。

多个槽位可以暂时指向同一模型。前端不显示模型选择器。模型、端点、API key 和思考档位来自后端 `.env`。

### 8.8 失败与重试

统一规则：失败可见，不自动重试。

- 页面展示阶段、错误和最近 runId；
- CEO 可显式重试支持的任务；
- 重试产生新 runId；
- 不自动升档；
- Agent 故障不伪装成空数据成功。

---

## 9. CompanyMemory MCP 与外部边界

### 9.1 CompanyMemory MCP

路径：`/mcp/company-memory`

MVP 与 API 同容器部署，但协议独立，未来 DRI Agent 和 CoAgent 直接复用。

只读能力：

```text
list_sections
search_sections
get_passages
search_people
```

返回内容必须带 section ID、更新时间和来源定位。MCP 不提供写入。

当前 Markdown 和未来数据库都藏在 MCP 内部，调用契约不随存储迁移改变。

### 9.2 DRI 导入／导出

使用独立服务凭据，不使用 CEO Cookie。

入站：

```text
DRI Issue
Meeting 基础信息
MonthlyPlan 反馈
普通待办执行反馈
Transcript
```

出站：

```text
Supplement Request
MeetingOutcome confirmed todo
MonthlyPlan confirmed todo
```

没有真实渠道时出站状态为 `pending_export`。生成 JSON 文件不等于 DRI 已收到。

### 9.3 Web Search 与公众号

MVP 各落一个真实渠道：

- 单一 Web Search Provider，供 Radar、预研和 Chat 共用；
- 单一公众号账号级获取渠道，供 Radar 使用。

不建立多供应商插件平台。Provider 与公众号渠道选型是实现前 PoC，未通过前 Radar 必须显示“未配置”，不能用假数据宣称链路完成。

---

## 10. 后端、部署和安全

### 10.1 技术栈

```text
edge        Caddy · HTTPS/TLS 与统一路由
apps/web    Next.js + React + CSS Modules
apps/api    Node.js + TypeScript + Fastify + TypeBox + Pi SDK
storage     PostgreSQL
runtime     单机 Docker Compose
```

不使用 Redis、消息队列、S3、MinIO、Kubernetes 或独立 worker。

### 10.2 Scheduler

API 进程内运行轻量 scheduler：

- PostgreSQL 锁防并发；
- 公司日期键防每日／每月重复；
- 启动时检查当天和当月漏跑并补触发；
- 运行状态写业务对象／配置；
- 历史细节写应用日志和 LangSmith，不建 ScanRun 实体。

### 10.3 鉴权

- `.env` 配置单 CEO 凭据；
- API 校验后签发 HttpOnly、Secure、SameSite Cookie；
- 删除座位选择和 DRI 页面身份；
- DRI import/export 使用独立 service token；
- CompanyMemory MCP 使用服务鉴权；
- 所有业务 Action 校验 CEO 身份；
- 前端构建产物不包含服务密钥。

### 10.4 LangSmith

所有场景记录应用可见的：

- run 和 Prompt 版本；
- 完整输入／输出；
- Pi Tool 事件；
- usage、耗时和错误；
- object ID 和 scope。

不要求 LangSmith 捕获 Provider 内部传输细节，也不依赖 LangSmith 恢复业务状态。密钥和访问令牌永不进入 trace。

### 10.5 数据与备份

- PostgreSQL 保存六实体、配置、Transcript JSONB、Agent 候选、Conversation 和 Pi entries。
- 所有数据库时间为 UTC；Card 按 `Asia/Shanghai` 展示。
- 宿主机 cron 每天执行 pg_dump，使用 age 公钥加密后经 SSH/SFTP 上传异机并至少保留 7 天；API 镜像不承担备份。
- 提供独立 restore 脚本，上线前完成一次真实恢复验证。
- Docker volume 不是备份。

### 10.6 健康检查

- Web `/healthz`：只检查 Web 进程，不碰上游。
- API `/healthz`：报告 PostgreSQL、模型槽位、Search、公众号、MCP 和 scheduler 是否配置／可用，不泄露值。
- 查询健康状态不得触发真实模型或搜索调用。

---

## 11. `frontend → apps/web` 清理和迁移

### 11.1 策略

不在当前 `frontend/` 原地清理。新建空的 `apps/web`，以目标 Card contracts 为输入，只迁移已确认视觉和交互；目标验收后删除整个旧 `frontend/`。

不迁移旧业务数据和 `localStorage`。需要视觉回归的 fixture 由 `apps/api` 提供可删除的演示数据。

### 11.2 迁移候选

| 当前内容 | 处理 |
|---|---|
| `components/ceo-warmap/*.module.css` | 迁移 scope 内样式，删除未使用规则 |
| `workspace.tsx` | 拆为页面壳、路由层、Card 渲染和 Conversation；不复制业务状态 |
| `home-board.tsx` | 改为 Card props，保留布局 |
| `progress-card.tsx` | 保留翻转；删除百分比计算和 mission 快照业务 |
| `notifications.tsx` | 改为四种通知 Card；删除固定 ID、localStorage 和本地回执 |
| `issue-workspace.tsx` | 改为 `/issues/:id` Card renderer，保留视觉 |
| `meeting-workspace.tsx` | 改为 `/meetings/:id` renderer，增加同风格 Transcript 上传和 Outcome 对照 |
| `heavy-workspace.tsx` | 仅提取 MonthlyPlan／预审的视觉与编辑微交互，不保留 notice ID 模型 |
| `radar-feed.tsx` | 改为 `/radar` 与 Signal Card renderer |
| `anchor-editor.tsx` | 保留浮层交互，字段改为后端 RadarConfig schema |
| `conversation-transcript.tsx` | 保留 Markdown、来源和思考态，接 Pi 事件流 |
| `card-references.tsx` | 保留引用托盘，改为 Card ID/version |
| 品牌字体、标识、Access UI | 迁移并删除 seat／DRI 分支 |

### 11.3 明确不迁移

```text
src/app/(tkos) 除目标首页视觉外的全部旧页面
src/app/_views
src/app/dri
src/app/operator
src/app/sec
src/app/showcase
src/app/ceo-prototype
src/app/api 的全部业务 route
src/components/advisor
src/components/agenda
src/components/dri-workspace
src/components/meeting
src/components/recording
src/components/stage
src/lib/agent
src/lib/data
src/lib/research
src/lib/recording
src/lib/asr
src/lib/tts
src/lib/ontology
src/lib/graphknowledge
src/lib/scan
src/lib/models
src/lib/stage
frontend/services/memory-adapter
旧 cognitive / engineering prompts
旧 scripts 和 PowerShell 运维入口
```

`FoldMaterialDesk`、语音、TTS、ASR、录音、深研、能力独立页、本地命令解析、旧 DecisionModel、MeetingModel、Radar server 和所有 seed 数据不迁移。

### 11.4 新 Web 路由

```text
/access
/
/issues/[id]
/meetings/[id]
/radar
/radar/signals/[id]
/plans/[period]
/healthz
```

Next 不保留业务 API Routes。反向代理把 `/api/*` 与 `/mcp/company-memory` 交给 Fastify。

### 11.5 新 Web 初始依赖

```text
next
react
react-dom
lucide-react
clsx
react-markdown
remark-gfm
swr
```

不迁移 Bedrock SDK、火山 TOS、`unpdf`、ASR／TTS、`class-variance-authority`、`tailwind-merge` 和 Tailwind。确有新用途时再增加依赖。

### 11.6 前端测试

只保留新的 Web 合同与交互测试：

- 每个 Card kind 渲染；
- 稳定 URL 与返回；
- Action 请求只包含 actionId、version、input；
- Conversation scope 切换；
- 引用选择和快照发送；
- Access guard；
- loading／error／not-found；
- 键盘、焦点、Escape 和 reduced-motion；
- scope 内视觉基线。

评分、状态迁移、Agent、Transcript 校验、调度和生命周期测试全部属于 API。

### 11.7 删除门槛

只有以下条件全部满足后删除旧 `frontend/`：

1. 新 Web 所有目标 URL 可用；
2. scope 内视觉回归通过；
3. 四条业务链从新 Web 调用真实 API；
4. Web bundle 不含旧业务数据和服务密钥；
5. 新旧入口切换后无旧路由依赖；
6. 用户确认像素级重构结果。

删除后不保留兼容层、重定向页面或旧数据迁移脚本。

---

## 12. 测试与验收

### 12.1 API 最小测试

- Issue：Radar/DRI 创建、自动预研、决定、旁路、dismissed、精确撤回；
- Signal：独立 read/save/dismiss、门槛、red、去重、自动升级；
- Meeting：创建、预审、Supplement Request、Transcript 整份校验、状态；
- Outcome：turn 引文、speaker、owner、CEO 权限、逐项 effect、撤回；
- MonthlyPlan：每月一次、反馈、签发；
- Conversation：scope 隔离、Pi entries round-trip、compaction；
- Card：版本冲突和 Action 幂等；
- Scheduler：日期键、启动补跑和并发锁；
- Auth：CEO Cookie、service token 和 MCP token；
- GET：无副作用。

### 12.2 真实 MVP 验收

1. Web Search 或公众号真实来源产生 Signal。
2. Signal 自动升级且 CEO 无需二次“形成议题”。
3. Issue 立即出现，Research 状态真实更新。
4. CEO 完成一次直接决定。
5. DRI Issue 完成 Meeting 全链。
6. 至少两个 Outcome item 分别确认／忽略，并精确撤回一个。
7. MonthlyPlan 自动生成并签发。
8. global、Issue、Meeting Conversation 不串话。
9. Chat 自主调用 Search；异常保护有效。
10. Pi entries 经 PostgreSQL JSONB 恢复。
11. CompanyMemory MCP 返回目录、段落和人员来源。
12. 备份恢复后对象、Transcript 和 Conversation 可读。

---

## 13. 实施顺序

1. 建立 Monorepo、Caddy、Docker Compose、PostgreSQL、Fastify、TypeBox 和 OpenAPI，并把职责与依赖边界写入 CLAUDE.md。
2. 建立六实体、两配置、Action 和 Card 投影。
3. 接入 Pi SDK、自定义 ResourceLoader、模型槽位、Session JSONB 和 LangSmith。
4. 建立只读 CompanyMemory MCP，并加载通过 `company-people.v1` 校验的真实人员 seed。
5. 跑通 Conversation 四层记忆和 Web Search Tool。
6. 跑通 Radar／公众号 → Signal → 自动 Issue → 预研。
7. 跑通 DRI import/export、Meeting、Transcript 和 Outcome。
8. 跑通 MonthlyPlan scheduler、反馈与签发。
9. 冻结旧前端 scope 内视觉基线，新建 `apps/web` 做像素级重构。
10. 补齐 scope 外交互并做端到端验收。
11. 实际恢复 PostgreSQL 备份。
12. 用户确认后删除整个旧 `frontend/`。

---

## 14. 未决 PoC 与明确限制

实现前必须完成，但不再属于产品意图问题：

1. 选择一个真实 Web Search Provider。
2. 选择一个真实公众号账号级获取渠道。
3. 验证 `HEAVY_MODEL`。
4. 验证 CompanyMemory Markdown 与未来数据库在同一 MCP 契约下的返回质量。

这些 PoC 未通过时，相应链路显示未配置或失败，不使用旧数据、假数据或 silent fallback 冒充完成。

---

## 15. 消融检查

| 未建立 | 当前替代 | 以后何时再加 |
|---|---|---|
| Notification 实体 | 对象状态投影 | 多用户通知已读需要同步时 |
| ResearchJob | Issue.research + Agent 运行日志 | 需要队列运营和历史管理时 |
| ScanRun | RadarConfig.lastRun + 日志 | 扫描历史成为业务对象时 |
| Todo 实体 | Outcome／MonthlyPlan 内嵌 + DRI Handoff | WarMap 承担任务执行时 |
| Approval 工作流 | Outcome item Review | 出现多角色多级审批时 |
| BattlefieldProgress | MonthlyPlan + DRI 反馈投影 | 有真实、稳定进度模型时 |
| 多 Runtime 适配层 | Pi SDK | 第二 Runtime 确实同时上线时 |
| 独立 MCP 容器 | API 内 MCP endpoint | DRI/CoAgent 需要独立扩缩容时 |
| 搜索多供应商平台 | 单一 Search Provider | 单渠道真实不可用时 |
| 对象存储 | PostgreSQL JSONB | Transcript 体量实际超出时 |
| 消息队列 | API 内 scheduler + DB 锁 | 单机吞吐实测不足时 |
| 移动端／语音 | 桌面文本 Web | 四条核心链稳定后另立需求时 |

结论：当前六实体、两配置、Pi Runtime、只读 CompanyMemory MCP 和类型化 Card 已覆盖 MVP。其余能力删除后仍满足全部确认意图，不应提前加入。

---

## 16. 关联架构与时序图

- 技术架构：`docs/diagrams/CEOwarmap_技术架构.html`
- 六实体生命周期：`docs/diagrams/CEOwarmap_六实体生命周期.html`
- 雷达自动升级：`docs/diagrams/CEOwarmap_雷达自动升级时序.html`
- 预研到 CEO 决定：`docs/diagrams/CEOwarmap_预研到决定时序.html`
- 会议准备与 Outcome 抽取：`docs/diagrams/CEOwarmap_会议准备与抽取时序.html`
- 会后逐项确认：`docs/diagrams/CEOwarmap_会后逐项确认时序.html`

时序图拆分为四张，避免把 Radar、Research、Meeting 和逐项确认压进一张不可读的长图。每张 HTML 都是自包含 Archify Viewer，支持主题切换、缩放、搜索、关系追踪和导出。
