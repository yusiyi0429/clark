# CEO WarMap

CEO WarMap 是单公司的桌面 Web 决策驾驶舱，以 CEO 的决策为中心。它帮助 CEO 发现变化、形成议题、准备和复盘会议、确认组织判断并签发月度目标；成员可以登录自己的工作台，接收 CEO 发来的信号、推进自己的执行事项并在事项群组里讨论（ADR-0020）。它不承担项目管理、看板、移动端验收或实时语音。

## Language

**CEO WarMap**:
以 CEO 决策为中心的驾驶舱，拥有决策材料、确认结果和独立对话；成员参与信号发送、执行事项与事项群组，并按对象关系读取本月 Mission Card 轮次。
_Avoid_: 项目管理系统、看板、通用协作平台

**Member**:
以自己的身份登录天枢的公司成员（company-people seed 里 roles 不含 ceo 的人），在 `/me` 工作台接收发给自己的信号、推进和参与执行事项；可以在同页展开自己相关的本月 Mission Card，发表公开意见或与自己的 Agent 私聊，战场 DRI 还可打开本战场全部个人卡并执行拍板动作。通知栏顶部按月份、战场展示未确认轮次：普通 Owner 只有自己的行，当前拍板人可看全部行；截止不退组，确认才退出。首页顶部是参与的战场（只写本月目标）与常驻的「我的本月卡」；「参与」指本月是该战场负责人、本轮个人卡 Owner 或在该战场有 Mission，引导与首页共用同一份计算。成员战场详情只给目标、本月个人卡名单与本轮状态，看不到的战场返回 404。CEO 决策页面和专用接口仍不向成员开放。
_Avoid_: 用户账号体系、访客

**Login ID**:
成员与 CEO 登录用的短 ID，取姓全拼 + 名的首字母（如 `sunm`），配合自己设定的 4 位口令使用；初始码由管理员脚本发放，首次登录必须修改。
_Avoid_: 用户名、工号、共用口令

**Signal Share**:
CEO 把一条信号发送给某个人、某个战场或某个业务域。战场的收件人是战场 DRI 加本月该战场所有 Mission 的 DRI，业务域的收件人是本月该业务域所有 Mission 的 DRI；同一条信号的所有收件人与 CEO 共用一个事项群组。
_Avoid_: 转发、分享、DRI Handoff

**Task**:
执行事项：成员为推进一件事而自己定义的工作，有推进人（创建者）和协作者，状态为未启动／进行中／完成；可以从发给自己的信号转化而来，也可以自己开启。推进人改内容与状态，协作者只在事项群组里说话，被拉进来即加入、可以自己退出。
_Avoid_: 任务、待办、项目、Activity

**Item Group**:
事项群组：挂在一条已发送的信号或一个执行事项上的群聊，成员由对象决定（信号：CEO 加全部收件人；执行事项：推进人加未退出的协作者）。
_Avoid_: 聊天室、频道

**Issue**:
由雷达自动升级或 DRI 提交、需要 CEO 决定或带入会议讨论的唯一决策对象。每个 Issue 只属于公司、一个战场或公司能力中的一个位置；MVP 不支持暂缓，也不提供 CEO 主动创建入口。
_Avoid_: Ticket、议案、多个页面各自的议题类型、对话创建的议题

**Dismissed Issue**:
CEO 判定为误升级或不应进入决策面的 Issue。它保留来源关系并阻止同一信号重复升级，但不再出现在待判断区域。
_Avoid_: 暂缓议题、已决定议题、物理删除

**Red Issue**:
存在可核对近期行动窗口的 Issue。Radar 来源必须包含可连续核对的 deadline quote；DRI 提交必须明确提供 decisionBy 和 reason。
_Avoid_: 高影响但没有时限的议题、Agent 主观紧急判断

**Signal**:
雷达采集并研判的外部变化；满足确定性门槛时由系统自动升级为 Issue，不要求 CEO 再确认一次升级。
_Avoid_: 新闻、等待 CEO 手动升级的 Issue 草稿

