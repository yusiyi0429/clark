# 概念版 DRI 工作面「执行事项」只读调研

调研范围：概念版 `C:\Users\10021\Desktop\clark\clark-main`（下称「概念/」）；MVP `C:\Users\10021\Desktop\clark\Tianshu-MVP`（下称「MVP/」）。
路径均从上述仓库根目录起算；函数、组件或类型名紧随路径给出。
判断基于当前文件内容；未运行页面、服务或测试，也未更改两个仓库的代码和 Git 状态。
术语：概念版 `Mission` 类型在 DRI 代码里兼容旧名，实际指个人卡内的「个人任务」；MVP `missions` 是战役，两者不能同名直接映射。

## 1. DRI 工作面整体

- 当前 `/dri` 入口是 `概念/src/app/dri/page.tsx` 的 `DriHomePage`，渲染 `DriWorkSurface` 并在此页引入 `ts-design/styles.css`。
- 外壳是 `概念/src/app/dri/layout.tsx` 的 `DriLayout`，含 `LiveData`，不再额外叠加全局页头或 `<main>`。
- 主工作区是 `概念/src/components/dri/workspace.tsx` 的 `DriWorkSurface`、`Surface`，主题为 `TianshuTheme`，布局和转场由 `ts-design` 的
  `WorkspaceShell`、`runWorkspaceTransition` 管理。
- 首屏水合前只显示「正在打开本月工作面」，因为本机时钟和 localStorage 无法在服务端算一致；见 `概念/src/components/dri/workspace.tsx` 的
  `DriWorkSurface`、`概念/src/components/dri/store.ts` 的 `useHydrated`。
- 工作面左栏为通知；`Surface` 传入 `NoticeGroups` 作为 `WorkspaceShell.sidebar`，固定组序由 `概念/src/components/dri/rules.ts` 的
  `NOTICE_GROUPS`、`groupedNotices` 决定。
- 通知三组是「会议安排 → 本月 Mission Card → 推动」；见 `概念/src/components/dri/rules.ts` 的 `NOTICE_GROUPS`、`概念/src/components/dri/surface.tsx` 的
  `NoticeGroups`。
- 宽屏正文的实际 JSX 顺序是参与战场 `ProjectSection` →「本月任务」`MonthlySummary` → 执行事项 `TaskSection`；见 `概念/src/components/dri/workspace.tsx` 的
  `Surface`。
- `TaskSection` 在首页正文最后一段，标题工具栏右侧已有 `Plus` 图标和「开启 执行事项」按钮；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`。
- 战场卡能展开目标及本月进展，切换按战役、按人、甘特图；见 `概念/src/components/dri/surface.tsx` 的 `ProjectSection`、`BattlefieldGoals`、`BattlefieldCoordination`、`ProgressViews`。
- 「本月任务」卡给出负责的个人任务数、执行中数、完成数、最多四条个人任务及进入个人卡入口；见 `概念/src/components/dri/surface.tsx` 的 `MonthlySummary`。
- 详情在同一工作区通过本地 `detail` 状态打开，并非每件执行事项一条 URL；返回、Escape、源卡转场由 `概念/src/components/dri/workspace.tsx` 的 `Surface` 与 `WorkspaceShell`
  完成。
- 当前 `/dri` 不再用 `概念/src/app/_views/dri-home-view.tsx` 的 `DriHomeView`；那是旧的「本期 OM／派给我的研究／我上报的信号」入口组件，不代表这套工作面。
- 个人卡另有直达入口 `概念/src/app/dri/mission-cards/page.tsx` 的 `Page`，实际个人卡也可由 `Surface` 打开 `MissionCardWorkspace`，见
  `概念/src/components/mission-cards/workspace.tsx`。
- 当前宽屏布局：通知在左，右为正文工作区；二级页左为阅读内容，右为 `ConversationColumn`，见 `概念/src/components/dri/workspace.tsx` 的
  `Surface`、`概念/src/components/dri/dri.module.css` 的 `.root`、`.detailReading`。
- ≤1000px 当前实现把首页通知栏放上方、限高 40dvh，正文放下方；见 `概念/src/components/dri/dri.module.css` 的 `@media (max-width:1000px)`。
- ≤690px 执行事项卡改为单列，首页输入条贴近底部安全区；见 `概念/src/components/dri/home.module.css` 的 `.taskGrid`、`概念/src/components/dri/dri.module.css`
  的手机媒体查询。
- ≤759px 详情阅读区铺满宽度，右列对话作为浮层；频道开关负责打开对话，见 `概念/src/components/dri/dri.module.css` 的 `.ts-detail`、`概念/src/components/conversation/column.tsx` 的 `ConversationColumn`。
- **实现与最新 SSOT 不一致**：`概念/docs/product/tianshu-ssot.md` 的 DRI-01 第 212–214 行要求手机单滚动面「通知 → 执行事项 → 我的本月卡 → 战场 → 雷达 → 菜单」，
  且宽屏小组件与执行事项在右；当前 `Surface` 正文仍是「战场 → 本月任务 → 执行事项」，无个人雷达小组件。
- 搬运时应区分当前概念版屏幕与最新文字规则，不能把目前手机顺序说成已符合 SSOT；证据仍是 `概念/src/components/dri/workspace.tsx` 的 `Surface` 和
  `概念/docs/product/tianshu-ssot.md` 的 DRI-01。

## 2. 执行事项的数据模型

- 核心类型是 `概念/src/components/dri/model.ts` 的 `Task`、`TaskBelonging`、`TaskStatus`、`World`；`TaskId` 是字符串。
- `Task` 字段：`id`、`belongsTo`、`title`、`status`、`driverId`、`connections`、`dod`、可选 `source`、`dueAt`、`startAt`、`createdAt`；
  见 `概念/src/components/dri/model.ts` 的 `Task`。
- 状态三档 `todo/doing/done`，显示为「未启动／进行中／完成」；`needs_decision` 是个人任务的第四档，不允许用于执行事项；见 `概念/src/components/dri/model.ts` 的
  `TaskStatus`、`TASK_STATUS_ORDER`、`WORK_STATUS`。
- 状态没有强制的单向流转图；推进人可以在三档中直接选任何一档，最新自报覆盖演示基值；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`、`概念/src/components/dri/store.ts` 的
  `driActions.reportStatus`、`概念/src/components/dri/rules.ts` 的 `statusOf`。
