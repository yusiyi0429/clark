# UI 重建方案 B 规格（2026-09-21，已获 CEO 授权）

依据：`UpgradeDesign.pen` 导出的 HTML+CSS 基线，位于
`.scratch/ceo-warmap-mvp/design/pen-frames/*.html`（每个文件是一个设计 frame 的
逐属性导出，data-pencil-name 即设计节点名）。实现以这些文件为唯一视觉真相；
读值时直接打开对应文件查 style。

验收基准视口：**1920×1080、100% 缩放**。设计画布是 2560×1440，所有 px 值按
1:1 使用（不做 vw 缩放），版心/侧栏定宽，主区弹性。

硬约束：
- 只改 `apps/web`。不改 contracts、API、Action、路由。
- 不触发 Agent/搜索/对话发送/LLM。
- 不动工作区里其他未提交改动；只重写本规格点名的文件。
- 旧代 CSS 必须删除，不允许再叠一层覆盖。

## 修复项总览（9 条验收问题 → 4 个工作包）

### 工作包 1：通知卡重建（修 #1 议题卡结构、#2 会议卡白字、#7 浮卡颜色）

文件：`apps/web/src/components/NotificationRail.tsx`、
`apps/web/src/styles/notifications.module.css`（**整文件重写**，删除全部
玻璃抬头/深色壁纸/三代叠加规则）。

基线：`Card_通知卡-提请.html`、`Card_通知卡-会议.html`、`Card_通知卡-月度.html`、
`页面_首页Home.html`（通知栏 Notification Rail 节点）。

DOM 结构（删除现有 notificationGlassHeader/notificationIdentity/glyph mark DOM）：

提请卡（inquiry，含紧急/非紧急）：
```
card (r20; 紧急: linear-gradient(180deg,#FDECEA,#FFF) + 1px #E7C9C5;
      非紧急: #FFF + 1px #E6E9ED; shadow 0 2px 5px #29334C14, 0 9px 20px #29334C14)
  Head (padding 20px 22px 8px; row; gap 12)
    AccentBar 5×40 r3 (紧急 #E34B43，非紧急 #C79624)
    Left (column; gap 2; flex1)
      Title 15/600 #1D1D1F（可换行，不强制 nowrap）
      Reason 12/400 #4F5866 line-height 19px
    Time 12/400 #4F5866（右上）
  Actions (padding 0 22px 20px; row; gap 10)
    CTA: fill、h40、r10、#FFF 底、1px #D9DDE5、13/500 #1D1D1F  → 绑定现有主操作（查看判断与依据）
    Later: fill、h40、r10、透明底、13/400 #6E6E73             → 绑定现有“稍后处理”
```

会议卡（agenda）：**只有一行，无抬头无 Actions**
```
card (#FFF r20 1px #E6E9ED)
  MeetingRow (padding 22; row; gap 15) —— 整行是打开按钮
    Bar 5×40 r3 #007AFF
    Text (column; gap 5)
      Title 15/400 #1D1D1F
      Time 13/500 #4F5866
```
当前 bug：MeetingRow 内文字沿用了旧深色主题的白字（实测 rgb(248,249,251)），
重写后必须是上述深色值。

月度卡（monthly）：
```
card (#FFF r20 1px #E6E9ED)
  Head (padding 20px 22px 16px; row; gap 12)
    Bar 5×40 r3 #8A8A90
    Left (column; gap 6): Title 15/600 + Body 13/400 #4F5866
    Time 12/400 #4F5866
```

通知栏本体（rail）：#F0F4FA 平色（导出里是同色渐变）、r20、padding 17、gap 14、
1px #FFFFFFB3 描边；Clock Capsule Row 维持现有已收敛样式。

浮卡（点击卡片展开的 overlay 卡）：**浅色主题**，与列表卡同一卡面语言
（白底/紧急渐变、深色文字、r20、CTA 48 高）。删除 `.floatingCard.agenda`
的深色渐变与白字分支。浮卡内的交互体（textarea、决定选项、月度 sections）
保留现有功能，字色统一 #1D1D1F/#4F5866 系。

### 工作包 2：对话承载面（修 #3 弹窗几何、#5 删除/新建会话、#9 右栏历史跳全局）

文件：`apps/web/src/conversation/ConversationDock.tsx`、
`apps/web/src/styles/conversation-dock.module.css`、
`apps/web/src/styles/app-shell.module.css`（historySheet 部分）。

基线：`Dock_全局对话-展开.html`（含新建会话/删除确认两个变体文件）、
`页面_Signal阅读.html` 的 `对话 · 本条信号` 节点、
`页面_Meeting会前预审.html` 的 `Conversation Sidebar` 节点。

2a. 展开弹窗几何（#3、#5 变扁）：
- 尺寸**固定**：width min(1273px, 100vw-32px)；height min(885px, 100dvh-48px)。
  不允许 fit-content/仅 max-height（这是空会话坍缩成 262px 的根因）。
- 居中：改用原生 dialog 居中（position:fixed + inset:0 + margin:auto），
  删除基于 --main-start 的 left 计算（这是首页不居中的根因）。
- 内部三栏维持既有 260 / flex / 360，gap 22，padding 24 30，r24，#FFFFFFF2。
- 输入条 56 高 r28 #F7F8FA；发送 38px #007AFF。

2b. 删除会话语义（#5 前半）：
- 现状：删除激活会话后 `selectSession(null)` → historyUrl 变化 → effect 自动
  加载 legacy（= scope 内最老会话）消息，看起来像没删掉。
