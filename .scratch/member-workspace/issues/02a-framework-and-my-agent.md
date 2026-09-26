# 02a 二级页统一框架与我的 Agent

状态：进行中（2026-09-26）
设计依据：`spec.md` §10、§11（§11.4 的 2a 段）。

## 目标

1. CEO 全部二级页换成概念版的对话栏：右列 `ConversationColumn`、两行输入条 `ComposerPill`、收起/展开、未读角标。首页输入条不变，雷达列表页不带对话栏。
2. 「我的 Agent」按「人 × 页面」私有：对话归属到登录的人；CEO 现有对话全部归到 CEO 名下。成员可以在 `/me` 首页使用自己的 Agent。
3. DRI Agent 的工具集去掉「战场总览」和「待决策议题」两个工具，也不带首页全局上下文。
4. 通用群组后端（成员、消息、读到哪里）：建好表、存取和接口。2a 不开放任何群，也没有加人入口。

## 与概念版对照后定下的实现细节

- **页头**：概念版 CEO 二级页仍然用 `expandedHeader`（和天枢现在的 `DetailHeader` 是同一个），只有会议页用 48px 页头胶囊 `DetailFrame`。所以 2a 保留 `DetailHeader` 不动，页头胶囊跟会议页一起放到第 5 步。
- **单频道**：没有群组的页面只有「我的 Agent」，宽屏不画频道开关。窄屏（≤759）的浮层只能从输入条左下打开，所以窄屏保留一颗只有「我的 Agent」的单段按钮，作为浮层入口。
- **右列页头**：Agent 一侧显示天枢标志、「CEO Agent」（成员为「DRI Agent」）和一行淡字「仅你可见」。概念版正文底部那行「仅自己可见 · 对话保存在此浏览器」不要，因为天枢的对话存在服务端，而且可见范围已经写在页头。
- **会话工具**：天枢已有的多会话功能（新建、切换、删除、附件）保留，放在右列正文顶部，与现在的 `TopicConversationRail` 位置相同。二级页输入条不再有历史键，因为对话记录就在右列里。首页的历史层不变。
- **输入条右端按钮**：有三态。回答中显示停止，有文字时显示发送，空的时候显示麦克风，但置灰，悬停提示「语音对话尚未接入」（取概念版 `ComposerAction` 的做法）。
- **提示文字**：Agent 频道「问你的 Agent…」，群组频道「在群组中讨论…」（群组 2b 才出现）。
- **未读**：输入条要打字，就必须先把右列展开。所以在只有「我的 Agent」的页面上，未读永远为 0。2a 只移植角标的显示（`formatUnread`、`unreadPhrase`）。群组频道的未读从服务端 `thread_reads` 读取，「只在频道摆在眼前时才算看过」的记账（`useMarkSeenWhileVisible`）随 2b 一起接。
- **右列群组页头**：成员头像、成员名单弹层随 2b 移植。2a 的右列只画 Agent 页头，群组页头只有图标加群名。

## 后端（apps/api，交给子代理）

### A1 迁移 `024_conversation_owner_and_threads.sql`
- `conversations` 加 `owner_id TEXT`，允许为空。旧索引 `conversations_scope_active_idx` 换成 `(owner_id, scope, created_at, id) WHERE deleted_at IS NULL`。
- `thread_members`：
  - 列：`object_type` 取 `'issue'|'signal'|'task'|'meeting'`，另有 `object_id`、`person_id`、`added_by`、`joined_at`、`left_at`；
  - 主键：`(object_type, object_id, person_id)`。
- `thread_messages`：
  - 列：`id BIGSERIAL`、`object_type`、`object_id`、`author_id`（Co-Agent 为空）、`kind`（`'member'|'co-agent'`）、`content`（1–4000 字）、`quote JSONB`（可为空）、`created_at`；
  - 索引：`(object_type, object_id, id)`。
- `thread_reads`：
  - 列：`object_type`、`object_id`、`person_id`、`last_read_id BIGINT NOT NULL DEFAULT 0`、`updated_at`；
  - 主键：`(object_type, object_id, person_id)`。
- `migrate.test` 的迁移计数加 1。