- 概念版执行事项没有 `returned` 状态或「退回执行事项」动作；交接包可「拒绝」，是另一对象；见 `概念/src/components/dri/model.ts` 的
  `TaskStatus`、`概念/src/components/dri/panes.tsx` 的 `HandoffPane`。
- 日期：`dueAt` 截止、`startAt` 可选计划开始、`createdAt` 本机开启日；CEO 指派的截止取承接时选的回传日期；见 `概念/src/components/dri/model.ts` 的
  `Task`、`概念/src/components/dri/rules.ts` 的 `taskDueAt`。
- `TaskBelonging` 三态：`mission` 指旧名个人任务 id；`personal` 指项目、仅兼容历史本机记录；`ceo_assignment` 指交接包 id；
  见 `概念/src/components/dri/model.ts` 的 `TaskBelonging`。
- 新建普通事项必须单选一个个人任务，不能无归属；`ceo_assignment` 只有指定人承接交接包后才入清单；见 `概念/src/components/dri/store.ts` 的
  `driActions.createTask`、`概念/src/components/dri/rules.ts` 的 `tasksFor`。
- 所属战场不是 `Task.projectId` 字段，而由归属个人任务或交接包推导；见 `概念/src/components/dri/model.ts` 的 `projectOfTask`。
- 负责人是 `driverId`，协作成员是 `connections`（「主要连接」），事项成员为两者去重；见 `概念/src/components/dri/model.ts` 的 `Task`、`taskMembersOf`。
- 协作者关系可由直接邀请或接受预置同事邀请补入；不改变负责人或决定权；见 `概念/src/components/dri/store.ts` 的 `driActions.addCollaborators`、`worldWithDemo`。
- `source` 目前只区分 `manual`、`ceo_assignment`；会议与事项可通过 `MeetingEntry.taskId` 关联，但执行事项本身没有会议来源字段、会议原话、外部工具来源；
  见 `概念/src/components/dri/model.ts` 的 `Task`、`MeetingEntry`。
- 未接下的 CEO 指派任务虽预置在 `TASKS`，`tasksFor` 会将其挡在个人清单外；见 `概念/src/components/dri/model.ts` 的 `TASKS`、`概念/src/components/dri/rules.ts` 的
  `tasksFor`。
- 执行事项之间**没有前置/后置 id、依赖边、顺序号或步骤组 id**；`Mission.dependencies` 是个人任务的自由文本，不是执行事项依赖；见 `概念/src/components/dri/model.ts` 的
  `Task`、`Mission`。
- `World.moves` 的 `TaskMove` 是预置的同事动作/等待某人回话的演示通知材料，不是完整事项进展日志；见 `概念/src/components/dri/model.ts` 的 `TaskMove`、`World`。
- 执行事项的自报状态只在 `DemoRecord.statuses[taskId]` 保留最新一条 `{status,by,at}`，判断在 `judgments`，他人私有批注在 `notes`；
  见 `概念/src/components/dri/rules.ts` 的 `DemoRecord`。
- 对话记录另在 `DriDemo.chats`，草稿在 `drafts`，手建事项在 `customTasks`，协作者增量在 `taskMembers`；见 `概念/src/components/dri/store.ts` 的 `DriDemo`。
  
- 资料来源分层：个人任务定义来自 `概念/docs/product/tianshu-ssot.data.json`；`概念/src/components/dri/model.ts` 的 `MISSIONS` 转换这些资料；
  `TASKS` 是人工拆出的演示事项，`buildHistoricalTestWorld` 明注「不从 Mission 自动生成」。
- 动态演示数据存浏览器 `localStorage` 的 `tianshu-dri-worksurface-ssot-v2`；`readDemo`、`publish`、`useDriDemo` 与 `worldWithDemo` 负责读取、落盘、合并；
  见 `概念/src/components/dri/store.ts`。
- 月初个人卡另有自己的本机 store；见 `概念/src/components/mission-cards/store.ts` 的 `useFormation`，不能把它当作执行事项的后端事实源。
- 目前没有外部 Codex 等工具的进展字段、事件表、同步入口；可用的仅是手动 `reportStatus` 与本机对话；见 `概念/src/components/dri/model.ts` 的
  `Task`、`概念/src/components/dri/store.ts` 的 `driActions`。

## 3. 执行事项的展示