**Personal Radar**:
成员自己开关、自己写方向（一句话）和来源（网站，可不填）的雷达；命中的个人信号只给本人看，不升级成 Issue、不发送给别人，也不进入公司雷达的列表、未读数和对话。CEO 的雷达就是公司雷达，CEO 在同一个编辑器里补充的是公司雷达的手工方向和媒体来源（ADR-0021）。
_Avoid_: 私人订阅、DRI 雷达、个人议题

**Strategic Issue**:
影响多个战场的 company 级 Issue。它只在战略议题区域出现，不复制到各个受影响战场。
_Avoid_: 多战场重复议题、跨战场标签副本

**Meeting**:
WarMap 拥有的会议决策容器，用于组织会前材料并关联 Issue；会议是形成决定的可选路径。合规 Transcript 导入后会议视为已召开，CEO 也可取消尚未召开的会议。
_Avoid_: 日历事件、外部会议系统副本、会议管理模块

**Meeting Material**:
CEO 上传并归属到 Meeting 的会前文件。MVP 只接受可抽取文字的 PDF、DOCX 和 Markdown；会前材料集是会前预审的受控输入，上传请求中任一文件未成功解析即整批拒绝。CEO 可以确认替换为空材料集；替换会删除旧材料数据、使现有预审候选失效并令 CEO 显式重新预审。preflight 为 ready 时材料只读；仅 scheduled Meeting 的会前预审可显示“返回编辑材料”，CEO 必须先经二次确认使预审候选失效并回到 pending，才能替换材料集。回退后即使未替换材料，也允许 CEO 明确重新预审同一材料集。held 或 reviewed Meeting（包括 Outcome 复核中的原始材料视图）只可查看材料，不提供“返回编辑材料”。此能力没有自动状态迁移或补充材料流程。Supplement Request 仅记录向 DRI 的外发请求，不关联 Meeting Material。Transcript 和 Meeting Outcome 不读取 Meeting Material。MVP 不对扫描件或图片型材料做 OCR，无法抽取有效文本即解析失败。实际接收者是 CEO，材料提供人可以另行记录。解析实现固定为纯 JavaScript 路径：锁定 `node:22.13-alpine`，PDF 使用 `pdfjs-dist`，DOCX 使用 `mammoth` 与 ZIP 预检，Markdown 仅作 UTF-8 受限纯文本；不使用 `pdf-parse`、Office 服务或 native addon。单文件 20 MiB、每批 10 份/100 MiB、PDF 最多 500 页、DOCX 最多 1,000 ZIP entries/250 MiB 解压总量/50 MiB 单 entry/200:1 压缩比、单文件 15 秒/整批 90 秒、每份抽取文本 100,000 字符/Preflight 总计 300,000 字符。加密 PDF、空文字层、DOCX 图片/外部资源/异常 ZIP 和无效 UTF-8 Markdown 均拒绝。每份由 API 启动无 shell 的受限 Node 子进程解析（`--max-old-space-size=256`，15 秒 `SIGTERM` 后 2 秒 `SIGKILL`），整批顺序执行；这不是独立 worker 服务。DOCX HTML 仅按需生成，经服务端 allowlist sanitizer 后展示且不持久化；Markdown 禁止 raw HTML，预览不加载外部资源。
_Avoid_: Transcript、DRI 直接上传、自动生效的会议结论、通用文件库

