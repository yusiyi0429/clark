# UpgradeDesign.pen 字段级差异审计

- 设计基线：`UpgradeDesign.pen`，经 Pencil MCP 于 2026-09-20 重读（加密 `.pen` 未被直接读取）。
- 审计模式：设计稿是视觉、交互和 CEO 可见字段基线；实体、状态迁移、权限与存储仍按既有领域边界裁决。
- 用户澄清：语音能力与 Conversation 创建业务产物均不在最新稿范围；Dock 中的相关句子只按对话文案处理。会议原始文件材料是本轮唯一确认的新增业务能力。
- 当前实现取证：`packages/contracts/src/{meetings,transcript,issues,radar,conversations,monthlyPlans,battlefields}.ts`；`apps/api/src/{app,meetings,signals}.ts`；`apps/web/src/{cards,conversation,components}`。

## 结论

1. **唯一确定的新增领域能力是 Meeting 原始材料。** 当前 Meeting 只保存 `preflight`、`draft`、`transcript`、`outcome`；没有材料清单、二进制对象、受控下载/预览、上传、替换或与补充请求的关联。
2. 首页、Radar、Issue、Outcome、MonthlyPlan、Access 的绝大多数可见字段已可由当前 Card payload 支撑；主要是 renderer、文案、状态提示或现有数据缺口，不应扩张实体。
3. Dock 的**多会话列表、新建和删除**在设计稿中是实际交互，不是现有按 scope 单一 Conversation 能表达的字段，需另行决定是否采纳。它不改变业务事实，但会改变 `Conversation` 的标识与 API。
4. Signal 页“内嵌原文全文”不可由当前 `Signal` 事实源支撑。当前有 URL、摘录、证据、研判和状态；没有抓取全文或可展示正文。除非明确纳入抓取与版权/安全边界，否则应保持外链 + 摘录。

## 1. Meeting 原始材料（确认新增）

| 设计稿字段/动作 | 当前字段或实现 | 差异 | 最小建议 |
|---|---|---|---|
| 会前材料分组 | 无；`MeetingCardPayload` 仅有 `preflight`、`draft`、`transcript`、`outcome` | **缺失** | 在 Meeting 内嵌 `materials[]`，不建第七业务实体。字段至少含稳定 `id`、`fileName`、`mimeType`、`sizeBytes`、`pageCount?`、`receivedBy`、`providedBy?`、`uploadedAt`、`storageKey`、`sha256`。 |
| 文件格式标签：PDF/PPT/MD/DOCX/JSON | Transcript 仅接受 `warmap-transcript.v1` JSON | **缺失** | **已修订确认首版只支持**可抽取文字的 PDF、DOCX、Markdown（`.md`）；不支持 TXT、PPT/PPTX 或旧 `.ppt`。原始材料 MIME/扩展名白名单与 Transcript 上传端点完全分离；Transcript 仍是唯一可进入 Outcome 的结构化输入。 |
| 上传会前材料，多文件拖拽 | `CreateMeetingRequest` 无材料；仅 `/api/meetings/:id/transcript` multipart 单文件 | **缺失** | **已修订上传边界**：创建 Meeting 后，不把二进制塞进 Action JSON。CEO 仅通过“替换会前材料集”上传 `files[]`（可为空，每份可选 `providedBy`，全批解析成功才原子替换）。不提供 Supplement Request 的材料上传端点；`ready` 时材料只读，CEO 先显式“返回编辑材料”令 preflight 失效为 `pending` 后才可操作材料。 |
| 文件名、页数、上传者、上传日期、系统同步 | 无 | **缺失** | 元数据真实保存；`pageCount` 仅在可解析时存在，不从文件名猜测。**已确认上传身份模型**：`receivedBy` 固定为实际上传的 CEO `personId`；`providedBy?` 是 CEO 从人员目录选择的材料提供人，空值显示 CEO 代收。展示名由人员快照/目录解析。 |
| 查看原始材料 / 正文预览 | 无受控下载、预览或对象存储边界 | **缺失** | API 鉴权后提供流式下载/预览；Web 不持久化文件。MVP 优先浏览器原生预览/下载，不建设自研 PDF/PPT 渲染器。 |
| 补充材料“回应请求补充材料” | `SupplementRequest` 有 `id`、`entryId`、`targetDriId`、`text`、外发回执；没有回传材料关联 | **本期不实现** | **已修订：preflight 进入 ready 后材料集冻结，不接收补充材料。** Supplement Request 仍只记录向 DRI 的外发请求和真实渠道回执，不关联 Meeting Material。设计中的“已收到补充材料 / 查看”状态不进入本期范围。 |
| 替换整份材料、二次确认、旧预审/引用失效、重跑 | 仅有 `meeting.replace_transcript`，且其 effect 是重跑 Outcome | **缺失** | **已确认：替换整个会前材料集。** 确认后原子化保存新集合、删除旧会前材料元数据及 volume 文件、使 preflight 失效；CEO 再显式重跑。Supplement Request 不关联材料，因而不存在材料追加或保留路径。 |
| “材料 4 份已解析 / 预审可提交” | `preflight.status/readiness` 可表达预审是否完成，不能表达材料解析 | **缺失** | **已确认：上传批次中任一文件解析失败即整批拒绝。** 不持久化失败原件或半套材料；因此当前 materials 中仅会存在已完成解析的材料，任一当前会前材料不完整/未解析即禁止预审。 |
| “只读依据，不参与判断与抽取” | 与同一设计稿中的“上传材料后即可开始预审”“替换后重跑分析”相冲突 | **待裁决** | 需明确材料是 **A. Agent 输入依据**，还是 **B. 仅 CEO 查阅附件**。A 才需要抽取文本和进入 preflight；B 不应触发重跑。不能同时成立。 |