- 首页以 `TaskSection` 平铺卡片，不画按个人任务分组的栏；数据先由 `taskGroupsFor` 聚合，再由 `tasksByDue` 打平排序；见 `概念/src/components/dri/surface.tsx`、`概念/src/components/dri/rules.ts`。
- 只有本人 `driverId` 的事项进入「我的执行事项」；作为他人 `connections` 不自动混入；见 `概念/src/components/dri/rules.ts` 的 `tasksFor`。
- 排序是有截止的从近到远，无截止的在后并保留原顺序；CEO 指派不固定置顶；见 `概念/src/components/dri/rules.ts` 的 `byDue`、`taskGroupsFor`、`tasksByDue`。
- `taskGroupsFor` 内部分组有个人任务、历史待关联、CEO 指派；首页卡片只借分组读归属标签，月度页才按个人任务列出；见 `概念/src/components/dri/rules.ts` 的
  `taskGroupsFor`、`概念/src/components/dri/monthly.tsx` 的 `MonthlyPane`。
- 首页卡可见标题、计划开始提示（仅 `todo` 且有 `startAt`）、所属个人任务链接，或「待关联 个人任务」「CEO 指派」标签；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`。
- 首页卡若有关联且未过时的会议，会显示「会议已安排」、时间、会名并可进会议页；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`、`概念/src/components/dri/workspace.tsx` 的 `meetingOpen`。
- 首页卡有主要连接时显示「协作 · 人名」；卡顶可加入对话引用；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`、`ReferenceButton`。
- **首页卡当前不显示任务状态标签、截止日文本或完成定义**，状态和截止主要在详情、月度行；这与「在手机首页改状态」的最新 SSOT 存在实现差距；见 `概念/src/components/dri/surface.tsx` 的
  `TaskSection`、`概念/src/components/dri/monthly.tsx` 的 `LinkedTaskRows`。
- 月度详情 `MonthlyPane` 按本人负责的个人任务列条目及其执行事项，并另列参与的个人任务/CEO 调研/待关联组；`LinkedTaskRows` 展示状态控件、截止、参与人；
  见 `概念/src/components/dri/monthly.tsx`。
- 个人任务详情底部「个人任务 下的 执行事项」也用 `LinkedTaskRows`；见 `概念/src/components/dri/panes.tsx` 的 `MissionPane`。
- 独立事项目前只有 CEO 指派这一真实例外，卡标「CEO 指派」；历史 `personal` 标「待关联 个人任务」，不是产品化的任意独立事项；见 `概念/src/components/dri/surface.tsx` 的
  `TaskSection`、`概念/src/components/dri/model.ts` 的 `TaskBelonging`。
- 执行事项之间没有先后连线、依赖箭头、步骤树，也没有执行事项甘特图；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`、`概念/src/components/dri/personal-task-gantt.tsx` 的 `PersonalTaskGantt`。
- `PersonalTaskGantt` 展示的是战场下**个人任务里程碑**，不能当成已经实现的执行事项甘特图；见 `概念/src/components/dri/personal-task-gantt.tsx`。
- 空状态：首页写「暂无 执行事项。新的指派会显示在通知栏。」；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`。
- 空状态：某个人任务下写「还没有关联的 执行事项。可以从工作面开启一件事。」；见 `概念/src/components/dri/monthly.tsx` 的 `LinkedTaskRows`。
- 找不到详情对象时显示错误状态，不静默空白；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`。

## 4. 新建执行事项

- 入口为首页执行事项工具栏的 `Plus` +「开启 执行事项」，调用 `onCreate`；见 `概念/src/components/dri/surface.tsx` 的 `TaskSection`。
- `概念/src/components/dri/workspace.tsx` 的 `Surface.open` 将其打开为 `create-task:new` 详情态；`renderDetail` 渲染 `CreateTaskPane`，成功后直接打开新事项
  `TaskPane`。
- 表单 `概念/src/components/dri/monthly.tsx` 的 `CreateTaskPane` 含标题、所属个人任务、可选计划开始日期、可选截止日期、可选完成定义。
- 表单先要求标题非空和已选个人任务，提交失败显示「请填写简短标题并选择所属 个人任务。」；见 `概念/src/components/dri/monthly.tsx` 的 `CreateTaskPane`。
- store 再校验标题、人物、战场存在、创建者参与该战场、所选个人任务属于战场、日期字符串有效；见 `概念/src/components/dri/store.ts` 的 `driActions.createTask`。
- 下拉框当前列 `world.missions` 全部个人任务，参与资格只在提交时拦；因此不可参与项可能可选但提交失败，迁入 MVP 时应以 API 权限过滤/校验；见 `概念/src/components/dri/monthly.tsx` 的
  `CreateTaskPane`、`概念/src/components/dri/store.ts` 的 `createTask`。
- 目前没有开始日 ≤ 截止日、拆分步骤必须在当月内等跨字段校验；`validDay` 仅检验单个日期；见 `概念/src/components/dri/store.ts` 的 `driActions.createTask`。
- 推进人默认创建者，表单没有负责人选择，不能创建时指派给别人；见 `概念/src/components/dri/store.ts` 的 `driActions.createTask`、`概念/src/components/dri/monthly.tsx` 的
  `CreateTaskPane`。
- 不能在新建表单直接选协作者，创建后从详情「邀请协作」进入 `CollaboratorsDialog`；见 `概念/src/components/dri/panes.tsx` 的
  `TaskPane`、`概念/src/components/dri/monthly.tsx` 的 `CollaboratorsDialog`。
- 不能新建无归属事项，不能通过普通新建模拟 CEO 指派；CEO 指派应走交接包承接；见 `概念/src/components/dri/store.ts` 的 `createTask`、`acceptHandoff`。
- 用户要求的「CEO 看到信号直接安排调查」属新增来源和指派流程，当前 `CreateTaskPane` 没有信号来源、受派人选择或独立事项归属；证据同上。