**Transcript**:
外部按 `warmap-transcript.v1` 结构提供并挂到 Meeting 的逐字发言段集合；每个 speakerId 必须匹配 Meeting 已有 participant，任一条不合规则整份拒绝。CEO 也可以上传妙记导出的 Markdown：服务端只按固定 `### 文字记录` + `姓名 mm:ss`/`hh:mm:ss` 结构做确定性转换，speaker 按人员目录 displayName 精确匹配，0 或 ≥2 命中交由 CEO 手工映射；上传只生成 Meeting 内嵌候选（`transcript_candidate`），不改 status、不跑会后抽取，只有 `meeting.confirm_transcript_candidate` 确认后才写入标准 Transcript、置 held 并启动既有 Outcome Agent。候选与最终 Transcript 都只保存既定结构，原始 Markdown 不复制进 Card/Action JSON，也不落独立文件库；确认后可带可选 `source` 元数据留痕。WarMap 仍不负责录音、语音转写、OCR、通用格式转换或说话人猜测。
_Avoid_: 自动可信的会议纪要、WarMap 录音能力、说话人猜测、部分导入

**Meeting Outcome**:
从会议逐字稿提取、等待 CEO 逐项处理的决定、行动、CEO 判断和复议条件集合。每项独立确认或忽略，确认后立即生效。
_Avoid_: 自动生效的会议纪要、整场捆绑回执

**Supplement Request**:
CEO 在会前要求 DRI 补充材料的请求。系统保存请求不代表已经送达，送达状态必须来自真实外部渠道。
_Avoid_: 本地按钮成功态、会后行动分派

**Company Day**:
`Asia/Shanghai` 时区下的自然日。MVP 不区分工作日、周末或法定节假日。
_Avoid_: 工作日、浏览器本地日期

**Person**:
CompanyMemory 人员目录中具有稳定 personId 的人。显示姓名和角色可以变化，业务引用始终使用 personId。
_Avoid_: 由姓名临时生成的身份、自由文本参与人

**Monthly Plan**:
系统在每月 1 日按 Company Day 自动生成、经 CEO 与 DRI 协商后签发的单月公司结果、战场结果、能力结果（PCO）和普通待办集合，是当月目标的唯一来源。待办不是 Mission 执行实体，不在 WarMap 中跟踪执行状态；当月结果不写回长期配置。
_Avoid_: 通知卡草稿、前端本地计划、Mission 执行实体

**Company Strategy Config**:
CEO 维护的跨月公司长期目标（LTCO）。它是长期配置而不是当月结果，MonthlyPlan 据此生成当月 PCO；MVP 只有一行配置。
_Avoid_: 当月公司结果、月度计划草稿

**Battlefield Config**:
CEO 维护的长期战场注册表：稳定 id、显示编号 code、排序 sortOrder、名称、负责人 personId、六个月目标与内嵌战略锚点列表 `missionAnchors`。锚点是战场图上的只读映射，不是 Mission 实体；当月战场结果只属于 MonthlyPlan。
_Avoid_: 当月战场结果、任务分组、项目管理单元

**Capability Config**:
CEO 维护的长期公司能力注册表：稳定 id、显示编号 code、排序 sortOrder、名称、可选分组、六个月目标与主要支撑引用。当月能力结果（PCO）只属于 MonthlyPlan。
_Avoid_: 技能库、执行能力评估、当月能力结果

**Mission**:
WarMap 的第七个核心实体，对应个人卡中的一项“个人任务”：稳定 id、周期 period、唯一 DRI personId、一个主要能力域、战场引用和来源元数据，内容包括名称、Why、预期结果、成功证据、责任人、边界、关键路径、里程碑、资源与权限、依赖、人-Agent 分工、风险与升级、复盘沉淀 13 个字段。Mission 通过 period 承接 MonthlyPlan 的 PCO，不承载执行状态或完成率。未挂卡的 Mission 沿用 CEO 首次登记与 `mission.edit`；挂卡的 Mission 可以先以 v1 草稿入库，整轮确认前是候选，只有确认后才成为个人承诺的 Organization Fact。投影用 `personalCard.status` 表达制定状态，`placeholder` 表达来源性质；计划签发不等于个人卡确认。挂卡 Mission 全阶段禁止 `mission.edit`，确认后的纠错规则仍属 GAP-04。
_Avoid_: 执行事项、Activity、项目、完成率、执行看板、Mission 进度条

