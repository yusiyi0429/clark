# Ticket 21：通知卡总结 / Radar 版心 / Issue 三栏单页 / 预审追问 / 配置页

状态：in-progress
设计基线：`UpgradeDesign.pen` @ commit `611de6f`（已按本票需求全部更新，实现以设计稿为准）

## 总原则

- 遵守根目录 CLAUDE.md：MVP、YAGNI、Web 不保存业务事实、CompanyMemory 对 WarMap 只读。
- 设计稿关键 Node：规范页交互组 `BmTJq`（Group · Issue 卡摘要 `B1g728`、Group · 通知卡总结 `bQ6pi`）、Issue pending 页 `TOXo0`、配置页 `LlNbX`、会前预审 `nszdy`。
- 每个工作流完成后跑对应测试；全部完成后：双端+contracts typecheck、API `npx vitest run --poolOptions.forks.maxForks=1`、web/contracts vitest、`pnpm --filter @warmap/web gen:client`（若契约变更）、`git diff --check`。
- 不 push；提交按工作流拆分为独立 commit。

## W1 通知卡 hover 总结 + 标题 ≤25 字禁止“…”截断

1. `apps/api/src/issues.ts`：删除 `shortRadarIssueTitle()`，`projectIssueCard` 恢复 `title: row.title`（禁止省略号截断）。
2. `packages/contracts/src/radar.ts`：`RadarPromotionCandidate.decisionQuestion` maxLength 1000→25（生成端硬门槛；radarAgent 提示词已要求 ≤25 汉字）。不合格候选走现有 invalid-candidate 拒绝路径。
3. 数据清理（staging DB，一次性 SQL）：issue `5757b4da-c7dc-4cf9-b0db-d55ea05abe27` 的 title（33字）改为 ≤25 的等义问题，如 `TKOS 首期是否内建 Agent 安全控制？`。
4. `apps/web/src/components/NotificationRail.tsx` + `notifications.module.css`：
   - 提请卡（issue 通知）与月度卡：默认仅标题+reason/期限；hover 或键盘 focus 时卡内展开 body（提请=ResearchDoc summary，月度=companyOutcome），复用 HomeBoard `issuePreview` 的 max-height 过渡模式（`home-board.module.css`）。
   - 月度卡默认态不再常显 body（对齐设计稿 sUVVv，Body 已移除）。
   - 检查并移除标题上的任何 line-clamp/ellipsis。
5. 测试：更新 `apps/api/test/issues.test.ts`（删截断断言，加 schema 25 字上限断言）；web 补 NotificationRail hover 摘要单测（纯函数或渲染断言）。

## W2 Radar 页边距

- `apps/web/src/styles/radar-feed.module.css`：`.feed` max-width 1940→1680，并确保视口 < 1680+2×40 时有 ≥40px 水平内边距（如 `padding:0 40px 80px`；检查 `CardPage` layout="feed" 外壳是否已有内边距，避免叠加）。
- 设计稿已同步：Radar Feed x=440 w=1680。

## W3 Issue 页三栏单页（pending/decided/dismissed 同一布局）

设计：工作台 2480 宽（40px 页边距，对齐会前预审）；三栏 = 左 380 / 中 fill / 右 400，gap 20。

1. `apps/web/src/cards/IssueCard.tsx`：
   - 删除 tab state（"总结与判断/研究与依据"）与整个"决定"模块（选项按钮、最终决定文本、直接决定/Override 确认框）。API 的 `issue.decide`/override action 保留不动（Web 不再提供入口；决策走 Meeting Outcome 链路）。
   - 左栏：`当前判断`（research.doc.summary）＋`决策路径`（现有 Meeting 表单+加入已有 Meeting）＋`移出决策面`（pending）；decided 态改为 当前判断＋已生效决定（receipts+撤回）；dismissed 态为 已移出（含恢复）。
   - 中栏：`研究报告`＝标题旁预研状态胶囊（research.status → 胶囊文案/颜色，复用会前预审 readiness badge 样式）＋ 选择与后果＋证据＋尚不清楚＋来源；research failed 时此处显示错误与"重试预研"。
   - 右栏：议题对话面板（scope `issue:<id>`）。复用 MeetingCard 内嵌会前对话的同一组件/模式（查 `apps/web/src/conversation/` 与 MeetingCard 中 Conversation Sidebar 的实现，抽用而非复制）。
   - 该页不再渲染底部全局 ConversationDock（`CardPage` 增加可选关闭 dock 的 prop，或 issue 页面直接不走 dock；设计稿三个 Issue 页 Dock 已删）。
