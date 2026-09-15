# CEO WarMap

CEO WarMap 是单公司、单 CEO 的桌面 Web 决策驾驶舱。它帮助 CEO 发现变化、形成议题、准备和复盘会议、确认组织判断并签发月度目标，但不承担任务执行、项目管理、移动端验收或实时语音。

## Language

**CEO WarMap**:
CEO 使用的决策驾驶舱，拥有决策材料、确认结果和独立对话。
_Avoid_: 项目管理系统、任务执行系统、协作平台

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

**Strategic Issue**:
影响多个战场的 company 级 Issue。它只在战略议题区域出现，不复制到各个受影响战场。
_Avoid_: 多战场重复议题、跨战场标签副本

**Meeting**:
WarMap 拥有的会议决策容器，用于组织会前材料并关联 Issue；会议是形成决定的可选路径。合规 Transcript 导入后会议视为已召开，CEO 也可取消尚未召开的会议。
_Avoid_: 日历事件、外部会议系统副本、会议管理模块

**Transcript**:
外部按 `warmap-transcript.v1` 结构提供并挂到 Meeting 的逐字发言段集合；每个 speakerId 必须匹配 Meeting 已有 participant，任一条不合规则整份拒绝。WarMap 不负责录音、语音转写、格式转换或说话人映射。
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
系统在每月 1 日按 Company Day 自动生成、经 CEO 与 DRI 协商后签发的单月公司结果、战场结果和普通待办集合，是当月目标的唯一来源。待办不是 Mission，不在 WarMap 中跟踪执行状态。
_Avoid_: 通知卡草稿、前端本地计划、Mission 对象

**Candidate Material**:
Agent 生成并可由系统自动保存的研究、预审或会后草稿；它不是已生效的组织事实。ResearchDoc 不被对话局部修改；只有 pending Issue 可由 CEO 显式重跑预研并整份替换当前版本。
_Avoid_: 自动决策、已确认结论、对话拼接的研究文档

**Research Override**:
CEO 在预研未完成或失败时，经过二次确认仍直接决定 Issue 的明确选择。决定必须记录当时的预研状态，不能表述为基于完整预研。
_Avoid_: 静默绕过、伪造已完成预研

**Organization Fact**:
经 CEO 确定性确认后生效的决定、分派、CEO 判断、复议锚点或月度计划。
_Avoid_: Agent 候选、对话意见、卡片引用

**Card**:
后端业务对象面向 CEO 界面的类型化投影；它携带展示数据、导航、对话范围和当前允许的动作。
_Avoid_: 通用页面 DSL、独立业务对象

**Action**:
后端提供、由 CEO 明确触发的确定性命令。Action 可以改变组织事实，对话和 Agent 不能替代它。
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
负责提供议题、材料、反馈或承接行动的人；MVP 中不进入 CEO WarMap 主界面，通过导入和导出边界与 WarMap 交换内容。
_Avoid_: WarMap 共同决策用户

**DRI Handoff**:
WarMap 向外部 DRI 流程导出的补充请求或已确认行动。没有真实渠道回执时只能称为待外发，不能称为已送达或已分派。
_Avoid_: WarMap 内部任务、伪造的发送成功