**本月 Mission Card（Personal Mission Card）**:
同一战场、同一月份里一个人的稳定结果承诺容器，保存 Owner、身份与去重后的成员名单，挂接一到多项 Mission。沟通前、沟通中和确认后保留同一个卡 id；草稿与已确定内容必须明确区分。CEO 的 `/mission-cards/[cardId]` 与成员的 `/me/mission-cards/[cardId]` 共用阅读页，呈现 13 字段、来源、版本和可追溯意见；拍板人逐条处理后核对跨人员协作，再统一确认整个战场。确认后同一页保留只读承诺和确认记录。
_Avoid_: 单条 Mission、执行事项、任务看板、飞书原件副本

**Mission Card 轮次（Mission Round）**:
按战场 × 月份唯一的一轮制定，统一管理个人卡的草稿、48 小时窗口、截止快照、重开与最终确认。整理草稿前必须已签发本战场的月度目标；首次开放冻结六个月目标、本月目标及来源版本，重开不改变依据。每次重开从当前应用时间再开放固定 48 小时，保留卡、意见和历次快照；不同战场独立。拍板动作包括整理、开放、逐条处理、重开与整轮确认，均按当前权限和轮次版本校验并支持幂等重放。通知是轮次的只读投影，跨月未确认仍保留；通知和卡页共享校正服务端时间的分钟时钟与状态句。引导只展示公司当前月份的本人卡，已确定后仍保留工作卡，下一件事优先本轮可执行动作。
_Avoid_: 月度计划签发、单人独立倒计时、演示拨钟、重新生成覆盖讨论

**公开意见（Public Feedback）**:
个人卡成员与拍板人围绕整张卡或具体个人任务字段提出的评论、划词引用和修改建议，独立保存在 `mission_card_feedback`，保留作者、时间、原文与源版本。意见不直接改 Mission。截止后只接评论与引用，标为截止后留言；当轮快照不收，重开后可进入下一次快照。页面字段意见与事项群组读取同一份记录，开场和分隔线由服务端现算、不计未读；`mission-card:<id>` 的 Agent 对话按本人隔离，只读且不进 Review。
_Avoid_: 私聊、自动生效的修改、thread_messages 中的通用群聊

**集中 Review**:
截止时按 `created_at < closes_at` 快照全战场公开意见和 Mission 版本，按同字段冲突、依赖原文条数形成确定性规则汇总，私聊不收。重开保留旧 Review，下一次截止结转已处理结论并纳入新意见，协作核对结论不结转。逐条处理只改变候选版本；旧版本、未处理意见、空核对结论、同字段双采纳均阻止确认。整轮确认只写采纳字段，每个涉及采纳修改的 Mission 升一次版本，并记录 applied_versions；重放不重复写入。
_Avoid_: AI 语义判断、逐人孤立确认、采纳即生效、私聊自动并入

**讨论候选（占位草稿）**:
为 2026 年 10 月首轮讨论，从 9 月五张个人卡整理的 12 项有来源候选，只挂战场 01。Agent 起草尚未接入，里程碑写“待定 · ”，保留原文档版本及占位说明。只读 `mission-card-drafts.v1` 经同一事务导入函数写入；相同文件重跑不变，文件变化拒绝覆盖。占位来源标记在确认后仍保留，不能冒充已形成的新月承诺。
_Avoid_: Agent 自动生成、正式承诺、日期机械平移、补造其他人或战场的个人卡

**Mission Anchor**:
战场配置内嵌的只读战略映射 `{code,title}`，可被能力的主要支撑引用（`{type:"mission-anchor",missionCode}`）。它没有表、状态机、负责人或执行 UI，与 Mission 实体是两套命名空间。
_Avoid_: Mission、Mission 执行实体、可跟踪进度

**Candidate Material**:
Agent 生成并可由系统自动保存的研究、预审或会后草稿；它不是已生效的组织事实。ResearchDoc 不被对话局部修改；只有 pending Issue 可由 CEO 显式重跑预研并整份替换当前版本。
_Avoid_: 自动决策、已确认结论、对话拼接的研究文档