2. `apps/web/src/styles/issue-workspace.module.css`：三栏 grid（380px / 1fr / 400px），max-width 2480 + 40px 边距；小屏降级为单列。
3. 测试：`issueDecidePrimary.test.tsx` 重写或删除（决定 UI 已移除，保留仍有意义的部分如 receipts 渲染/撤回）；其余 IssueCard 相关断言更新。

## W4 会前预审：陈述性追问 + 关联议题移左

1. `apps/api/src/preflightAgent.ts` PREFLIGHT_PROMPT：leader_lens 改为"3–5 条陈述性追问问题，站在一号位视角直接陈述要追问的事，禁止出现'视角预判''非权威发言'字样"；数量约束同步（leader_lens 3–5 条）。
2. `apps/api/src/meetings.ts` `preflightStructureError`：leader_lens 恰好 1 条 → 3–5 条；删除"视角预判/非权威发言"包含检查（改为拒绝出现这两个词）。
3. `apps/web/src/cards/MeetingCard.tsx`：
   - leaderLens 块渲染为编号陈述列表（entry.body 单行，不再 strong/p Q-A 对）；兼容历史单条数据（照常渲染）。
   - `关联议题` section 从主列移动到左侧 Priority Sidebar（预审状态之后），按设计稿 `Gu5d8` 紧凑样式：level 标签＋标题＋（已阅/带到会议/打开 Issue）chips，行为不变。
4. `meeting-workspace.module.css` 同步样式。
5. 测试：`apps/api/test/meetings.test.ts` 中 preflight 校验断言更新；web preflightOutline/MeetingCard 相关测试更新。

## W5 配置页（设计稿 `LlNbX`，入口＝首页左上角 settings 按钮）

前置约束：Organization Fact 只能由 CEO 确定性 Action 产生（表单=确定性输入，允许）；CompanyMemory 只读，不写。

1. 契约 `packages/contracts/src/`＋OpenAPI：
   - `POST /api/config/battlefields`：{ name, owner, goal } → battlefield_config 新增（migration 018 加 `owner TEXT NOT NULL DEFAULT ''`；id 用 slug 或 uuid，version=1）。
   - `POST /api/config/capabilities`：新表 `capability_config`(id, name, "group", description, created_at)（migration 018）；首页公司能力面板改为：注册能力分组 ∪ issue 派生分组。
   - `POST /api/config/issues`：CEO 新建 Issue（title ≤25、battlefieldId、decisionBy 可选）→ pending Issue。origin 枚举加 `"ceo"`（contracts+投影 badge "CEO"），照常触发预研。
   - `POST /api/config/meetings`：独立新建 Meeting（title/scheduledAt/leadDriId，issueIds 允许为空数组）。检查 `createMeetingFromIssue` 与 meetings 表对空 issue_ids 的下游（preflight、材料上传）容错；材料上传沿用 scheduled Meeting 现有接口。
   - 全部走 CEO session 鉴权（同现有 action 路由），非 opaque-action（这是新对象创建，无既有 Card version 可锚）。
2. `apps/web/src/app/config/page.tsx`＋`config.module.css`：按 `LlNbX` 还原（Top Nav 返回首页、SETTINGS header、2×2 卡片 1212 宽、输入框 44 高 r10）。新建会议卡内的"上传会前材料"区：MVP 先创建 Meeting 成功后跳转 Meeting 页上传（拖拽区点击即提示/跳转），不在配置页内做二段上传。
3. 首页入口：`NotificationRail.tsx` 左上角按钮 Lock → Settings 图标，`aria-label="配置"`，点击 `router.push('/config')`。
4. 测试：API 各 create 路由 happy path＋鉴权 401＋字段校验 400；web 页面渲染冒烟。

## W6 验证与交付

- 全量：typecheck ×3、API vitest（maxForks=1）、web、contracts、`gen:client`、`git diff --check`。
- staging：docker compose build api web && up -d --force-recreate api web；healthz 200；人工路径：首页 hover 通知卡、/config 四表单、/radar 边距、/issues/5757b4da… 三栏、会前预审左栏。
- 汇报：每个 W 一个 commit；结束输出已验证事实/推断/未执行检查清单。
