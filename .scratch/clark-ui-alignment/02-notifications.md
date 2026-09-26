# 对照报告 02 · 通知栏（clark-main → Tianshu）

来源：2026-09-23 只读对照。CM=`clark-main/src`，TS=`Tianshu-MVP/apps/web/src`，API=`apps/api/src`，CT=`packages/contracts/src`。
主要文件：CM `components/ceo-warmap/notifications.tsx(+css)`、`notification-card-header.tsx`、`notice-strip.tsx(+css)`、`notice-state.ts`、`workspace.tsx(.module.css)`、`context-mark.*`、`card-references.*`、`view-transition.ts`、`app/globals.css:3260-3309`；TS `components/NotificationRail.tsx`、`styles/notifications.module.css`、`styles/app-shell.module.css`、`HomeShell.tsx`、`CardPage.tsx`、`lib/objectTransition.ts`。

总结：天枢是另一套设计（浅色扁平、一条通知一张卡、「稍后处理」），无分组、无折叠窄条、无 peek、无 ⌘\、无栏内确认/撤回、无计数；对象页没有通知栏。**用户约束：不得改后端 → 「会后确认进通知栏」需改 API 投影，不做。**

## 1. 结构
clark（固定顺序；组内无待办则整组消失）：
| # | 组 | 标题 | 副标题 | glyph | 条目 |
|---|---|---|---|---|---|
| 0 | 议题新进展（仅有更新时，workspace.tsx:577） | 「议题新进展」+计数 | — | — | 每议题一张 |
| 1 | decisions | 「战略决策更新」 | 「Co-Agent 会后总结」 | issue | 共识确认（红点，浮卡）；「本月目标与 Mission Card 制定」（琥珀点，月度工作区） |
| 2 | meetings | 「战略会议安排」 | 「今天 · 白田田主持」（写死） | meeting | 今日会议（灰蓝点，会议工作区） |
| 3 | research | 「战略问题研究」 | 「Co-Agent 提请」 | signal | 待处理红色雷达信号（红，雷达阅读）；DRI 提请（红，浮卡） |
- notifications.tsx:34-39（RAIL/RAIL_ORDER），:282-295。组计数=组内待办数，标题后药丸，aria「N 项通知」（notification-card-header.tsx:27）。条目无时间戳，时间只在 meta 文本里。已结算副标题是死代码。
天枢（NotificationRail.tsx:67-118）：无分组，一通知一卡；红 issue 在前，其余按 API 顺序，**最多 6 条**（:118）；kind：urgent（红 issue）/ inquiry（任何非红待办 issue，含黄灰）/ agenda（scheduled 会议）/ monthly；无计数；时间在卡片右侧；空态「本周没有待处理通知。」（:223）。

## 2. 逐项
### 2.1 位置与宽度
clark（workspace.module.css:54-65）：左列 `--notice-width: clamp(290px, calc((100vw - 70px)*.28), 430px)`；≤1250 为 280；≤1000 为 270。padding/gap 14，≥1800 为 16，≤1250 为 10。grid-template-columns 过渡 .32s cubic-bezier(.22,1,.36,1)，view transition 期间关闭（:56）。
天枢（app-shell.module.css:50-57）宽度相同；≥1800 强制 14；无列动画；691–1000 保留双栏 `minmax(250px,30%)`（:119-124）而 clark 首页隐藏通知栏（:140，clark 自身 bug，见 memory）。

### 2.2 容器（notifications.module.css:1）
clark：局部字号 `--type-title:17px; --type-body:15px; --type-meta:13px; --type-note:13px`；radius 29（≤1200 为 23），border `.5px solid rgb(255 255 255/28%)`，文字 #fff，padding 0，overflow hidden，isolation isolate；背景 #53647f + `radial-gradient(ellipse at 18% 4%, rgb(202 219 245/24%) 0%, transparent 48%)` + `linear-gradient(180deg, rgb(112 132 166/38%) 0%, rgb(80 98 132/42%) 52%, rgb(55 69 101/50%) 100%)` + `url('/brand/tianshu-notification-wallpaper-v2.webp') center 49%/cover`；阴影 `inset 0 .5px rgb(255 255 255/52%), 0 10px 32px rgb(14 21 37/12%)`。
天枢：扁平 #f0f4fa radius 20 border 1px #ffffffb3 padding 17 gap 14 深色字。**缺 wallpaper-v2.webp**（clark 有，55,468 字节）。