**Research Override**:
CEO 在预研未完成或失败时，经过二次确认仍直接决定 Issue 的明确选择。决定必须记录当时的预研状态，不能表述为基于完整预研。
_Avoid_: 静默绕过、伪造已完成预研

**Organization Fact**:
经 CEO 确定性确认后生效的决定、分派、CEO 判断、复议锚点或月度计划。个人卡中的 Mission 须经 CEO 或对应战场 DRI 整轮确认后才成为个人承诺事实；草稿入库不代表生效。
_Avoid_: Agent 候选、对话意见、卡片引用

**Card**:
后端业务对象面向 CEO 或有权成员的类型化投影；它携带展示数据、导航、对话范围和当前允许的动作。
_Avoid_: 通用页面 DSL、独立业务对象

**Action**:
后端提供、由有权操作者明确触发的确定性命令。原 `/api/actions/execute` 仅限 CEO；本月 Mission Card 的新动作端点还允许当前战场 DRI，由服务端逐对象复查。Action 可以改变组织事实，对话和 Agent 不能替代它。
_Avoid_: 对话指令、前端业务回调、Agent 工具调用

**Agent Runtime**:
Pi SDK 在 TypeScript API 服务中提供 agent loop、Tool 调用、Session 和上下文压缩。生产 Runtime 不加载用户级 Pi 配置，只显式开放场景 Prompt、Web Search 和只读 CompanyMemory MCP；它不拥有 Conversation 原文、业务对象或 Company Memory。
_Avoid_: 业务数据库、组织 Action 执行器、四层记忆的唯一事实源

**Four-layer Memory**:
WarMap 的四层数据边界：当前运行上下文、对象独立 Conversation、业务对象记忆、Company Memory。工作／情景／语义／程序等认知术语描述 Runtime 如何使用这些层，不取代产品数据边界。
_Avoid_: Runtime 自有数据库、单一超长 Prompt、把四层都交给 Agent Session

**Conversation**:
属于首页全局或某一个 Issue、Signal、Meeting、Monthly Plan 的独立对话记录。PostgreSQL 保存原始消息，Runtime 只持有执行和压缩状态；Conversation 只能解释和取证，不能创建 Issue、修改 ResearchDoc 或改变组织事实。
_Avoid_: 跨所有页面共享的聊天历史、自然语言命令入口、Runtime 唯一持有的历史

**Company Memory**:
Agent 通过只读 CompanyMemory MCP 按目录和相关段落读取的公司认知底座。CEO WarMap 当前不把单次决定或对话直接写回；同一 MCP 预留给未来 DRI Agent 和 CoAgent 复用。
_Avoid_: WarMap 业务对象库、自动接收所有新产出的知识库

**Memory Update Proposal**:
未来每日统一复盘从产出文件、已确认业务对象和全部已保存 Conversation 中形成，并与 Company Memory 对比后的认知更新候选；只有 CEO 确认后才能生效。
_Avoid_: 实时自动写回、单条 Receipt 的副本

**Open Meeting Item**:
会议中尚未收敛的事项，只在 Meeting Outcome 中展示，不自动或手动转成 Issue。
_Avoid_: Issue 草稿、自动待办

**DRI**:
负责提供议题、材料、反馈或承接行动的人。可以作为 Member 登录自己的工作台，接收发给自己的信号并推进自己的执行事项；当前战场 DRI 可拍板本战场的 Mission Card 制定动作，其他 CEO 决策权限不随之开放。议题导入、月度反馈与 DRI Handoff 仍经机器令牌的导入导出边界。
_Avoid_: 拥有全部 CEO 决策权限的共同用户

**DRI Handoff**:
WarMap 向外部 DRI 流程导出的补充请求或已确认行动。没有真实渠道回执时只能称为待外发，不能称为已送达或已分派。
_Avoid_: WarMap 内部任务、伪造的发送成功