### A2 旧对话归属
- 启动时在数据库迁移之后执行 `assignLegacyConversations`（`server.ts`），语句是 `UPDATE conversations SET owner_id = <CEO person id> WHERE owner_id IS NULL`。CEO 的 person id 取人员目录里 roles 含 `ceo` 的那个人，找不到就跳过。这样不在迁移里写死真实人员 id，并且可以重复执行。
- 原先放在应用的 `onReady` 钩子里，结果数据库断开时应用起不来，`/healthz` 也就报不出「降级」，所以挪到了启动脚本（2026-09-26）。

### A3 对话接口按人
- 9 处对话路由从 `requireCEO` 改成 `requirePerson`，`owner = req.person.personId`。
- 所有 `conversations` 查询和插入都加上 `owner_id`（会话列表、默认会话、按 id 取会话、删除、附件）。别人的会话一律 404 `CONVERSATION_SESSION_NOT_FOUND`。
- scope 可见性按人判断：
  - CEO 沿用 `getScopeObject`；
  - 成员在 2a 只允许 `global`，其余返回 404 `CONVERSATION_SCOPE_NOT_FOUND`（2b 起按群成员放开议题）。
- 并发锁的键从 `hashtext(scope)` 改成 `hashtext(owner || '|' || scope)`，这样不同的人在同一页面不会互相挡住。

### A4 DRI Agent
- `runtime.run` 的输入加 `viewer: { personId, displayName, role: "ceo" | "member" }`。
- 成员的一轮：
  - 工具去掉 `get_warmap_overview` 和 `list_pending_issues`；
  - `globalContext` 为 null；
  - 系统提示使用 DRI 版本：身份写成「{displayName} 的 DRI Agent」，不写 CEO 决策口吻，其他规则（只读、证据标注、企业知识称谓）保持不变。
- CEO 的一轮行为完全不变，提示词和工具都不动。
- `agent_runs.input_snapshot` 记下 `viewer.personId`。

### A5 群组存取与接口
- `threads.ts` 提供以下函数：
  - `isActiveMember`；
  - `listMembers`，返回 personId、displayName、title，名字取自人员目录；
  - `listMessages(after?, limit=200)`；
  - `postMessage`；
  - `markRead`，只增不减；
  - `unreadCount`，只计别人发的消息。
- 契约放在 `packages/contracts/src/threads.ts`，并在 openapi 里登记，然后运行 `gen:client`。
- 路由，均使用 `requirePerson`，非成员一律返回 404 `THREAD_NOT_FOUND`：
  - `GET /api/threads/:objectType/:objectId`，返回 `{ members, messages, lastReadId, unread }`；
  - `GET /api/threads/:objectType/:objectId/messages?after=ID`，供 3 秒轮询使用；
  - `POST /api/threads/:objectType/:objectId/messages`，请求体 `{ content, quote? }`；
  - `POST /api/threads/:objectType/:objectId/read`，请求体 `{ lastReadId }`。
- 加人、退出、Co-Agent 同步消息、通知放到 2b。

### 后端测试
- 对话：
  - CEO 与成员各自的 `global` 会话互不可见；
  - 成员访问 `issue:*` 返回 404；
  - 成员拿别人的 sessionId 返回 404；
  - 两个人同时在同一 scope 发消息不会互相返回 409。
- 旧数据：插入一条 `owner_id` 为空的会话，启动后归到 CEO。
- DRI 工具：假 runtime 断言成员一轮的 `viewer.role`，并用工具名单函数断言去掉了那两个工具。
- 群组：非成员 404；成员能读能发；`after` 增量正确；`read` 只增不减；未读不计自己发的。

## 前端（apps/web，我来做）

### W1 移植概念版组件（照搬，改成天枢的目录与样式约定）
- `src/conversation/ConversationColumn.tsx` ← clark `conversation/column.tsx`，样式 `src/styles/conversation-column.module.css`；
- `src/conversation/ComposerPill.tsx` ← `composer-pill.tsx`，样式 `src/styles/composer-pill.module.css`；
- `src/conversation/useColumnMode.ts` ← `use-column-mode.ts`；
- `src/conversation/seen.ts` ← `seen.ts`；
- 组件用 `ts-design/primitives` 与 `ts-design` 的 `TianshuPortalTheme`（0.4.0 已导出），标志用天枢自己的 `TianshuMark`。