### 2.3 时钟行
clark（notifications.tsx:61-91，CSS :3-16）：header absolute top/left/right 15（≤1200 为 13），z6，min-height 42，gap 6；13px/24px，`rgb(255 255 255/94%)`，`text-shadow: 0 1px 8px rgb(1 5 15/38%)`，pointer-events none（按钮除外）。
- 左锁按钮（margin-right auto）：42×42 圆，border `.5px rgb(255 255 255/31%)`，背景 `linear-gradient(145deg, rgb(255 255 255/26%), rgb(255 255 255/14%))`，阴影 `inset 0 1px rgb(255 255 255/38%), 0 6px 18px rgb(2 7 19/16%)`，LockKeyhole 14；aria「进入锁屏并重新验证」（CM/components/log-out-button.tsx:66）。
- 右首页胶囊（button）：min-height 42，padding 7px 12px，radius 999，1px border `rgb(255 255 255/31%)`，同渐变阴影，gap 8；TianshuMark 23（`--brand-bright:#fff; --brand-deep:#cdd9ec`）；日期「9月23日」、星期「星期三」（`rgb(255 255 255/68%)`），同行时间 14px/500 tabular-nums letter-spacing .01em；hover/focus-visible 背景 `rgb(255 255 255/24%)`，阴影 `inset 0 1px rgb(255 255 255/48%), 0 7px 22px rgb(2 7 19/20%)`，`::after` 扫光 `homeLight 1400ms ease-in-out infinite`（110deg 白带）；active scale(.975)；过渡 background 220 / box-shadow 220 / transform 200ms；aria-current=page 时 border #fff 并跑一次 homeLight 1500ms ease-out；aria「天枢，返回首页」；点击关闭所有打开的 sheet/工作区/view。
- 时钟按分钟边界跳（`60_000 - t%60_000 + 20`ms），visibilitychange 重同步，本地时区。
天枢（NotificationRail.tsx:152-166）：文档流，左「配置」按钮（Settings，30×30，粗指针 42）——被测试锁定（notificationSummary.test.tsx:52-55），属 TIANSHU-ONLY 需产品决定；胶囊是不可点的 span radius 12；时间第二行；每 15s 跳，固定 Asia/Shanghai。

### 2.4 通知列表
clark（:18-20）：absolute inset 0，column gap 14，padding `78px 16px var(--notice-bottom-inset, 52px)`；≤1200 `72px 13px 42px` gap 11；≥1800 `86px 21px 56px` gap 18；≤690 bottom inset `calc(112px + env(safe-area-inset-bottom))`（workspace.module.css:215）；隐藏滚动条，overscroll contain，卡片从浮动时钟下滚过；浮卡打开时 inert + overflow hidden（notifications.tsx:346）；FLIP 重排 420ms cubic-bezier(.22,1,.36,1)（:240-252）。
天枢：flex 1 gap 14 无 padding，无 FLIP，不 inert。

### 2.5 议题新进展
NOT-BACKED（无 topic collaboration / reviewedAt），不做。