### 建议的最小边界

- `MeetingMaterial` 是 **Meeting 内嵌值对象**，不是第七实体；材料二进制**已确认保存在仅 API 容器挂载的 Docker named volume**，数据库仅保存元数据、相对 storage key、SHA-256 和必要抽取状态。只有 CEO 可经已鉴权 Web/API 上传、预览和下载，永不直接访问 volume；不新增 DRI service 上传入口。
- **已修订解析实现**：MVP 只接收可抽取文字的 PDF、DOCX、Markdown。Markdown 由 Node 做 UTF-8 校验读取；PDF 使用文本抽取工具；DOCX 使用受限转换/抽取工具。每次解析使用独立临时目录、禁用网络、设置超时、文件大小/解压后大小/输出文本上限。**MVP 不做 OCR**；扫描 PDF 或没有有效文字层的文件即解析失败。原件保存后只将受限抽取文本和 `material:<id>` 引用交给 preflight；Outcome 仍只读取 `warmap-transcript.v1`。
- **已确认查看语义**：PDF 经鉴权 API 流式返回原件并由浏览器预览；Markdown 显示安全渲染的原文正文；DOCX 显示服务端从原件抽取的受限 HTML 正文，同时提供原件下载。不承诺 DOCX 与 Word 像素一致，不使用模型改写材料。
- **已确认容量**：每份最大 20 MB；会前材料集最多 10 份；一次材料集替换最大 100 MB；每份抽取文本最多 100,000 字符，当前输入 preflight 的全部材料文本最多 300,000 字符。超限直接拒绝，不能截断并假装材料完整。
- **已确认重跑时机、输入与失效引用**：会前材料上传成功仅令 preflight 为 `pending`，由 CEO 显式点击既有“重新预审” Action 运行。上传不自动调用 Agent；运行时只读取当前会前材料集，并记录 `material:<id>` refs。preflight 为 `ready` 时不接收补充材料；CEO 必须先显式返回编辑材料才可令其失效。旧 preflight 不再作为当前内容展示；其已删除 `material:<id>` 只显示“材料已由 CEO 替换/移除，原件不再保留”，不提供正文或下载。没有任何材料时，保留现有基于 Issue/Research 的预审并标记 `inputCoverage.sourceMaterial = missing`。
- **已确认材料集替换语义**：仅 `scheduled` Meeting 可操作会前材料；`held`、`reviewed`、`cancelled` 后只读。preflight 为 `ready` 时材料亦只读，CEO 须显式“返回编辑材料”并二次确认，让当前 Candidate Material 失效并回到 `pending`，才可上传或替换；这是 CEO 明确触发的最小回退，不增加自动或动态状态迁移。回退后即使未替换材料，CEO 也可明确重新预审同一材料集。CEO 可经二次确认替换为**空会前材料集**，回到既有 Issue/Research-only 预审路径。替换整个会前材料集时，旧会前材料的数据库元数据、volume 文件和抽取文本一并删除，只保留最新材料数据。每次材料集变更保持 preflight `pending`，CEO 显式重跑；不改变 Transcript 或 Outcome。**Q32 已确认：Outcome 复核页的原始材料弹窗仅保留材料查看和会议上下文，移除“返回编辑材料”入口。**
- 沿用当前危险替换模式：签名 Action + `confirmReplace: true` + 版本冲突 + 幂等指纹。新能力不需要队列、通用文档系统或文件管理页。
- **已确认备份与恢复边界**：每批备份使用同一 UTC 时间戳生成 PostgreSQL dump 与材料 volume tar；二者一起 age 加密、校验并异机复制，恢复只接受同批次。备份前 API 必须停止材料写入（maintenance/read-only）；恢复先还原 volume、再还原数据库，并以同镜像校验每个当前材料的 `storageKey` 和 SHA-256 可读。未完成联合备份/恢复验收不得部署此能力。
- **ADR 影响**：该选择与现有“Web/API 不创建业务文件卷”的部署约束冲突，实施前必须新增 ADR 或修订该约束；仍不引入对象存储或新服务。