- 改为：删除激活会话后清空 transcript 并停留在“未选择会话”空态，**不再自动
  回载 legacy**。实现建议：deleteSession 内 setActiveSessionId(null) 的同时
  置一次性 ref（如 skipLegacyReload.current = true），loadHistory effect 检查
  并消费该 ref。初次挂载/正常切换的 legacy 回退语义不变。

2c. 右栏会话管理内嵌（#9）：
- 设计（Signal 阅读 + Meeting 预审右栏一致）：Conv Header 右侧是 Session Tools：
  - New Session Button：26×26 圆形 #F1F3F6（+ 图标）
  - Session List Button：h26 pill #F1F3F6，padding 0 9，内含图标+数量
- 点击 Session List 在**右栏内部**展开会话列表面板（列表项：标题 13、时间 11.5，
  当前项高亮 #E8F1FF；每项带删除入口，删除走既有确认流程），不打开全局
  1273×885 弹窗。sidebar 变体中移除 `setHistoryOpen(true)` 的 History 按钮行为。
- 全局 dock（底部胶囊）的历史按钮仍打开全局展开弹窗，不变。

### 工作包 3：Meeting 工作台重排（修 #8；顺带 #7 的页面内按钮）

文件：`apps/web/src/cards/MeetingCard.tsx`、
`apps/web/src/styles/meeting-workspace.module.css`（结构性重写，删除深色
hero/可折叠结论栏结构）。

基线：`页面_Meeting会前预审.html`（必读，层级已在导出里）：
```
页面（column，#F5F5F7）
  Header  padding 28px 40px 20px；左 Meta 13/400 #3C4350 + Title 24/600；
          右：Secondary Seg Group（#FFF r10：返回编辑材料 | 1×18 分隔 | 查看原始材料，
          每段 padding 9 14，13px）+ 上传逐字稿（#007AFF r10 padding 9 14 白字 13/500）
          + Close 38px 圆 #FFF
  Flow Stage Bar  白底 r14 padding 10 18；四步（新增会议/会前预审/会议进行/Outcome 复核）
          每步 padding 7 12 r9；激活底 #E8F1FF，序号 11/600 + 标签 13/600 #007AFF，
          非激活 #6E6E73/#4F5866；右侧 Stage Status 12/400
  Advisor Body  padding 20px 40px 80px；gap 20；三栏 row：
    Priority Sidebar 380px 白 r20 padding 22 gap 16：
      预审状态（Label 11 + Readiness Badge #E8F6EC r10 padding 5 12）
      一号位点评要点参考（#FDF4E4 r12 padding 14；标题 12/600 #8A6220；四个 Point）
      评审目录（Outline items：padding 8 10 r10，激活 #E8F1FF）
    Advisor Main flex1 gap 16：
      核心判断 Hero 白 r20 padding 24 26（Eyebrow 11 / Hero Title 19/600 /
        Body 14 #3C4350 / Sources Link 12 #0A5DC2）
      各 Section 白 r20 padding 20-22 24-26 gap 10-12，标题 15/600
      积极信号 + 潜在风险 两卡并排（gap 16）
      建议追问问题：Question 卡 #F0F4FA r12 padding 14 16
    Conversation Sidebar 400px 白 r20 padding 18 16（用工作包 2c 的组件）
```
数据映射：现有 preflight 结论/材料/关联议题/行动等内容按语义放入上述区块，
不新增数据需求，没有的区块显示既有空态文案。材料编辑（scheduled 未预审）
放在 Advisor Main 的白卡里，按钮统一 13px、padding 9 14、r10（修“按钮过高”）。
状态机、Action、上传逻辑一律不动。

新增会议表单（Issue 页决策路径内）按 `页面_Meeting新增会议.html` 的字段样式
收敛：输入 r10 1px #D9DDE5、13px；主按钮 #007AFF r11 padding 11 17。

### 工作包 4：字体系统 + 雷达折叠（修 #4、#6）

文件：`apps/web/src/styles/app-shell.module.css`、
`apps/web/src/styles/radar-feed.module.css`、涉及 clamp 的其他 css。

4a. 字体（#4）：type scale 全部改为设计固定值，删除 vw-clamp：
- --type-page: 24px（对象页 H1；Issue 页 26px 可保留）
- --type-title: 20px（面板标题）
- --type-reading: 14px；--type-body: 13-14px；--type-meta: 12px；--type-note: 11px
- 删除 `.shell h2{font-size:clamp(17px,1.3vw,28px)}`、`.card h2 clamp(20px,1.45vw,29px)`
  等所有 clamp 字号；通知卡字号见工作包 1。
- Signal 阅读：Headline 28/600、Lead 18、正文 15、来源 12（radar-feed 已接近，核对）。

4b. 雷达折叠跳动（#6）：折叠右栏时正文不允许水平跳动。给 `.reader` 的
grid-template-columns 变化加 transition（Chrome 支持 grid 列动画），并加
prefers-reduced-motion 关闭；同时侧栏内容淡出。若 transition 实测无效，
备选：折叠时正文列保持原宽（不重新居中），只收侧栏。

## 测试与交付

1. 相关单测同步更新（ConversationDock.test.tsx 的 session tools 断言、
   notification/meeting 相关快照断言）。
2. `pnpm --filter @warmap/web typecheck` 与 `pnpm --filter @warmap/web test` 全绿。
3. `git diff --check` 干净。
4. 报告：改动文件清单、每个工作包已做/未做、与规格的偏差及原因。
   截图验收由主会话负责，子代理不需要起浏览器。