### 2.6 组卡（notifications.tsx:348-352；notification-card-header.tsx；CSS :22-57）
- 外框：`--notice-radius: 22px`（≤1200 为 18）；border 1px `rgb(255 255 255/43%)`，背景透明；阴影 `inset 0 1px rgb(255 255 255/30%), 0 5px 18px rgb(2 8 21/9%), 0 1px 4px rgb(2 8 21/6%)`；contain paint；过渡 box-shadow .2s ease、transform .28s cubic-bezier(.22,1,.36,1)、opacity .28s；`data-current`：`inset 0 0 0 1.5px rgb(255 255 255/.9), 0 10px 28px rgb(2 8 21/.18), 0 2px 8px rgb(2 8 21/.14)`；`<section aria-label={title}>`；≤690 阴影 `0 3px 12px rgb(30 48 70/7%), 0 1px 2px rgb(30 48 70/5%)`。
- 右上引用按钮：absolute top/right 8，28×28 radius 9 色 #748092 opacity .7；hover 背景 #eaf0f9 色 #35699f；pressed #316cac；Quote/Check 14（整组合成引用 NOT-BACKED；单条引用视情况）。
- 玻璃页头（:36-41）：grid `38px 1fr` gap 12 min-height 62 padding `12px 44px 10px 14px`；背景 `rgb(22 32 52/28%)`，`backdrop-filter: blur(30px) saturate(130%)`，底边 `.5px rgb(255 255 255/16%)`，`inset 0 1px rgb(255 255 255/22%)`，`text-shadow: 0 .5px 1px rgb(0 0 0/22%)`；glyph 38×38 radius 11 border `.5px rgb(255 255 255/.8)` 渐变 `145deg rgb(255 255 255/.92) → rgb(245 247 251/.7)`（ContextMark）；标题 15/20 500 白 nowrap gap 7；计数药丸 min-width 19 高 19 padding 0 5px radius 10 背景 `rgb(255 255 255/.92)` 字 #2f3d55 12/600 tabular；副标题 13/18 `rgb(255 255 255/78%)` 省略；≤1200 min-height 58 padding `10px 40px 9px 12px` 列与 glyph 34（radius 10）gap 10；≤690 背景 `rgb(36 53 78/72%)`。
- 托盘（:43）：padding 6px 8px，背景 `linear-gradient(160deg, rgb(255 255 255/94%), rgb(246 247 250/93%))`。
- 条目行（:44-57）：flex top gap 12 min-height 56（≥1800 为 60）padding `12px 10px 12px 12px`（≤1200 `11px 8px 11px 10px`）radius 14 行距 2；hover `rgb(38 61 92/6%)`；aria-current `rgb(38 61 92/8%)` + `inset 0 0 0 1px rgb(38 61 92/10%)`；圆点 8px margin-top 7：红 #e34b43 + `0 0 0 3px #e34b4318`，琥珀 #c79624 + `#c7962418`，中性 #7d8ca4，完成 16px check #26805e；标题 15/1.5 560 #1d1d1f letter-spacing -.005em；meta 13/1.45 #686a70；chevron 15 #a2a6ad；active scale(.99)；focus 2px outline #1d1d1f offset -4px；aria「{title}，{meta}」。
天枢：每条独立白卡 radius 20 + 5×40 色条 + 悬停摘要 + 卡内 CTA/「稍后处理」。

### 2.7 浮动决策卡（clark 仅共识确认与 DRI 提请）
- 遮罩（:65-68）：absolute 覆盖通知栏 z7 padding 28px 25px 居中；背景 #18213214 + blur(2px)，noticeVeil .25s；aria「返回通知列表」。
- 卡（:69-75）：max-width 560，背景 #f4f5f7，border 1px #ffffff8f，radius 22，阴影 `0 18px 45px #24304726, inset 0 1px #fff`；role=dialog aria-modal=false；页头 padding 14px 17px 13px #686a70 分隔 `rgb(32 38 48/10%)`，关闭 30×30 圆背景 #e9edf37a X 18 aria「关闭通知，返回列表」。
- 动效（:169-203）：从来源**组卡**矩形 WAAPI 打开 340ms cubic-bezier(.22,1,.36,1)（opacity .35→1）；关闭 250ms cubic-bezier(.4,0,.2,1)（opacity .15）；无矩形时 `translateY(15px) scale(.95)`；reduced motion 0ms。
- 详情（:77-104）：padding `20px 20px 8px` gap 12；meta 13；h2 17/1.45 600；段落 15/1.7；理由 13/1.6 #a44e46；确认动作满宽行 `margin: 8px -20px 0` 上边线，按钮 flex1 min-height 52 15/500（首个 600）竖分隔：「确认」|「修改」；选项 grid gap 8，每项背景 `rgb(255 255 255/48%)` 1px border radius 10 padding 12，选中背景 `rgb(255 255 255/86%)` border #1d1d1f；「确认这个决定 ✓」未选时 opacity .43；回执行「✓ {label}」+「↺ 撤回」13px。
天枢：所有 kind 都开预览浮卡 max-width 390 白 radius 20 aria-modal=true，头「天枢 · {scope} · {kindLabel}」，CTA 跳路由 + 「稍后处理」。