## 5. 执行事项详情

- `概念/src/components/dri/workspace.tsx` 的 `detailFrame` 用事项标题作详情页头，眉题为「执行事项 · 内容与对话」；`renderDetail` 交给 `TaskPane`。
- `概念/src/components/dri/panes.tsx` 的 `TaskPane` 左侧依次放所属个人任务/CEO 调研/历史待关联标签、状态、战场、推进人与主要连接、截止、参与人、完成定义、判断、报进度、方案与待拍板方案。
- 所属个人任务在详情是横向跳转链接；CEO 调研则显示回传日期标签；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`、`概念/src/components/dri/rules.ts` 的 `taskView`。
  
- 只有推进人写的「这件事的判断」作为共享判断；其他人写「我的批注」且只属于本人；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`、`概念/src/components/dri/store.ts` 的
  `saveJudgment`、`saveNote`。
- 只有推进人能自报未启动/进行中/完成；别人只能看状态，不能替其推进；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`、`概念/src/components/dri/store.ts` 的
  `reportStatus`。
- 详情没有执行事项「退回」按钮；概念版的「拒绝」是 CEO 交接包处理，不是已入清单事项的状态；见 `概念/src/components/dri/panes.tsx` 的 `TaskPane`、`HandoffPane`。
- 协作入口 `TaskPane` 的「邀请协作」打开 `CollaboratorsDialog`；选择同事后 `addCollaborators` 将其加到 `connections`，不转移推进责任；
  见 `概念/src/components/dri/monthly.tsx`、`概念/src/components/dri/store.ts`。
- `概念/src/components/dri/group-members.ts` 的 `groupMembersOf`、`groupRoster` 按对象算事项群组成员及名单；
  执行事项成员来自 `taskMembersOf`，右列页头人数与正文「成员可见」共用这份关系。
- `概念/src/components/dri/workspace.tsx` 的 `Surface` 把 `ConversationColumn` 放在详情右列，频道为「我的天枢」和「事项群组」，输入条复用 `ConversationComposer`。
  
- `概念/src/components/dri/conversation.tsx` 的 `DriConversationBody` 展示对话、引用、正在思考、空态「暂无消息」及可见性说明；
  群组开场来自 `groupOpenings`，见 `概念/src/components/dri/group-opening.ts`。
- 「我的天枢」通过 `askAgent` 带对象资料和最近对话问实时模型，只读回答；群组发言只存在本机，同事消息通过演示控制台 `receive` 模拟，未接真实消息服务；
  见 `概念/src/components/dri/workspace.tsx` 的 `Surface.send`、`概念/src/components/dri/store.ts` 的 `driActions.say`、`receive`。
- 群组消息与个人私聊按对象、频道、人员区分，未读在右列实际可见时才清；见 `概念/src/components/dri/store.ts` 的 `chatKey`、`messagesOf`、`unreadOf`、`driActions.markChannelSeen`。
- CEO 调研交接详情 `HandoffPane` 显示为什么现在、brief、CEO 与 Agent 摘录、议题材料、依据、未知和来源；见 `概念/src/components/dri/panes.tsx`。
- 只有交接包指定人能接或拒；接下必须选择回传日，拒绝必须填非空原因，重复处理被 store 拦；见 `概念/src/components/dri/panes.tsx` 的
  `HandoffPane`、`概念/src/components/dri/rules.ts` 的 `handoffReply`、`概念/src/components/dri/store.ts` 的
  `acceptHandoff`、`declineHandoff`。
- 交接回传日当前是「3/7/14 天后」单选候选；`handoffReply.accept` 只校验日期形状，概念版注释建议真实产品改用日期选择器；见 `概念/src/components/dri/rules.ts` 的
  `handoffDueOptions`。
- 通知卡也能直接「接下／拒绝」，与详情调用同一校验；成功后新事项卡闪亮并滚入视野，见 `概念/src/components/dri/notice-actions.tsx` 的
  `PushHandle`、`概念/src/components/dri/notice-receipt.ts` 的 `showCardReceipt`。
- 承接后该 CEO 事项入个人清单并按回传日期排，不赋予项目决定权；见 `概念/src/components/dri/rules.ts` 的 `tasksFor`、`taskDueAt`，以及 `概念/src/components/dri/store.ts`
  的 `acceptHandoff`。

## 6. 甘特图和拆分

- 唯一名为甘特图的核心实现是 `概念/src/components/dri/personal-task-gantt.tsx` 的 `PersonalTaskGantt`，样式在同名 `.module.css`。
- 它由 `概念/src/components/dri/surface.tsx` 的 `ProgressViews` 作为「按战役／按人／甘特图」第三视图调用，默认视图为按战役。
- DRI 首页战场卡、DRI 战场详情、CEO 战场进展调用同一套 `ProgressViews`/`PersonalTaskGantt`；战役分组由 `campaignGroups`、`campaignRollup` 提供，见
  `概念/src/components/dri/surface.tsx`、`campaign-progress.ts`。
- 图的行是**个人任务**而非执行事项：按战役分组，未关联战役最后一组，组头有负责人、验收数和本组跨度；见 `概念/src/components/dri/personal-task-gantt.tsx` 的
  `GanttGroup`、`PersonalTaskGantt`。
- 一行一个个人任务：左栏名称、负责人、状态、验收数；右栏逐日、周末底色、今天竖线、计划跨度条、已核对段和三态里程碑点；见 `PersonalTaskGantt`、`Label`。
- 由于个人任务无真实起止，条从首个里程碑到最后一个；标签开头有日期范围则取范围首日，绝不从正文猜日期；见 `概念/src/components/dri/personal-task-gantt.tsx` 的 `startOf`、`spanOf`。
- 本月目标里程碑作为贯穿全图的虚线，表头标相应日；来源是 `概念/src/components/dri/surface.tsx` 的 `monthlyCheckpoints` 和
  `概念/src/components/dri/milestone-store.ts` 的 `milestonesForProject`。
- 图上的悬浮卡吸附最近里程碑；鼠标进一行即显示、离开缓 120ms，键盘左右切换、Escape 关闭，触屏点开点外关闭；见 `概念/src/components/dri/personal-task-gantt.tsx` 的
  `showAt`、`nearest`、`onKey`。
- 缺本月里程碑日期的一行明确写「本月没有里程碑日期」；核对进度与战役关联若为演示则图例注明；见 `PersonalTaskGantt`。
- 另一条时间轴是战场六个月/本月目标的 `LtcoTimeline` 与里程碑弹层，见 `概念/src/components/dri/ltco-timeline.tsx` 的 `LtcoTimeline`、`MilestoneNode` 和同名 CSS。
  
- 本月目标「达成路径」是阶段节点与弹层，不是事项步骤编辑器；见 `概念/src/components/dri/outcome-progress.tsx` 的 `OutcomeProgressPanel`、`StageNode`，计算来自
  `outcome-path.ts` 的 `outcomeProgress`。
- 个人任务详情 `MissionPane` 只列原有关键里程碑；个人卡 `MissionCardWorkspace`／`CardDocument` 只有原件与个人任务字段、意见和里程碑列表；
  见 `概念/src/components/dri/panes.tsx`、`概念/src/components/mission-cards/card-document.tsx`。
- **没有**「在自己的本月卡上画甘特图、把个人任务按日期拆为步骤、自动生成执行事项」功能；`CardDocument` 无此入口，`buildHistoricalTestWorld` 明确演示任务是人为拆分，`createTask` 仅单条提交。
- **没有**执行事项先后依赖可视化，也没有执行事项时间线；SSOT DRI-01 明确执行事项甘特图要等执行事项起止日期来源，见 `概念/docs/product/tianshu-ssot.md` 第 210 行。
- 拆分交互可直接复用 `PersonalTaskGantt` 的逐日网格/行首/里程碑点/悬浮卡及其键盘、触屏行为；需增加编辑模式、步骤区间、依赖边和一次提交，证据组件为
  `概念/src/components/dri/personal-task-gantt.tsx`。
- 本月边界及阶段参照可用 `OutcomeProgressPanel` 的阶段节点与 `LtcoTimeline` 的里程碑弹层；这些现有组件是只读展示，不能声称已有自动拆分；
  见 `概念/src/components/dri/outcome-progress.tsx`、`ltco-timeline.tsx`。

## 7. 月初 Mission 制定流程与工作台布局说明

- 概念版**没有已实现的首次登录 onboarding 教程、工作台示意图或专门布局教学动画**；`概念/docs/product/tianshu-ssot.md` 的 C-10 第 142–162 行只规定未来引导，明确「概念版未实现」。
- C-10 规定未来引导只讲本月相关战场/个人卡状态、雷达、声纹与下一步；「每月制定规则不在引导里讲，也不放首页示意图」；见 `概念/docs/product/tianshu-ssot.md` 第 144–158 行。
- 实际的月初制定说明在个人卡上方「本轮」折叠行及展开内容：五步进度、当前等待方、拍板目标、整理草稿、统一开放 48 小时、逐条处理、确认；见 `概念/src/components/mission-cards/round-panel.tsx` 的
  `roundPanelModel`、`RoundPanelBody`、`RoundLine`。
- `RoundPanelBody` 有短说明句：「先审视并拍板，再整理个人卡草稿」「全战场同一时刻开始 48 小时」等；这是就地说明，不是独立教程；见 `概念/src/components/mission-cards/round-panel.tsx`。
  
- DRI 通知栏的 `MissionCardGroup` 以倒计时、状态和各人卡行提示当前轮次入口；见 `概念/src/components/dri/mission-card-group.tsx`、`概念/src/components/dri/mission-card-notice.ts`。
- `概念/src/components/demo/console.tsx` 的 `DemoConsole` 有总说明「不属于产品界面」，每个动作有模拟内容与 MVP 触发方式；不是给正式用户的教程。
- DRI 工作面登记的演示项目包括换人物视角、会议时间拨动、清本机记录及会议 Co-Agent 场景；见 `概念/src/components/dri/workspace.tsx` 的
  `useDemoSection`、`概念/src/components/dri/meeting-scenes.ts`。
- 个人卡页的控制台可拨演示时钟；见 `概念/src/components/mission-cards/workspace.tsx` 的 `useDemoSection` 与 `概念/docs/product/tianshu-ssot.md` 的 C-09。
  
- 执行事项空态、对话空态及表单说明分别在 `TaskSection`、`LinkedTaskRows`、`DriConversationBody`、`CreateTaskPane`，均为上下文提示，不构成流程教程。
- 界面有转场和局部动效（`WorkspaceShell` 源卡转场、通知回执、群组材料载入），但没有解释工作台布局的说明性插图/动画；见 `概念/src/components/dri/workspace.tsx`、`notice-actions.module.css`、`task-artifacts.module.css`。

## 8. 搬运清单

- 核心首页卡：搬 `概念/src/components/dri/surface.tsx` 的 `TaskSection`、`Status`、`ReferenceButton` 相关实现，及 `home.module.css` 的
  `.tasks/.taskGrid/.taskCard`、`dri.module.css` 的工作区布局规则。
- 排序/归属：搬 `概念/src/components/dri/rules.ts` 的 `tasksFor`、`taskDueAt`、`taskGroupsFor`、`tasksByDue`、`taskView` 中与事项有关的纯规则；
  替换输入为 MVP API DTO，不整体带演示通知规则。
- 新建/月度行/邀请：搬 `概念/src/components/dri/monthly.tsx` 的 `CreateTaskPane`、`LinkedTaskRows`、`CollaboratorsDialog`，及 `monthly.module.css`；
  原 `driActions` 调用要换 API mutation。
- 详情：搬 `概念/src/components/dri/panes.tsx` 的 `TaskPane`，及 `dri.module.css` 的 `.pane*`、`.detailReading`；
  `ProposeBlock` 如需完整判断/方案能力，还需搬其依赖的项目授权规则。
- 工作区调度：参考/搬 `概念/src/components/dri/workspace.tsx` 的 `Surface.open`、`renderDetail`、`detailFrame`、`ConversationColumn` 接线；
  MVP 已有 `MemberWorkspace` 和 `WorkspaceFrame`，须选择统一宿主，避免同时挂两个工作区外壳。
- 对话：搬 `概念/src/components/dri/conversation.tsx` 的 `DriConversationBody`、`group-members.ts` 的
  `groupMembersOf/groupRoster`、`group-opening.ts` 的 `groupOpenings`；MVP 已有 `/api/threads/task/:id`，应用层应接它而非复制本机 `chats`。
- 对话共享件：`概念/src/components/conversation/column.tsx`、`use-column-mode.ts`、`seen.ts`、`agent-reply.ts`，
  `概念/src/components/ceo-warmap/conversation-composer.tsx`、`conversation-transcript.tsx` 及相关 CSS，负责右列、频道、输入、未读和模型回答。
- 通知/承接：要保留 CEO 指派闭环，搬 `概念/src/components/dri/notice-actions.tsx`、`notice-receipt.ts`、`panes.tsx` 的 `HandoffPane`、`rules.ts` 的
  `handoffReply/handoffDueOptions`、`group-opening.ts` 对应逻辑及 `notice-actions.module.css`。
- 甘特展示：搬 `概念/src/components/dri/personal-task-gantt.tsx`、`personal-task-gantt.module.css`，以及 `surface.tsx` 的
  `ProgressViews/campaignGroups/monthlyCheckpoints`；战役关联依赖 `campaign-progress.ts`、里程碑依赖 `milestone-store.ts`。
- 相邻时间线与阶段：视设计选择搬 `概念/src/components/dri/ltco-timeline.tsx`、`ltco-timeline.module.css`、`outcome-progress.tsx`、`outcome-progress.module.css`、`outcome-path.ts`；它们提供只读时间点与阶段视觉语言。
- 个人卡入口/内容：如在卡上增加拆分，沿用 `概念/src/components/mission-cards/workspace.tsx`、`card-document.tsx`、`round-panel.tsx` 及各自 CSS 的布局和页签；
  MVP 已有 `MissionCardScreen`，应把拆分入口接在其个人任务条目，不复制概念版本机制定 store。
- 设计系统：`概念/src/app/dri/page.tsx` 引 `ts-design/styles.css`，`workspace.tsx` 使用 `TianshuTheme/WorkspaceShell/runWorkspaceTransition`；
  控件主要来自 `ts-design/primitives`，少量 `lucide-react`，不能只粘 JSX 而不带主题作用域。
- 设计 token：`概念/src/components/dri/dri.module.css` 明确使用 `--ts-*` 语义变量；`home.module.css`、`monthly.module.css`、`personal-task-gantt.module.css` 依赖 `--ts-surface`、`--ts-reading-surface`、`--ts-bg`、`--ts-border`、`--ts-text`、`--ts-text-muted`、`--ts-info-*` 及字号/圆角变量。
- 其他样式依赖：事项通知关联 `概念/src/components/ceo-warmap/notifications.module.css`、`概念/src/components/dri/notice-actions.module.css`；
  右列关联 `概念/src/components/conversation/column.module.css`、Co-Agent 胶囊样式；需按导入关系一起核对。
- 数据模型适配：`概念/src/components/dri/model.ts` 的 `Task`、`TaskBelonging`、`PEOPLE`、`SSOT_PERSON`、`buildWorld` 是演示对象；
  MVP 应用其交互语义，人物、个人任务和事项从 API 获取，不能照搬固定 2026-09 种子。
- `概念/src/components/dri/store.ts` 的 `DRI_STORAGE/readDemo/worldWithDemo/driActions` 是浏览器单机事实源；
  建项、改状态、邀请、交接、判断、批注、群聊、未读与通知都要改为服务端读写。
- `概念/src/components/dri/mission-demo.ts`、`mission-snapshot.ts`、`test-world.ts` 和 `概念/docs/product/tianshu-ssot.data.json`
  提供演示/静态事实，搬 UI 时不能把演示成功证据当 MVP 实际完成记录。
- `概念/src/components/dri/personal-task-gantt.tsx` 现消费 `MissionRow.mission.milestones`；
  MVP `missionCards` 中有个人任务 id/里程碑，但须另建日期化执行事项/拆分 API，不能直接把战役 `missions` 接到这里。
- 只搬可直接复用的展示与交互代码仍需调整 imports、类型与数据边界；`MVP/apps/web/src/components/member/MemberTasks.tsx`、`MVP/apps/web/src/styles/member-tasks.module.css` 可作为替换定位，`MemberWorkspace`、`useMemberHome` 是数据接线位置。

## 9. 与 MVP 后端的差距

- MVP 现状：`MVP/apps/api/migrations/026_tasks_and_notifications.sql` 的 `tasks` 表有 `id/version/title/done_definition/judgment/due_date/status/owner_id/created_by/return_reason/origin_signal_id/origin_meeting_id/origin_item_id/source_quote/created_at/updated_at`。
- `MVP/apps/api/src/tasks.ts` 的 `dispatchMeetingTodo` 目前只由会后条目创建任务，创建 owner 成员和通知；`deleteDispatchedTask` 允许主持人侧在未开始时撤回。
- `MVP/apps/api/src/routes/me.ts` 的 `registerMeRoutes` 在执行事项方面仅提供 `/api/me/home`、`PATCH /api/me/tasks/:id`、`POST /api/me/tasks/:id/return`；没有成员新建或事项详情 CRUD 路由。
- `MVP/packages/contracts/src/tasks.ts` 的 `TaskView` 只暴露 id/version/title/status/dueDate/returnReason/meeting
  origin/createdAt/updatedAt；不暴露表中已有的 `done_definition`、`judgment` 或 owner id。
- MVP 状态是 `not_started/in_progress/done/returned`；`PatchMyTaskRequest` 可改前三档，`ReturnMyTaskRequest` 记原因并通知会议主持人；
  概念版只有 `todo/doing/done`，适配时要明确对应及 `returned` 的界面处理。
- MVP 状态修改用版本乐观锁，409 带最新事项；概念版本机 `reportStatus` 是覆盖最新值；见 `MVP/apps/api/src/tasks.ts` 的 `mutateMyTask`、`updateMyTaskStatus` 与
  `概念/src/components/dri/store.ts` 的 `reportStatus`。
- 缺普通手建接口：表 `created_by` 可容纳来源文字，但 `dispatchMeetingTodo` 是唯一 `INSERT INTO tasks` 的实现；概念 `CreateTaskPane/createTask` 暂无可接的 POST；
  见 `MVP/apps/api/src/tasks.ts`、`routes/me.ts`。
- 缺个人任务归属：`tasks` 无 `personal_mission_card_id`/个人任务 id，契约无对应字段；而 MVP 个人卡条目已有 `missionId`，见
  `MVP/packages/contracts/src/missionCards.ts` 的 `PersonalMissionCardMission`、`MVP/apps/api/src/personalMissionCards.ts` 的
  `documentMissions`。
- `MVP/apps/api/src/memberWork.ts` 的 `readMemberWork` 返回的是战役 `missions` 与个人卡摘要，不把个人卡条目和任务建立关系；
  概念 `TaskBelonging.missionId` 不可直接映射 MVP 战役 id。
- 缺独立事项明确归属语义：现有任务可以没有会议来源，但没有新建路由、来源类型或独立事项/信号派单产品契约；`origin_signal_id` 只是表中预留且未见业务写入；
  见 `MVP/apps/api/migrations/026_tasks_and_notifications.sql`、`MVP/apps/api/src/tasks.ts`。
- 缺 CEO 指派交接包：表与 `TaskOrigin` 只产品化会议来源；没有 handoff id、接下/拒绝、回传日与原因、承接后创建责任的 API；见 `MVP/packages/contracts/src/tasks.ts`、`MVP/apps/api/src/routes/me.ts`。
- 缺计划开始日：任务表/`TaskView` 只有 `due_date/dueDate`，没有 `start_at/startDate`；不能直接支撑用户要求的月内步骤区间；
  见 `MVP/apps/api/migrations/026_tasks_and_notifications.sql`、`MVP/packages/contracts/src/tasks.ts`。
- 缺执行事项依赖与拆分批次：无前驱/后继边、步骤排序、父个人任务和批量生成幂等键；见 `MVP/apps/api/migrations/026_tasks_and_notifications.sql` 的 `tasks`、`task_members`。
- 缺完成定义/判断接口：表里有 `done_definition`、`judgment`，但 `TaskView` 不返回，`tasks.ts` 不写，`routes/me.ts` 不提供更新；
  概念 `TaskPane` 的相应区域接 API 前要补契约与权限。
- 缺负责人/协作者视图与邀请接口：`task_members` 有 owner/collaborator、added/left 列，但会后仅插 owner；`TaskView` 不返回成员，任务路由没有加人/退群；
  见 `MVP/apps/api/src/tasks.ts` 的 `dispatchMeetingTodo`、`MVP/packages/contracts/src/tasks.ts`。
- 群组基础设施**已有**：`MVP/apps/api/migrations/024_conversation_owner_and_threads.sql` 的 `thread_members/messages/reads` 支持 `task`；
  `MVP/packages/contracts/src/threads.ts` 的 `ThreadObjectType` 包含 task。
- 群组读写 API**已有**：`MVP/apps/api/src/routes/threads.ts` 的 `registerThreadRoutes` 提供查询、增量轮询、发消息、已读；
  `MVP/apps/api/src/threads.ts` 的 `isActiveMember` 要求 `thread_members` 成员。
- 但会后建任务只插 `task_members`，没插 `thread_members`，因此任务群组即使类型/路由存在也不能直接由 owner 打开；需接通成员镜像/生命周期与 Co-Agent 开场；
  见 `MVP/apps/api/src/tasks.ts`、`MVP/apps/api/src/threads.ts`。
- 任务进展只保留最新 `status/version/updated_at`，没有状态事件流、推进人判断的版本历史、协作者批注或 `TaskMove.waitsOn` 等待关系；
  见 `MVP/apps/api/migrations/026_tasks_and_notifications.sql`。
- 无 Codex 等外部工具进展的关联 id、回调、事件去重、映射到任务状态/进度的契约；对照 `MVP/packages/contracts/src/tasks.ts`、`MVP/apps/api/src/tasks.ts`。
- MVP `listMyTasks` 当前按创建时间新到旧，前端 `MemberTasks.tasksByDue` 才做截止排序；概念 `TaskSection` 同样按截止，迁入时可复用排序但要统一 API 空值和稳定顺序；
  见 `MVP/apps/api/src/tasks.ts`、`MVP/apps/web/src/components/member/MemberTasks.tsx`。
- MVP `MemberTasks` 首页当前只呈现状态、会议来处/原话、开始/完成快捷按钮、退回原因，无详情、个人任务跳转、邀请、甘特拆分和手建入口；见 `MVP/apps/web/src/components/member/MemberTasks.tsx`。
- MVP 首页数据接入点是 `MVP/apps/web/src/components/member/useMemberHome.ts` 的 `useMemberHome`（`GET /api/me/home`）；
  页面宿主是 `MVP/apps/web/src/components/member/MemberWorkspace.tsx` 的 `MemberHomeBody`。

## 10. SSOT 规则要点

- `概念/docs/product/tianshu-ssot.md` 的 DRI-01：普通成员看参与战场、个人月卡、本人推进事项；协作者不自动把他人事项混进「我的执行事项」。
- DRI-01：执行事项按截止近到远，无截止在后且保留先后，CEO 指派只用标签表达来源，不固定置顶；卡可显示协作者、所属个人任务、会议入口。
- DRI-01：战场本月进展以个人任务证据、战役和本月目标分层；个人任务与战役关联若为演示须标明，不可凭标题猜；个人任务依赖只有自由文本，不连细边。
- DRI-01：甘特图为本月全战场**个人任务**时间轴；按战役分组，里程碑与悬浮卡、键盘和触屏行为有细则，执行事项甘特图需等真实起止日期来源。
- DRI-01：手机最新目标顺序是通知 → 我的执行事项（在这里改状态）→ 我的本月卡 → 战场 → 雷达 → 菜单；概念版当前布局/雷达尚未改到位。
- `概念/docs/product/tianshu-ssot.md` 的 DRI-03：个人卡一人一张，原件与 13 字段「个人任务」双页签，意见挂字段；个人任务下的执行事项不得遗漏。
- DRI-03：成功证据统计是个人任务验收之和，与战役自身进展分开；无真实核对事件时不能把证据条数冒充完成数。
- `概念/docs/product/tianshu-ssot.md` 的 DRI-04：普通新建必须标题加所属个人任务，可选开始/截止/完成定义；推进人默认创建者，创建后进入详情并从个人任务下能找回。
- DRI-04：不可关联无参与权对象；历史待关联仅兼容旧记录。详情左为归属、战场、状态、截止、参与人、完成定义和判断，右为 Agent/事项群组。
- DRI-04：仅推进人自报进度与写事项判断；其他人写私有批注；邀请协作不转主责、不加拍板权。CEO 调研只能经指定人承接交接包后入清单。
- 用户本次要求允许不挂任何 Mission/个人任务的独立事项，与当前 DRI-04「普通新建必须所属个人任务」**冲突**；迁入前需要明确更新产品规则及后端归属契约，不能声称原样搬运已满足。
- `概念/docs/product/tianshu-ssot.md` 的 DRI-05：通知固定「会议安排 → 本月 Mission Card → 推动」；个人卡一轮一张通知、共用分钟时钟和轮次状态，确认后退出通知。
- DRI-05：事项群组按对象成员计算，Co-Agent 开场依据对象资料生成，名单只写名字；群组开场不存储、不算未读，右列页头人数和「成员可见」同源；概念实现见 `概念/src/components/dri/group-members.ts`、`group-opening.ts`。
- DRI-05：交接包指定人可「接下」或「拒绝」，分别要求回传日期、原因，不可重复；承接只是责任，不授予决定权；详情和通知卡同名同校验。
- DRI-05a：同事邀请「加入」后才加入事项成员，artifacts 加载有约 1.25 秒本机演示动效；群组开场说明邀请缘由、协作目标与时间，不代表真实模型写回。
- DRI-05b：推动通知按四象限与时限排，来源和层级不决定优先级；CEO 指派与同事邀请同条件同排序。
- DRI-05c：推动通知可在卡上直接表态或回话；失败保留草稿、成功回执及相关执行事项卡闪亮，写话和详情右列事项群组同一条线；概念群聊仍只存在本机。
- `概念/docs/product/tianshu-ssot.md` 第 22 行规定用户最新明确决定优先；本次「独立事项」定义是新的产品要求，应据此修订 DRI-04，而不是沿用旧的必选归属校验。
- 同一 SSOT 的 DRI-01 第 214 行注明概念版手机布局尚待改、事项与个人任务关联在 MVP 尚有缺口；搬 UI 时应逐项验收，而非把文字目标视为现成实现。