## 2. 其余页面的字段差异

### Home / Battlefield / Notification

| 设计稿字段 | 当前支撑 | 结论 |
|---|---|---|
| 公司/战场/能力 Issue、决定期限、紧急度 | `Issue.location`、`urgency.level/decisionBy`，`HomeBoard` 已按 location 投影 | 已有；能力名称目前显示 capabilityId，设计稿若要求中文名则需要配置展示名，不是新实体。 |
| 战场正反面：目标、待决策、普通待办、外发状态、最新 DRI 反馈 | `BattlefieldCardPayload`：`target/pendingIssues/todos/latestFeedback` | 已有；“undefined”是 renderer 格式化缺陷，不是字段缺失。 |
| Radar 未读数、会议和月度通知 | Radar unread 与 Meeting/Monthly Card 投影已有 | 已有投影；通知不应建实体。 |
| 通知空态、loading/error/重试 | UI 状态 | 仅 Web 状态与文案收敛。 |

### Radar / Signal

| 设计稿字段/动作 | 当前支撑 | 结论 |
|---|---|---|
| 全部/未读/最新采集/影响优先 | 全量 Signal Card 含 `state.read`、`assessment.score`、`collectedAt` | 数据已有；列表过滤/排序是 Web 缺口。 |
| 扫描进度、上次扫描、锚点/来源只读范围 | `RadarPayload.lastRun/anchors/sources` | 已有；`lastRun` 只能如实显示服务端已产出的 trigger/status/warnings，不能伪造逐锚点实时进度。 |
| Web/公众号/发布方媒体来源 | `RadarSources` 及 outlets adapter | 已有；设计中的媒体枚举须来自配置，不硬编码。 |
| Signal 来源、URL、发布时间、摘录、影响、未知、已读/收藏/隐藏 | `SignalPayload.source/assessment/state/collectedAt`，PATCH state | 已有。 |
| 内嵌原文全文和正文段落 | 当前只保存 `excerpt`；`SignalCard` 只展示证据引文与外链 | **数据不可得**；保持外链 + 摘录，除非另立全文抓取、存储、版权与安全方案。 |
| Signal 对话“挂到某 Issue” | 仅普通 Conversation 文案；契约禁止 Conversation 创建/修改对象 | 按用户澄清为文案，不是 Action/字段缺口。 |

### Issue

| 设计稿字段/动作 | 当前支撑 | 结论 |
|---|---|---|
| pending/decided/dismissed、来源、位置、期限 | `IssuePayload` 全部已有 | 已有。 |
| 预研摘要、选项/后果、证据、未知、来源 | `ResearchDoc` 全部已有 | 已有；Research tab 已实现。 |
| 直接决定、预研 override、重跑、加入/新建 Meeting、dismiss、撤回 | opaque Action 已有 | 已有；不改变状态语义。 |
| decided 页的决定时预研状态、日期、撤回 | `IssueReceipt` 已有 | 已有。 |
| dismissed 原因、日期 | `dismissReason/dismissedAt` 已有 | 已有。 |

### Meeting / Outcome（除原始材料外）

| 设计稿字段/动作 | 当前支撑 | 结论 |
|---|---|---|
| 会议信息、DRI、参会人、关联议题 | `MeetingCardPayload` | 已有。 |
| 会前预审：核心判断、点评、战略一致性、积极信号、风险、追问、下一步、依据、核对、补充请求 | `preflight.entries`、`taskDefinition/readiness/summary`、`draft`、`SupplementRequest` | 已有；设计字段由 entry kind 和 draft 投影，非新增表字段。 |
| 会议阶段：预审/进行/Outcome | `Meeting.status` + transcript/outcome | 已有；文案映射即可。 |
| Transcript 导入、Outcome 摘要、逐项决定/todo/CEO 判断/复议/未收敛事项，确认/忽略/撤回 | `StoredTranscript`、`MeetingOutcomeState`、opaque item actions | 已有；open 项仍只展示，不产生效果。 |
| “会议材料对话” | `Conversation scope=meeting:<id>` | 已有；只是 sidebar 标题/布局。 |