### 2.8 通知栏播报 / 存储提示
clark：role=status 13/1.6 `rgb(255 255 255/58%)` + X「关闭操作提示」，3s 自动清；存储错误「浏览器存储不可用，刷新后将重置」（本机存储，NOT-BACKED）。

### 2.9 Toast（workspace.module.css）
fixed，背景 #172b45ed，白字，1px #ffffff26，radius 12，padding 12px 16px，12px，blur(14px)，lineIn .2s（opacity0 + 上移4px）；Check 15；role=status；4s。位置：首页 `left: calc(shell-edge + 10px)`，bottom 26，`max-width: notice-width - 20px`；工作区打开时 `left: shell-edge + strip + 10px`，`max-width: min(360px, 100vw - strip - 60px)`，z1160；≤690 left/right 14，bottom 95。

### 2.10 演示重置
NOT-BACKED，不做。

### 2.11 折叠窄条 NoticeStrip（notice-strip.tsx/.module.css；workspace.tsx:599）
- 任何 detailOpen 时、所有宽度都显示（月度开时整个 shell 隐藏）。
- 几何：fixed z1175，left/top/bottom = --shell-edge，宽 --strip-width **56px**（≤690 为 48）；column 居中 gap 10 padding `12px 0 10px` radius 22（≤690 gap 8 padding `10px 0 8px` radius 20）；同通知栏壁纸材质与阴影；入场 stripIn .32s cubic-bezier(.22,1,.36,1)（opacity0，X -8px），view transition 中挂载时跳过（data-static）。
- 内容从上到下：① 首页按钮 TianshuMark 22，aria「天枢，返回首页」tooltip「返回首页」；② 当前工作区 glyph（仅会议/月度打开时）40px ContextMark 置于 42px 凹槽，role=img aria「当前：{label}」；③ 开关 PanelLeft 20 stroke 1.7，aria-expanded，aria「收起通知栏」/「展开通知栏，N 条需要尽快处理」/「展开通知栏」，tooltip「…（⌘\ 或 Ctrl+\）」；④ 锁按钮 margin-top auto 置底。
- 按钮：42×42 圆（≤690 为 40），border `.5px rgb(255 255 255/.31)`，渐变 `rgb(255 255 255/.2) → .09`；hover `.24`；active scale(.96)；focus 2px #fff offset 2；expanded 背景 .3 + inset 环；过渡 160ms。
- 红点：9px #e0564b top/right 8，环 `0 0 0 2px rgb(83 100 127/.9)`，urgent>0 时显示。
- 工作区打开时 `--notice-width: var(--strip-width)`，通知栏 display none（workspace.module.css:125-126）。
天枢：无。