### W2 二级页接上
- `ConversationHost`：
  - 二级页用 `ConversationColumn` 加新的 `ColumnComposer`；
  - `ColumnComposer` 沿用 `ConversationDock` 的草稿、引用预填、发送失败回填、停止，外形用 `ComposerPill`；
  - 首页仍用 `ConversationDock` 加历史层。
- `CeoWorkspace`：外壳加 `columnHostClass`，删掉 `app-shell.module.css` 里只给旧右栏用的规则；`TopicConversationRail.tsx` 与 `topic-conversation-rail.module.css` 不再使用，删除。
- 全局对话标签从「公司全局」改为「我的 Agent」。

### W3 成员 `/me`
- `MemberWorkspace` 首页接上同一个 `ConversationHost`：只有首页，使用 `global` scope，没有引用。

### 前端测试
- `ConversationColumn`：
  - 单频道宽屏不画开关，窄屏画单段入口；
  - 收起后频道钮带未读；
  - 偏好写入 `tianshu-conversation-column-v1`。
- `ColumnComposer`：
  - 发送失败回填；
  - 空、有字、回答中三态对应的按钮；
  - 提示文字「问你的 Agent…」。
- 旧的 `ConversationDock` 测试保持通过（首页）。

## 验收
- API、web、contracts 测试全部通过（API 的 28 个 Windows 既有失败不计）；`tsc` 干净。
- 浏览器（CEO，localhost:3100）：
  - 议题、会议、信号阅读、月度计划、Mission、战场详情、公司能力都是左材料、右对话栏；
  - 收起后刷新保持收起；
  - 手机宽度下是浮层，从输入条左下打开；
  - 发一轮对话能收到回答。
- 浏览器（成员，127.0.0.1:3100，由用户自己登录）：`/me` 能和 DRI Agent 对话；成员看不到 CEO 的对话。

## 追加：会议页照搬概念版（2026-09-26，原排在第 5 步，用户要求提前）

用户确认的四项：去掉四段进度条；编辑会议、返回编辑材料、重新预审放进「AI 预审」页签顶部；现在就给会议加结束时间；「开始会议 → 计时 → 这场会开完了」现在做，其中「开完了」写真实状态。

- **页头**：`DetailFrame` 照搬 clark `detail-header/frame`，页头胶囊样式照搬 `coagent/capsule.module.css` 的页头部分。胶囊里依次是：
  - 返回；
  - 计划时段，日子写今天、明天、后天、昨天，其余写几月几日，时刻用公司时区；
  - 会名；
  - 右端的「会议记录」入口；
  - 右侧单独一颗「开始会议」胶囊（`MeetingClock`）。
- **材料页签**：「AI 预审」加每一份会前材料。补充材料的页签前面写「补充」。材料在页签里只读预览，原来的原始材料弹窗删除。
- **状态行**：「白田田主持 · 参会：刘明华、白田田 · 会前预审 · 暂不提交」。开完之后写「这场会开完了 · 记于 … · 待导入会议记录」。
- **会议记录**：
  - 会前：导入妙记或逐字稿，以及查看会议记录候选。
  - 会后：摘要、逐项处理、Transcript、替换 Transcript。
  - 开完了、有待确认的候选、会后复核中这三种情况，默认打开这一页。
- **后端**（子代理）：
  - 迁移 `025_meeting_end_time.sql` 加 `ends_at`（非空，存量会议按开始时间加 60 分钟补）和 `ended_at`；
  - 新建会议与编辑会议都接受 `endsAt`；
  - 新动作 `meeting.end`：只写 `ended_at`，不改 `status`，因为 `held` 必须带逐字稿。
- **不做**：天枢没有会中 Co-Agent，所以不画「Co-Agent 在听」胶囊。会议群组（频道开关「事项群组」）在第 5 步。
- **顺带修正**：
  - 编辑会议弹层原来用 UTC 回填时间（15:00 的会显示成 07:00），现在按公司时区回填和提交。
  - 概念版计时胶囊的 18px 左边距在固定宽的网格列里会被浏览器吃掉，改为算进列宽，还原概念版注释写明的间距。
