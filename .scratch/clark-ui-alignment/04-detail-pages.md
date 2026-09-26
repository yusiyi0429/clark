# 对照报告 04 · 二级页（clark-main → Tianshu）

CM=`clark-main/src/components/ceo-warmap/`，TS=`Tianshu-MVP/apps/web/src/`，API=`apps/api/src/`，CT=`packages/contracts/src/`。clark CSS 是压缩的，Lnn 为源码行。

## 0. 改变做法的六个发现
1. 部分参照组件不是活的：`heavy-workspace.tsx`（会前预审逐项核对→提交）从未渲染，只用其 heavyTitles/heavyMaterials（workspace.tsx:35）；CEO 实际会议页是 MeetingWorkspace（:597）。`monthly-workspace.tsx`、`monthly-group-chat.tsx` 未被引用（死代码）；活的月度界面是 `mission-cards/workspace.tsx`（MissionCardWorkspace，:644-646）。`strategy.module.css` 未引用。`topic-role-workspace.tsx` 只服务 /dri/topics、/sec/topics。HeavyWorkspace/MonthlyWorkspace 仅作 CEO-03 规则参照。
2. 参照雷达无数据：useRadar() 返回 undefined，动作都报「概念版使用 SSOT 数据，雷达尚未连接」（use-radar.ts:5-7）；只有空态是活的，阅读器仅按代码规格。
3. 天枢没用参照 UI 栈（无 HeroUI/Tailwind/ts-design）。
4. 导航模型不同：clark 原地打开（VT、焦点、通知栏折窄条、右侧对话 rail）；天枢路由跳转，只有进入动画无关闭动画（objectTransition.ts:32-47），关闭/Escape 一律 `router.push("/")`（CardPage.tsx:57-65），返回不还原焦点。
5. 天枢没有战场详情页（无 /battlefields/*），BattlefieldCard 只是首页翻转卡（HomeBoard.tsx:152），标题是静态 h2（BattlefieldCard.tsx:47）。
6. 天枢阅读字号小：`--type-reading` 14px（app-shell.module.css:20）vs clark 16/≥1800 17（workspace.module.css:L23,L50）。

## 1. 共享详情框架
### 1.1 外壳
| 元素 | clark | 天枢 | 差异 |
|---|---|---|---|
| 画布 | #f1f4f8 + 85% 0% 蓝光晕 + #f7f9fc→#f1f4f8（heroui-tianshu.css:47-49） | #f5f5f7 + 暖灰渐变 | 无蓝光晕 |
| 主区圆角 | 24（L2） | 20 | -4 |
| 详情打开时通知栏 | 折成 56px NoticeStrip（全宽度）+ peek | 对象页无通知栏 | 缺 |
| 对话列（C-02） | TopicConversationRail fixed 右侧 360（≥1600 400，760–1000 310）radius 22 border #e1e5eb；页头页签 `天枢` \| `同事 · N`/`指派并对话`；上下文行；共享输入条进 rail（L236） | 议题/会议/信号页嵌 ConversationDock sidebar 400 radius 20 border #e6e9ed，可折 54px，标题各页不同；plans 与雷达列表用底部 dock | 同事频道 NOT-BACKED；天枢可折叠 clark 不可；clark 全高 |

### 1.2 展开页头（clark：雷达、战场、战略、能力）
- `.expandedHeader` min-height 100，padding 25px 27px，`linear-gradient(145deg,#ffffffa8,#edf1f6a1)`，底边 1px #ffffffbf，`backdrop-filter: blur(30px) saturate(1.28)`，`inset 0 1px #fff`（L79）；≤1250 padding 18（L9）；≤690 min-height 88 padding 18（L82）；带 rail 760–1000 padding 22px 20px gap 10（L243）。
- `.expandedIdentity` flex gap 13，换行 row-gap 10（L81,L254）；眉题 span 11px #73777f .025em 下距 5；h1 `var(--type-page)` 24（≥1800 26）600 1.4（L33），单行省略（L254）。
- 雷达页头：`ContextMark kind="signal"` + 眉题 `外部信息 · 雷达` + h1 `雷达信号`；选中信号：眉题 `信号详情 · 雷达` + `返回信号列表` 按钮（.backToList L184-190：inline-flex gap 4 margin-left -11 padding 9px 15px 9px 10px border 1px #dfe3ea radius 13 bg #fffffff2 15/600 阴影 `0 1px 2px rgb(28 38 56/.06)`；hover border #c4d5ea 色 #2f6bb4 图标左移 2px）。
- 战场页头：h1 = 去掉「战场」的名称；ToggleButtonGroup aria-label「战场视角」单选不可空 margin-left 4：`待决策` \| `进展`；ceoLeads 时 `进展` 带 Crown 15 stroke 1.8，aria-label `进展（你兼任这个战场的 DRI）`。
- 关闭：HeroButton ghost sm isIconOnly data-close-view，X 23；`.closeRound` 42×42 圆 bg #e7e7eb 色 #6e6e73 hover #dcdce1 active scale(.95) 过渡 .15s；aria `返回全局`/信号打开时 `关闭雷达`；关闭中禁用。
- ContextMark：40×40 radius 12 border 1px `rgb(255 255 255/.7)`，渐变 `145deg rgb(255 255 255/.88) → rgb(245 247 251/.55)`，阴影 `inset 0 1px rgb(255 255 255/.92), 0 3px 12px rgb(26 34 49/.1)`；每 kind（issue/signal/monthly/meeting）三个色块（context-mark.module.css:1-19）。天枢无。

### 1.3 面板与滚动
- clark `.expanded` absolute inset0 z20 radius 22 #f5f5f7 column；`.expandedScroll` margin 0 22 padding 8/18/128 smooth scroll-padding-bottom 128；带 rail ≥760 margin 0 padding 18/24/44；雷达阅读布局去 padding。
- 天枢同值但 radius 20；议题/会议页 scroll padding 0；feed 页（雷达、信号）用 .feedSurface。

### 1.4 转场（见 05 报告 §3）
天枢无关闭动画、无议题 clip、无战役 sheet、会议/月度无转场。

### 1.5 焦点与 Escape
- clark：打开聚焦 `[data-close-view]`/`[data-close-sheet]`（焦点已在 global controls 内除外）；关闭还原到来源；月度还原所有滚动与焦点。
- clark Escape 顺序（:516-521）：peek → 移动端 rail → 键盘态 → 历史 → sheet → 重工作区/会议 → 雷达信号回列表 → 关 view。月度自理（输入先 blur，再 Co-Agent 面板逐档，再移动端覆盖层）。
- 天枢（CardPage.tsx:57-65）：无 dialog 时 `router.push("/")`，不检查焦点在输入框 → 在月度/议题表单/会议备注里按 Escape 丢未保存输入（违反 C-06、C-04）；信号页 Escape 回首页（clark 回列表）。
- C-01：天枢关闭总回 `/`；从会议打开的议题（MeetingCard.tsx:1044）关闭回首页而非会议。

### 1.6 战役 sheet（clark 独有；天枢最近似 /missions/[id]，映射有歧义）
`.sheet` fixed left main-start right shell-edge（带 rail 减去 rail+gap），bottom 16，高 `min(72dvh,800px)`，radius 26，bg #29292b，border 1px #ffffff26，阴影 `0 16px 64px #0004, inset 0 1px #ffffff12`，字 #edf0f5；把手 36×4；页头 padding 15px 28px 16px，small `当前战役` 11px .06em #9ca6b6，h2 20px；关闭 ChevronDown 24 于 36 圆 #ffffff12，aria `收起战役详情`；正文 padding 24px 28px 122px。

### 1.7 Mission Card 页头胶囊（C-08，仅 ts-design WorkspaceShell 页）
`.ts-detail-header` sticky top 10，高 48，margin 10px 14px 0，radius 18，border 1px `rgb(58 131 247/14%)`，bg `rgb(247 250 254/74%)`，`blur(20px) saturate(140%)`；返回钮高 44 radius 14 13px；眉题 12px #7c889b 右分隔；h1 15/600 单行；≤1000 眉题隐藏、返回仅图标；≤759 高 44 top 8。**不适用于 CEO 议题、战场页。**

### 1.8 字号 token
| token | clark | 天枢 |
|---|---|---|
| --type-title | 20（≥1800 22；≤1000 18） | 20 |
| --type-body | 14（16） | 14 |
| --type-meta | 12（13） | 12 |
| --type-note | 11（12） | 11 |
| --type-page | 24（26） | 24 |
| --type-reading | **16（17）** | **14** |

### 1.9 HeroUI 值
- ToggleButton md 高 40（sm 36/md+ 32）padding-x 16（sm 12）全圆 14/500 gap 8 图标 20（sm 16）；bg --default（ink 4% 于 #fdfdfe）；选中 --accent-soft（#3A83F7 9%）字 #3C66BF；按下 scale(.97)；组内内角 0 两端圆 无按下缩放 内嵌 focus 环。
- Tabs secondary：每页签高 32 padding-x 16 14/500 色 #6b6b70，选中 #17171b；指示条 2px 底 #3A83F7 250ms；容器底边 1px #e7e7ed。
- Button 高 40（md+ 36）全圆 14/500；tertiary/secondary bg --default；ghost 透明；secondary 字 #3C66BF。
（注：05 报告读到的构建里 --font-weight-medium 被 clark @theme 设为 600，按钮实际 13/600。实施时以浏览器 computed style 为准。）

## 2. 议题页
- clark（issue-workspace.tsx:42-82）：页头 ContextMark（issue，有会议时 meeting）+ 眉题 `{生命周期 | 与你一起想} · {scope}` + h1 + 关闭；TopicMeetingHeader（有会议）；Tabs `总结与判断` \| `研究与依据`（aria `研究内容`）；阅读区；总结页签：当前判断 + `追问这条判断` → 讨论区 → `判断的依据` → `还没弄清的` → `读到这里就可以`（仅会议）；研究页签：markdown 研究 → `材料来源` → 讨论区；划词 `引用提问`；右侧 rail。
- 天枢（IssueCard.tsx:96-376）：页头眉题 + h1 + ChevronDown 关闭；三栏：左 `议题判断`（当前判断/已生效决定/决策路径/移出决策面 或 已移出框）；中 `研究报告`（徽章、错误、选择与后果/证据/还没弄清/来源）；右 ConversationDock `议题对话`。

| 元素 | clark | 天枢 | 差异 |
|---|---|---|---|
| 容器 | fixed left main-start … bottom shell-edge，z70，radius 22，bg #f8f8fa，border 1px #fff，阴影 `0 4px 24px #1d1d1f0c`，clip-path inset(0 round 22px)，容器查询 | relative，width min(2480px,100%)，padding 20px 40px 80px，无自身背景 | 无卡面、无 clip 展开、极宽 |
| 页头 | min-height 96 padding 25px 27px 玻璃渐变 `145deg #ffffffa6 → #eef1f6a3` blur 30 saturate 1.28 底边 #ffffffc2；眉题 12px #6e6e73；h1 22/600 1.5 -.025em 上距 7 | 透明 padding 0 0 22px 底边 1px #e6e9ed；眉题 13px；h1 26/600 1.4 上距 8 | 无玻璃、无 ContextMark；h1 +4 |
| 眉题 | `{与你一起想\|研究中\|…} · {scope}` | `{Radar 升级\|DRI 提交} · {位置} · {状态}{ · 决定期限}` | bug：origin:"ceo" 显示 `DRI 提交`（:101）；位置打印原始 id（:36-41） |
| 关闭 | HeroUI tertiary icon-only X 19，aria `关闭议题，返回原位置` | 40×40 radius 20 border #d9dde5 bg #fff ChevronDown 22，aria `返回首页` | 图标、文案、行为 |
| 页签 | HeroUI Tabs secondary，列表 padding 0 20px 底边 #1d1d1f0a | 无，三栏 380 \| 中 \| 400 gap 20 | 结构 |
| 阅读字号 | 16/1.8 padding 24px 28px 48px；h2 14/600 #63636a | 中栏 14/1.8；h2 15/600 #1d1d1f | -2 |
| 当前判断 | 无框；p 19/1.8 -.02em；`追问这条判断`（HeroUI sm secondary 上距 14）引用到输入条 `关于“…”，` | 卡片 border #eceef2 radius 20 bg #fff padding 22px 24px；p 14 #3c4350；无追问 | 缺追问；判断 -5 且加框 |
| 讨论/选项 | 标题 `会议结论`/`带到会议讨论`/`值得一起推敲的方向` + 徽章 + 编号选项（01…；border 1px #1d1d1f0e radius 10 bg #fafafb padding 10px 12px 14px）+ 回执 + 脚注 | `选择与后果`：id + label + 后果列表 | 框架与文案不同 |
| 判断的依据 | `ol` 01 + 要点 | `证据`：每条 blockquote + 来源链接 | 呈现不同 |
| 还没弄清的 | 框 radius 12 bg #f5f5f7 padding 18px 20px 14 #56565e | `还没弄清` 普通列表 | 缺框 |
| 研究正文 markdown | 有 | ResearchDoc 无自由文本 | NOT-BACKED |
| 材料来源 | source + 证据行 | `来源` 链接列表（仅 http） | 可 |
| 回执 | 绿：border #dce9e2 bg #f4f9f6 Check #34785c radius 10 padding 12px 14px | border #dce9e2 **bg #edf3fb（蓝）** radius 12 padding 16px 18px；meta `决定时预研：…`；`撤回决定` | 颜色不符；撤回为天枢独有 |
| 会前阅读 | 框 border #dde2e8 radius 14 … | 无 | 新增调用 → 不做 |
| 会前动作 | `阅`/`已阅`、`整理追问`、`带到会议` | 只在会议页 | 新增调用 → 不做 |
| 决策路径 | 无 | `决策路径` + tooltip + 内联建会表单 + 加入会议 + `新建 Meeting`（bg #007aff radius 11 14/600） | TIANSHU-ONLY 保留 |
| 移出/恢复 | 无 | `移出决策面` + 原因；已移出框 + `恢复到待处理` | TIANSHU-ONLY 保留 |
| 划词引用 | SelectionToolbar → `引用提问` | 无 | 前端能力（引用走现有卡片引用）|
| 错误态 | 无 | 预研错误 `{code}：{message}` + `重试预研`；动作冲突 `重新核对后重试`/`重试` | TIANSHU-ONLY 保留 |
C-04：移出原因与建会表单失败后保留；/api/people 失败被静默吞掉（IssueCard.tsx:82-94），`新建 Meeting` 一直禁用无解释。

## 3. 雷达列表与信号阅读
### 3.1 列表
- clark（radar-feed.tsx:69-78）：展开页头 → 工具条 [筛选 `全部|未读|收藏`，排序 `按时间|按重要程度`] [`监测范围`，`刷新信号`] → 可见状态行 → 错误/警告 → AnchorEditor → 故事或空态。
- 天枢（RadarCard.tsx:108-285）：无页头；工具条 [`返回首页`，`全部|未读`，`最新采集|影响优先`] [`监测范围`，`手动补扫`，ⓘ tooltip 状态] → 警告 → toast → 扫描错误 + `重试` → 故事或空态 → 只读配置弹窗。
| 元素 | clark | 天枢 | 差异 |
|---|---|---|---|
| 宽度 | max-width 772 padding-bottom 120（L82）单列 gap 12（L83） | max-width 1680 padding 0 40px 80px，双列 | 宽双列 |
| 筛选/排序 | HeroUI ToggleButtonGroup sm | 分段控件 padding 3 bg #eef0f4 radius 12，按钮 padding 6px 13px radius 10，选中白 + 阴影 `0 2px 7px #2028400c` | 视觉不同；缺 `收藏`（前端可按已有 state.saved 过滤）；排序文案不同 |
| 状态行 | 可见 role=status 12px #818590 margin 15px 0 20px：`{run.phase\|'正在读取雷达'} · {time}` | 藏在 tooltip | 可发现性 |
| 故事卡 | padding 21px 24px radius 19 border 1px #e8eaf0 渐变 `145deg #fff → #f6f8fc` 阴影 `0 4px 14px #192d5010`，hover translateY(-2px) border #dbe3ef；meta `{source} · {date}` + 右侧 `已成议题`/`已读`/`新信号`；h2 = **文章标题** 20px；p = 摘要两行截断 13.5px；底部锚点标题 + ArrowUpRight 17 | padding 25 radius 20；h2 = assessment.summary 21/600；p = strategicImpact 三行 14px；meta `{badge} · {source.title}`；底部 `{已读\|未读}{ · 已收藏} · 影响 n/5` + ExternalLink 12 | 内容字段对调；无 已成议题（未投影）；ExternalLink 图标暗示外链但实为站内 |
| 打开 | 原地选中并**标记已读** | 跳 /radar/signals/:id，不标记已读 | 标记已读=新增调用 → 需用户决定 |
| 空态 | 100px 轨道 conic；h2 21/500；三种文案 | 同轨道（扫描时旋转）；一种文案 | 文案 |
| 监测范围 | 可编辑 Modal（NOT-BACKED 编辑） | 只读弹窗 980×min(1040,100dvh-64) radius 20 白 | 保留只读，样式改 clark Modal |
| 补扫 | `刷新信号`/`正在扫描`（RefreshCw 旋转） | `手动补扫`/`扫描中…`；7s toast；409 消息 | ALIGN |
| 对话 scope | view:radar | global | 契约无 view scope，保持 |

### 3.2 信号阅读
- clark（radar-feed.tsx:38-68）：meta `{source} · {date}` + 收藏切换 → h2 文章标题 → 分块 **总结**（导语 + `尚未确定`）/ **对我们的影响**（正文 + `战略锚点` 框 + 关联议题框）/ **原文**（可折叠摘录 + 出处 + `阅读原文`）→ `不再出现在阅读列表` → **继续浏览**。
- 天枢（SignalCard.tsx:53-139）：`返回 Radar` → meta → h2 = card.title（摘要截 30 字，API/signals.ts:62-65）→ 导语 = strategicImpact → `尚未弄清` → 可折叠 `原文 · n 字`（链接、证据高亮、图片）→ 状态按钮 → 错误 + `重试` → 侧栏 `对话 · 本条信号`。
| 元素 | clark | 天枢 | 差异 |
|---|---|---|---|
| 文章列 | max-width 772 padding 22px 26px 40px bg #ffffff90 | max-width 920 padding 15px 35px 130px；grid `minmax(0,1fr) 400px` padding-right 40 | |
| 标题 | `clamp(23px,2.1vw,34px)`/650 1.36 -.9px #1d1f25 margin 12px 0 0 | 28/600 1.4 | 天枢只显示 30 字 |
| 分块框架 | .blocks margin-top 28 上边 1px #d8dee8；每块 padding 24px 0 底边 1px #e7eaf1；h3 11.5/600 .14em #98a0ad | 无分块标签 | 缺 总结/对我们的影响/原文（CEO-04） |
| 总结导语 | 17.5/1.85 #2b3038 | 导语=strategicImpact 18 #3c4655 | 字段不对 |
| 未知 | .note margin-top 18 padding-left 15 左边 2px #d9e0ea 13.5 #656d7b；标签 `尚未确定` 11.5/600 #99a1af | .clarify 框 radius 20 bg #f7f8fa；`尚未弄清` 12px 列表 | 样式与文案 |
| 影响正文 | 15.5/1.95 #3f4550 | （即导语） | |
| 战略锚点框 | margin-top 20 padding 16px 18px border 1px #e4eaf3 radius 14 bg #f2f5fa；标签 `战略锚点 · {title}` 12/600 #53617a | 无 | 需加载雷达卡（新增调用）→ 需决定 |
| 关联议题 | 框 … | 无 | 未投影 |
| 原文 | 常显，`max-height:12em` 遮罩；`展开全部摘录`/`收起摘录`（chevron 旋转 180°）；出处行 11.5 #868d9a；主按钮 `阅读原文` bg #2f6bb4 白 radius 13 padding 12px 18px 14/500 阴影 `0 3px 10px rgb(47 107 180/.22)` | 卡片 border #e6e9ed radius 16 **默认折叠**；头按钮 `原文 · n 字`（ChevronRight 旋转 90°）+ 小蓝标题链接；正文 13/1.75；证据段高亮 #e8f1ff；图片代理 | 缺出处行、主 CTA；高亮与图片为天枢独有保留 |
| 状态 | 收藏 ToggleButton isIconOnly sm `收藏信号`/`取消收藏`；隐藏 tertiary `不再出现在阅读列表`/`恢复到阅读列表` margin-top 34，成功后**回列表** | 三个带框按钮（radius 10 padding 9px 14px 13px）：`标记已读/标记未读`、`收藏/取消收藏`、`隐藏/取消隐藏`；隐藏后留在页面 | 文案、位置 |
| 继续浏览 | h3 11.5/600 .14em | 无 | 新增调用 → 需决定 |
| 返回/关闭 | 页头 `返回信号列表` + 圆形关闭 `关闭雷达`；Escape → 列表 | `返回 Radar` ghost 13px；Escape → `/` | 行为 |

## 4. 战场详情（天枢完全没有）
clark 待决策：Lead（状态点 + 文本 + h2，padding 16px 18px border 1px #dfe4e9 radius 16 健康洗色：blocked #fff5f3 / watch #fdf8ed / steady #f4f8f5；h2 22/600）→ `证据`（NOT-BACKED）→ `议题 <b>n</b>`（行 padding 15px 20px 15px，7px 紧急点 红 #d94a43 / 黄 #c58b2a / 灰 #8e8e93，可选会议时间 Clock3，ArrowUpRight 50%；空 `议题都已交给团队`）→ `目标`（`六个月`/`本月` 卡 radius 18 padding 18px 20px；标签 12px #84848b；正文 15px）→ `战役`（双列；空 `还没有战役`）。
clark 进展：本月验收汇总、BattlefieldGoals、业务指标、自定义可视化 —— 天枢无对应数据（天枢明确不计算完成率，BattlefieldCard.tsx:160）→ NOT-BACKED。
天枢现状：首页翻转卡。正面 `负责人 · {name}`、`Missions · n`（链接 /missions/:id）、`六个月目标 · …`、待决议题；背面 `当月战场结果`、`普通待办`、`最新负责人反馈`、`WarMap 不计算完成百分比，也不跟踪待办执行状态。`；翻转 380ms rotateY；标题不可点；无皇冠。
→ 战场详情页属于「新增页面/新增调用」，按用户约束默认不做，需用户决定。

## 5. 会议与会前预审
- clark MeetingWorkspace（meeting-workspace.tsx:41-85）：absolute inset0 border 1px #fff radius 22 bg #f7f7f8 阴影 `0 8px 34px #1d1d1f12`；页头 min-height 100 padding 25px 26px 渐变 `115deg #e9eef1 → #f1f5f4 48% → #e9efec` 底边 #e0e6e5；ContextMark meeting；眉题 `会前预审 / 会议材料` 11px #77777d；h1 21/600；**大时间** `10:00—12:00` `clamp(32px,5cqw,52px)`/400 -.055em tabular #3a4655 上距 14（结束时间 NOT-BACKED，只显示开始）；Chip sm soft `主责 DRI · {name}`、`{n} 人参会`；关闭 tertiary X 19 aria `关闭会议空间`。正文白色 padding `24px max(24px,(100%−1180px)/2) 130px`：briefLead grid `1.4fr 1fr`（`这场会为什么存在` / `CEO 的会前位置`）；议题卡三列（820px 容器下一列）radius 15 padding 17，已读 border #b9d0bf bg #fbfdfb；页脚 `{read} / {n}` + `已建立阅读位置，不是流程完成率`。
- CEO-03 参照（HeavyWorkspace，未渲染）：`调整表述`（编辑清掉该项核对）、`核对此项`/`已核对`、`补充意见`、`{n} / {m} 项已核对`、`完成本次预审`（全部核对前禁用）；草稿本地自动保存，关闭不提交，保存失败 `本机保存失败，请保留此页面后重试`。
- 天枢 MeetingCard：页头眉题 `{会前预审|已取消|Outcome 复核} · {时间} · 主责 DRI {name} · {n} 人参会` 13px；h1 24/600 两行截断；右侧 `编辑会议`、分段组 `返回编辑材料 | 查看原始材料 | 重新预审`、`查看会议记录候选`、主按钮 `导入会议记录`（#007aff）、关闭 X 17 于 38 圆 aria `返回首页`；StageBar `新增会议 › 会前预审 › 会议进行 › Outcome 复核`；scheduled：左栏 380（`预审结论`、`关联议题` 已阅/带到会议/打开 Issue、`一号位追问`、`四输入边界`、`评审目录` scroll-spy）· 主区（`会前材料`编辑、`核心判断`、`重试预审`、`材料任务与评审边界`、分组条目 `查看依据（n）`/`标记已核对`/`请求补充材料`、`备注` + `保存准备状态` + `取消会议`）· 右侧 `会前对话 · 本场会议`；held/reviewed：`会后抽取摘要`、`逐项处理`（确认/忽略/撤回）、材料、记录、危险替换，dock `会议材料对话`。
- 差异：缺只读简报框架（ContextMark、大时间、Chip、两段简介、议题卡、阅读计数页脚）；关联议题行打印原始 `location.level`（MeetingCard.tsx:1034）；CEO-03 逐项编辑（后端 editsByEntryId 支持，前端无）→ 新增调用需决定；「全部核对后才可提交」无后端 → 不做；备注未保存关闭即丢；破坏性步骤用原生 window.confirm（:718,819,847）→ 改 clark/ts-design Modal（纯前端）；关闭文案 `返回首页` → `关闭会议空间`。

## 6. 月度、Mission、配置
- 活参照 MissionCardWorkspace（mission-cards/workspace.tsx:249-307）：ts-design WorkspaceShell + C-08 胶囊；侧栏 `本月 Mission Card` 列表；左 CardDocument（`原件` \| `个人任务 · N`，字段 dl，`引用并评论`/`建议修改`，`未报告` 标签）；右 CoAgentPanel + `与天枢 | 事项群组 · N` + ConversationComposer；模态 `审视并拍板本月 LTCO／PCO`、`重新开启 48 小时讨论`。——天枢 Mission 是只读正式承诺，个人卡评论/48h/拍板 NOT-BACKED。
- 孤儿参照 MonthlyWorkspace（仅作 CEO-03 风格参照）：页头渐变 `115deg #efeeea → #f6f5f2`；眉题 `月度协商 · 词元云集 · 2026 年 9 月`；h1 `月目标与任务制定` 21/600；…
- 天枢 MonthlyPlanCard（MonthlyPlanCard.tsx:108-303）：CSS 复制自 heavy-workspace，`.workspace` 同 `--accent:69 91 142`，border-left 2px，blur 26；`.monthly` accent（150 103 23）**从未应用**；页头 padding 28px 40px 20px 底边 #e6e9ed bg #f7f8fac9；marker 点；h1 `月度计划 {period}` 24/600；关闭 38 白框 aria `返回首页`；正文 grid `minmax(0,1fr) 600px` gap 24 padding 20px 40px 90px；分区卡 padding 20px 22px border #eceef2 radius 20；左 `公司结果`、`{battlefieldId} 战场结果`（**原始 id**）、`能力 PCO · {capabilityId}`（原始 id），各 textarea + `已核对 {label}`；右 `普通待办`（输入含 `负责人（personId）` 原始 id）、`DRI 反馈`、`备注`；提交区 `保存计划`、确认复选 + `签发计划`（#007aff）；回执绿 #edf6ef。C-04：核对复选框在保存确认前就勾上（:85-90），非 409 失败时仍保持勾选（bug）；Escape 丢未保存内容。底部 dock `left: calc(35% + 6px)` 在 /plans 可能压住提交行（待目检）。
- 天枢 Missions（独有）：/missions、/missions/[id] 用配置页框架（config.module.css padding 36px 56px 60px，h1 30/600）；详情：关系条 `能力域 / 关联战场 / 月度计划 / 来源`、`MISSION OUTCOME`、`成功证据`、`关键里程碑`、侧卡 `关键依赖`/`最大风险`/`边界`、`来源追溯`、底部 dock。建议：用 CardDocument 字段布局（dl/dt/dd）+ 版本行；成功证据/里程碑标 `未报告`；缺失字段（关键路径、资源与权限、人-Agent 分工、复盘沉淀）显示 `未提供`（C-04）；对话放右侧（C-02）。
- 天枢 Config（独有）：失败保留输入 ✓；应改用 ts-design FormField 标签、HeroUI 字段 token（radius 11，focus #075ccb）、AnchorEditor 式模态；按钮目前是原生样式。

## 7. 后端支持（摘要）
ALIGN：议题判断/选项/证据/未知/来源；雷达补扫；会议已阅/带到会议；月度核对与签发；Signal collectedAt（未渲染）。
MISSING-BUT-BACKED（=新增前端调用或新页面 → 按用户约束默认不做，列给用户决定）：议题「为什么现在」字段渲染（已在 payload 里，纯渲染可做）；位置显示名称（需 /api/cards/battlefields）；议题页会前阅读；议题页 阅/带到会议；回执链接来源会议（payload 已有 source.meetingId，web 类型未声明）；雷达收藏过滤（纯前端过滤已有 state，可做）；打开即标记已读；信号战略锚点；继续浏览；战场详情页；皇冠（需 /api/people）；会前预审逐项编辑。
NOT-BACKED（不做）：研究正文 markdown；议题协作（指派、同事、秘书排期）；议题页直接拍板；readMinutes/decisionWindow/reversibility；信号重新讨论；监测范围编辑；战场 status/headline/证据；战役 achieved/focus/judgment/unknown；本月验收/三环/指标/图表；预审「全部核对后提交」；Mission Card 个人卡评论/48h/拍板。
TIANSHU-ONLY（保留，按 clark/ts-design 语言重做样式）：决策路径、移出/恢复、预研错误重试、材料/记录/Outcome 复核、普通待办/负责人反馈、会话与附件、配置页、Missions 页、原文证据高亮与图片。

## 8. 文案（关键）
关闭：`返回全局`/`关闭雷达`；`关闭议题，返回原位置`（天枢 `返回首页`）；`关闭会议空间`（天枢 `返回首页`）；`返回信号列表`（天枢 `返回 Radar`）；`收起战役详情`。
议题：`总结与判断`/`研究与依据`（天枢 `议题判断`/`研究报告`）；`判断的依据`（`证据`）；`还没弄清的`（`还没弄清`）；`材料来源`（`来源`）；`值得一起推敲的方向`（`选择与后果`）；`会议结论`/`这是会议中形成并回传的结论。`/`已记录`（`已生效决定`/`决定时预研：…`/`撤回决定`）；`追问这条判断`、`引用提问`。
雷达：`全部 / 未读 / 收藏`；`按时间 / 按重要程度`（`最新采集 / 影响优先`）；`刷新信号`/`正在扫描`（`手动补扫`/`扫描中…`）；`已成议题 / 已读 / 新信号`；空态 `正在寻找值得关注的变化` / `从公司本体出发，看看外面发生了什么` / `这里暂时没有信号`；监测弹窗眉题 `雷达 · 公司级监测`（天枢 `RADAR`）。
信号：`总结`/`对我们的影响`/`原文`；`尚未确定`（`尚未弄清`）；`展开全部摘录`/`收起摘录`；`阅读原文`；出处 `检索服务返回的摘录，未宣称阅读全文 · 已按中文排版整理，字句未改 · 采集于 …`；`收藏信号`/`取消收藏`；`不再出现在阅读列表`/`恢复到阅读列表`（`隐藏`/`取消隐藏`）。
会议：眉题 `会前预审 / 会议材料`；`阅`/`已阅`；`请补充`/`已请补充`（`请求补充材料`）；`带到会议`/`已带到会议`；`已建立阅读位置，不是流程完成率`。

## 9. 歧义与 bug
1. 部分参照不是活组件（见 §0）。
2. 「Mission」含义：clark SSOT Mission=战役、个人卡含个人任务；天枢 Mission 是 DRI 月度结果实体，字段像 clark 的一条个人任务。
3. 关闭钮 42px 依赖 HeroUI 在 CSS layer 内，未渲染确认。
4. 天枢 OUTLET_NAMES 6 个（RadarCard.tsx:28），契约 RADAR_OUTLETS 8 个（多 华尔街日报、量子位）。
5. 天枢 bug：origin:"ceo" 标 `DRI 提交`（IssueCard.tsx:101）；原始 id 出现在议题位置、会议关联议题 level（MeetingCard.tsx:1034）、月度战场/能力标题；月度 accent 类缺失；月度复选框保存前先勾；`actionOf(...)!` 非空断言在动作缺失时崩溃（MeetingCard.tsx:1189,1235,1241）。
6. C-08 不适用于 CEO 议题/战场页，它们的页头按 clark 展开页头/议题页头（玻璃渐变 + ContextMark + 圆形关闭）。