### 2.12 Peek（workspace.module.css:125-131,146,159-160；workspace.tsx:104,516-527,600）
- 浮出通知栏：fixed z1150，`left: shell-edge + strip + 8px`，top/bottom shell-edge；宽 --peek-width（同 rail clamp），`max-width: calc(100vw - 2·edge - strip - 16px)`；radius 29；阴影 `12px 0 50px #19243833`；peekIn .26s cubic-bezier(.22,1,.36,1)（opacity0，X -14px）；691–1000 宽 `min(320px, 100vw - 100px)` radius 24；≤690 `left:62px; right:8px` max-width 320 radius 21。
- 遮罩按钮：fixed，`inset: 0 0 0 (edge+strip)`（窄条保持可点），z1100，#20293830，historyVeil 180ms，aria「收起通知栏」。
- 打开：窄条开关、⌘\ / Ctrl+\（仅工作区打开时；key==='\\' 或 code==='Backslash'，无 Alt）、左边缘触摸滑入（clientX ≤ 28，dx > 48，横向为主）。
- 关闭：Escape（Escape 链第一位）、点遮罩、再按开关/快捷键、反向滑动（dx < -48）、打开任何工作区/历史、工作区关闭（rAF 复位）。
- peek 是覆盖层，不是重排。焦点不移入 peek，关闭也不还原（clark 缺陷）。

### 2.13 View Transitions（CM/app/globals.css:3260-3309，view-transition.ts）
| 名称 | 元素 |
|---|---|
| notice-card | 来源通知组卡 ⇄ 会议工作区/月度覆盖层；首页卡 `[data-origin]` ⇄ 展开面板 |
| notice-rail | `.notificationArea` ⇄ NoticeStrip（只在过渡中挂名） |
| home-board | `.homeSurface` |
| notice-panel | 议题转场时的战场面板 |
- 根不参与（view-transition-name:none）；打开 group 240ms cubic-bezier(.2,0,0,1)；关闭 200ms cubic-bezier(.3,0,.1,1)（`html[data-notice-transition="close"]`）；旧快照线性淡出 50% 消失；新快照 0 → .12@30% → 1 ease-out；`object-fit:none; object-position:left top`；image pair overflow clip radius 22；z：home-board 1 < notice-rail 2 < notice-panel 3 < notice-card 4。
- 只在从首页打开时跑；工作区之间直接切换不跑；peek 打开时关闭不跑；reduced motion 关闭。
天枢：路由跳转 + playObjectEnter（从 CTA 按钮矩形），无反向过渡，无 rail/strip 形变。Next 16 App Router 支持 React `<ViewTransition>`（apps/web/node_modules/next/dist/docs/01-app/02-guides/view-transitions.md）。

### 2.14 手机（≤690）
clark：首页**只有**通知栏全高（workspace.module.css:150-153）；通知栏换浅色画布 `--tianshu-canvas #f1f4f8`、`--tianshu-canvas-top #f7f9fc`、glow `rgb(58 131 247/4%)`（heroui-tianshu.css:47-49）；时钟字 #2f343b，星期 #727b87；胶囊/锁 字 #565b63 border #ffffffdf 渐变 `#ffffffaa → #edf0f57a` 阴影 `inset 0 1px 1px #fff, 0 2px 8px #29334508` logo `#a4a7ae`/`#666a73`（notifications.module.css:107）；玻璃页头 `rgb(36 53 78/72%)`；首页显示全局输入条，列表底部留 112px；工作区打开：48px 窄条 + 主区 `inset: 8px 8px 8px 62px`。
天枢：上下堆叠，主区在上，通知栏在底部 42dvh（min 210）；对象页全屏无窄条。

### 2.15 无障碍偏好
reduced motion：notifications.module.css:110、notice-strip.module.css:22、workspace.module.css:20（`.shell *{animation:none!important; transition:none!important}`）、:131；JS 浮卡 0ms、跳过 FLIP、关 view transition。reduced transparency（:111-112）：通知栏 `linear-gradient(160deg, #435473, #34415c)`，页头/胶囊/锁 #2c364a 无模糊，托盘 #f7f7f8，遮罩 #d8dce3。high contrast（:113,:117）：通知栏 border #737b88，卡 border #777，次要字 #454549，页头 #30394a，当前组 2px outline，理由字 #8a2f28，窄条 border #fff。