### Monthly Plan

| 设计稿字段/动作 | 当前支撑 | 结论 |
|---|---|---|
| 协商中/草案就绪/已签发、公司与战场结果 | `MonthlyPlanCardPayload.status/generation/companyOutcome/battlefields` | 已有。 |
| todo、负责人、截止、来源、外发状态 | `todos/exports` | 已有；不添加执行完成度。 |
| DRI 反馈、备注、逐项核对、保存、二次确认签发 | `negotiation` + update/sign actions | 已有。 |
| 签发刷新战场目标/Radar anchors、不更新 CompanyMemory | 现有 effects 与 ADR 边界 | 已有，必须保留。 |

### Access / 交互规范

| 设计稿字段/动作 | 当前支撑 | 结论 |
|---|---|---|
| 品牌背景、时钟、日期、口令、错误、进入 | `AccessScreen` + session API | 已有。 |
| hover/focus/press/disabled/loading、150ms、骨架/错误重试 | CSS/组件行为 | 视觉与 a11y 收敛项；不是 API/领域字段。 |

### Conversation Dock

| 设计稿字段/动作 | 当前支撑 | 差异 |
|---|---|---|
| 输入、SSE、停止、Card 引用、对象 scope 隔离 | `ConversationDock`、Conversation API、Pi runtime | 已有。 |
| 可引用卡片与已签发计划 | 当前引用集合是 Issue/Signal/Meeting/MonthlyPlan；后端快照 Card | 已有，文案可调整。 |
| 多个命名会话、轮数/时间、创建新会话、删除确认 | 当前数据模型按 `scope` 唯一一条 Conversation；无 list/create/delete session API | **需契约/后端变更**。若采纳，需引入 `Conversation.id` 为 URL/API 会话键、保留 scope 归属，并定义删除是否物理删除或软删除；不涉及组织事实。 |
| “拖入文件”输入提示 | 当前 Conversation request 仅 `message + references` | 用户已指定仅 Meeting 原始材料为新增能力；此处应删掉该提示或明确为不可交互视觉文案，**不新增 Conversation 文件上传**。 |

## 3. 优先级与非目标

| 优先级 | 工作 | 原因 |
|---|---|---|
| P0（已裁决） | 明确 Meeting 原始材料是否进入 preflight 输入 | 已采用受控 preflight 输入；Transcript 仍是 Outcome 唯一输入。 |
| P1 | 原始材料最小契约/存储/API/renderer | 已确认的新增能力。 |
| P1（待产品确认） | Dock 多会话管理 | 设计稿有真实交互，但不是用户明确确认的新增领域能力。 |
| 不做 | Signal 全文抓取、Conversation 文件、语音、Conversation 改业务对象 | 无现有事实源或已被用户排除；会无必要扩大 MVP。 |
| 视觉批 | Radar 过滤、状态文案、Access/Interaction、Home 的展示名与格式化 | 多数可复用现有 Card 字段，不改后端契约。 |

## 唯一阻塞问题

会议原始材料在设计稿中同时写成“上传后用于会前预审/替换后重跑分析”与“只读依据、不参与判断与抽取”。实现前必须选择一项：

- **A（已确认）**：会前材料是 preflight 的受控输入；材料集替换使 preflight 失效并重跑；Outcome 仍只由 Transcript 产生。
- **B（不采用）**：会前材料只供 CEO 查阅；不会进入 preflight、不会令预审失效；“上传后即可开始预审/重跑分析”文案应从设计稿删除。

## 4. Q30–Q32 状态页收口

- Q30：保留“Meeting 会前预审 · 原始材料弹窗”和“Meeting Outcome 复核 · 原始材料弹窗”两个独立状态页。
- Q31：确认回退到编辑态后，未替换材料即离开仍保持 `pending`；CEO 可稍后继续编辑或手动重新预审。
- Q32：Outcome 复核页的原始材料弹窗只提供材料查看和最小会议上下文，已移除“返回编辑材料”。该入口只出现在 `scheduled + ready` 的会前预审材料集级分组。