### 2.16 2.4s 同步扫光（C-08）
不用于 CEO 通知栏（只在 DRI「9 月 Mission Card」组）。NOT-BACKED，不做。

## 3. 交互
| 条目 | clark | 天枢 |
|---|---|---|
| 共识 / DRI 提请 | 栏内浮卡（形变），焦点到关闭钮，列表 inert | 预览浮卡，CTA 跳 `/issues/:id` |
| 月度 | openHeavyNotice('monthly')：view transition，全屏 Mission Card 页，保存/还原滚动与焦点 | 预览浮卡 → 「进入月度计划」→ `/plans/:period` |
| 会议 | openHeavyNotice：view transition 进会议工作区，组 data-current，行 aria-current | 预览浮卡 → 「进入会前预审」→ `/meetings/:id` |
| 红色雷达信号 | openRadarSignal，并标记已读 | 当红 issue 处理 → `/issues/:id` |
- 确认/撤回（notifications.tsx:254-269）：commit 存回执、onDecision、播报+toast「{label}，战场已更新。」、关浮卡；确认后条目从列表过滤掉（:293），空组消失；撤回实际不可达（clark 缺陷，不照抄）。
- C-05：clark 打开不移除任何条目，只有确认才移除；天枢「稍后处理」隐藏本会话、6 条上限隐藏其余，都可能藏掉待拍板红色决策（违反 C-05）。
- 键盘：浮卡打开时 Escape 在 window capture 阶段 stopImmediatePropagation（:205-213）；工作区 Escape 顺序（workspace.tsx:521）：peek → 移动端 rail → 键盘态 → 历史 → sheet → 重工作区 → 雷达详情 → view；⌘\ / Ctrl+\ 切 peek（:519）。天枢 Escape 冒泡阶段；对象页 Escape 去 `/`。
- 焦点：clark 关浮卡回到触发者（若仍存在），否则回通知栏（tabIndex=-1）；若焦点在 global-controls 内不抢；工作区关闭回到来源。天枢只在栏内还原。

## 4. 后端支持（按用户约束：只做前端已有调用可支撑的）
| clark 功能 | 天枢支撑 | 状态 |
|---|---|---|
| 红色待办 issue | `/api/cards/home`（API routes/cards.ts:23-39，issues.ts:320-327）；`Card.urgency`（CT cards.ts:45）；设计文档：通知栏只显示红色（docs/CEOwarmap_目标设计_v0.3.md:645） | ALIGN |
| 提请浮卡内拍板 | `issue.decide`（CT issues.ts:79-82）；设计文档把红 issue 路由到 `/issues/:id` | MISSING-BUT-BACKED（需产品决定；属新增调用） |
| 撤回决定 | `issue.revoke_receipt` | MISSING-BUT-BACKED |
| 会后共识确认 | MeetingOutcome pending + meeting.confirm_item 等；**但 /home 只返回 scheduled 会议** | 需改后端 → 不做 |
| 修改共识文本 | MeetingConfirmItemInput = {} | NOT-BACKED |
| 月度入口 | /home 中未确认的月度计划 | ALIGN（文案不同） |
| 48h 倒计时 / 扫光 | 无 | NOT-BACKED |
| 今日会议 + 时间段 | 仅 scheduledAt，无结束时间 | 开始时间 ALIGN；时间段 NOT-BACKED |
| 「今天 · X主持」 | leadDriId + participants | MISSING-BUT-BACKED |
| 打开雷达信号 | originRef.signalId | MISSING-BUT-BACKED |
| 「1 小时前」 | 无 createdAt | NOT-BACKED |
| meta 中战场名 | location.battlefieldId + /home 战场卡 | MISSING-BUT-BACKED（纯前端映射） |
| 议题新进展 | 无 | NOT-BACKED |
| 组计数、窄条红点 | 红 issue | 前端可算 |
| 窄条/peek/⌘\/滑动/view transition/FLIP/玻璃/toast/播报 | 纯前端；对象页需通知数据（已有 /api/cards/notifications 或 /home） | 前端 |
| 组引用按钮 | 引用是单卡 `{cardId,version}` | 整组 NOT-BACKED |
| localStorage 回执/重置 | 设计禁止 | NOT-BACKED |
| 演示重置、「模拟 · 」前缀 | 真实后端 | NOT-BACKED |
| 「稍后处理」、6 条上限、悬停摘要、「配置」按钮、看起来可点但不可点的胶囊 | — | TIANSHU-ONLY |

## 5. 文案
| 元素 | clark | 天枢 |
|---|---|---|
| 通知栏 aria | 「通知与日程」 | 无 |
| 左按钮 | 「进入锁屏并重新验证」（sr「锁屏」） | 「配置」 |
| 胶囊 | button「天枢，返回首页」 | 不可交互 span |
| 组标题 | 「战略决策更新」「战略会议安排」「战略问题研究」 | 无；浮卡头「天枢 · {scope} · {kindLabel}」 |
| 副标题 | 「Co-Agent 会后总结」「今天 · 白田田主持」「Co-Agent 提请」 | — |
| 雷达 meta | 「雷达 · 需要尽快判断」 | 所有红 issue 都写「雷达」 |
| 提请 | meta「模拟 · 灯塔项目 · 提请」；详情「灯塔项目 · 负责人提请 · 1 小时前」 | scope 为原始 id 或「公司」；「决定期限 YYYY-MM-DD」/「待判断」 |
| 月度 | 「本月目标与 Mission Card 制定」/「先确认 LTCO／PCO，再开放 48 小时讨论」 | 「月度计划 {period}」，CTA「进入月度计划」 |
| 会议 | 「模拟 · 10:00–12:00」 | `scheduledAt.slice(0,16)`（UTC bug），「关联 Issue N 个 · {names}」，CTA「进入会前预审」 |
| 关闭 | 「关闭通知，返回列表」/ 遮罩「返回通知列表」 | 「关闭通知浮卡」 |
| 空态 | 无（整组移除） | 「本周没有待处理通知。」 |
| 窄条/peek | 「通知栏，已收起」「返回首页」「展开通知栏，N 条需要尽快处理」「收起通知栏」「（⌘\ 或 Ctrl+\）」「当前：{label}」 | — |

## 6. 标记
1. 天枢 bug：会议时间显示 UTC（`scheduledAt.slice`，NotificationRail.tsx:92）；`decisionBy.slice(0,10)`（:77）同风险。
2. 天枢 bug：红色 DRI/CEO issue 标为「雷达」（:75），提请 scope 显示原始 id（:32-36）。
3. 天枢与自身设计文档不符：黄/灰 issue 进了通知栏（v0.3.md:645 只要红色）。
4. 天枢违反 C-05：「稍后处理」与 6 条上限。
5. clark 不要照抄的缺陷：撤回不可达；`[data-heavy-notice]` 选择器失效；monthlyState 未用；已结算文案是死代码；「会见进行中」疑为「会议进行中」；toast 重复；.glyph 38px 裁切 40px ContextMark。
6. 691–1000：clark 首页隐藏通知栏只剩按钮（bug），天枢有意双栏；ts-design 规定「双页阅读桌面」。
7. 红色 issue：clark 在浮卡里拍板，天枢设计文档路由到 `/issues/:id`。
8. clark 浮卡与 ⌘\ 是 aria-modal=false + 列表 inert；天枢 aria-modal=true 无焦点陷阱。
9. 需移植 ContextMark；lucide `PanelLeft`、`LockKeyhole` 需核对天枢 lucide-react ^1.46。
10. 需要更新的测试：`notificationSummary.test.tsx`（悬停摘要 CSS、「配置」按钮）；`responsive-layout.test.ts:49-51,89-91`；`notificationClock.test.ts` 保留（Asia/Shanghai 正确）。
