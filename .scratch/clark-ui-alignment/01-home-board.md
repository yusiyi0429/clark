# 对照报告 01 · 首页看板（clark-main → Tianshu）

CM=`clark-main/src/components/ceo-warmap/`，CMapp=`clark-main/src/app/`，TS=`Tianshu-MVP/apps/web/src/`，TSC=`packages/contracts/src/`，TSA=`apps/api/src/`。只读、未运行；依赖层叠顺序或 HeroUI focus 环处标「浏览器核对」。

## 0. 先知道的
1. 参照雷达是关的（CM/use-radar.ts:4-7 恒 undefined），活参照里从不出现雷达议题行、「N 条未读」「正在扫描」；磁贴恒为「看看外面的变化」。
2. 参照首页只在 >1000px 可见（691–1000 只剩按钮，≤690 只剩通知栏），≤850、≤500 的规则在参照里是死代码。天枢 691–1000 与 ≤690 都显示看板（TIANSHU-ONLY）。
3. 天枢多数视觉差异是为了对齐 `.pen` 设计刻意做的（`.scratch/ceo-warmap-mvp/evidence/pen-pixel-audit.md:63-71`，H-04…H-12：20px 圆角、雷达扁平背景、面板标题分隔线、15px 行字、固定 316/380 高度、切换 padding）。以 clark 为准就要回退。
4. 天枢设计文档限制战场卡：`docs/CEOwarmap_目标设计_v0.3.md` §2.4 正面=当前目标 + 待决议题；背面=普通待办 + 负责人 + 最新 DRI 反馈；禁止百分比、红黄绿健康、BattlefieldProgress、旧 LTCO 钻取。§2.5 要求像素级保留 home-board/progress-card/radar.module.css。API 同（TSA/battlefields.ts:389-392）。
5. 对齐栅格会打破 `TS/styles/responsive-layout.test.ts:26-30`（断言 3/2/1 列），clark 是 2/1 列且公司能力为最后一格。

## 1. 结构
| # | clark（home-board.tsx） | 天枢（HomeBoard.tsx） |
|---|---|---|
| 容器 | `div.board[data-testid=decision-home]`（:80） | 同（:97） |
| 第 1 行 | `.top`：**公司战略议题**（可点标题按钮 + 右上引用 + 议题行 + 雷达议题行 + 空态）与 **雷达信号** 磁贴（按钮）（:81-95） | `.top`：公司战略议题（纯 h2 + 分隔线 + 议题行）与雷达信号磁贴（:98-131） |
| 第 2 行 | 工具条：「战场」+ HeroUI 切换 待决策/进展（:97-103） | 工具条：「战场」+ **「查看 N 个 Mission」** + 自制滑块 待决策/进展（:133-148） |
| 第 3 行 | `.battlefields` 两列：每战场一张翻转卡，**公司能力** 为最后一格（:104-124） | 3/2/1 列只有翻转卡（:149-155） |
| 第 4 行 | （在第 3 行内） | 单独满宽 **公司能力**：h2 + 分隔线 + 每个已登记能力一组（:157-187） |
战场卡正面：clark [标题按钮+chevron] … [皇冠][引用][进展]，战场总结块，议题区；天枢 [静态标题][进展] 左对齐，上下文块（负责人、Missions、六个月目标），议题列表或「暂无待决策议题」。
背面：clark 环境光层、[标题]…[皇冠][引用][← 待决策 + 紧急数]、三环、状态药丸 +「进展看板 >」、「反馈与依据」；天枢 环境光层（动画）、[标题][← 待决策 + 紧急数]、「当月战场结果 · period」、「普通待办」、「最新负责人反馈」、页脚「WarMap 不计算完成百分比，也不跟踪待办执行状态。」。

## 2. 逐块（clark → 天枢）
### 2.1 看板/栅格/间距
- 看板：两边 overflow auto 隐藏滚动条 padding 0 0 88px 色 #1d1d1f flex column（CM/home-board.module.css:1-6）。gap：clark 13（≥1800 16，≤500 10）（:3,:50,:53）；天枢恒 14（后写的 `.board{gap:14px}` TS:114 覆盖所有媒体规则）。天枢独有 `(max-width:1100px),(max-height:820px)` 底 padding 72。
- 顶行：两边 `grid-template-columns: minmax(0,3fr) minmax(148px,.8fr)`，≤1100 `minmax(0,1fr) 142px`（CM:7,:51）。高度：clark **auto**（雷达磁贴 min-height 190，≥1800 225）（:9,:50）；天枢**固定** `clamp(250px,31dvh,316px)`（≤1100/≤820 高 `clamp(230px,34dvh,280px)`，≤850 auto），战略面板 overflow hidden 无内滚动 → **天枢会截掉放不下的战略议题**。gap clark 13（≥1800 16），天枢 14。
- 战场栅格：clark `repeat(2,minmax(0,1fr))` align-items stretch gap 13；≤850 一列（:36,:52）；公司能力最后一格，落在奇数位（战场数为偶数）时满行：`.battlefields>.capabilities:nth-child(odd){grid-column:1/-1}`（:80）。天枢 3/2（≤1250）/1（≤850）列，公司能力不在栅格内。
- 战场卡高度：clark auto（同行 stretch，rotor 取较高面）；天枢固定 `clamp(290px,37dvh,380px)`…，内部列表滚动。
- 面板（战略/能力）：
| 属性 | clark | 天枢 |
|---|---|---|
| 圆角 | 22（:8） | 20 |
| 边框 | 1px #dfe4e9（:62） | 1px #ffffffed |
| 阴影 | `0 2px 8px #29334c08`（:62） | 多层 inset… |
| 背景 | 战略 #fff；能力 #fbfcfd（:63-64） | 都 #fff |
- focus-within：clark 面板边框变 #bdd0e9 过渡 200ms（:89-90）；天枢被覆盖从不显示。

### 2.2 公司战略议题
- padding 两边：`20px 23px 13px`；≥1800 `24px 28px`；≤1100 17；≤500 `15px 12px`。
- 标题：clark HeroUI ghost 满宽按钮含 h2 + ChevronRight 16（margin-left auto，#8c98a6，opacity .3 → hover/focus-visible 1，180ms）（:14-17）；标题 padding-right 28 给引用钮（:59）；h2 `calc(var(--type-title)+1px)`=21（≥1800 23）650 -.035em 1.4（:15,:70）；点击打开战略详情 view。天枢纯 h2 不可点，20/600/1.35。→ **战略详情 view 天枢无页面：标题可点性需决定（按用户约束默认不加新页）**。
- 右上引用钮（clark 独有，issue 引用前端可做但属新增交互；面板引用 NOT-BACKED）：28×28 radius 9 色 #748092 opacity .7；hover/focus 1 背景 #eaf0f9 色 #35699f；按下 scale(.9)；选中 #316cac；absolute right 12 top 12；Quote/Check 14；tooltip 500ms。
- 分隔线（天枢独有）：1px #e6e9ed margin-top 11 → 删除。
- 列表：上距 clark 9（天枢 13）；行间 clark `border-top:1px solid #27364e0b`（:19,:74）（天枢 #e6e9ed 更深）；行 padding clark `7px 0`（天枢 `10px 2px`）；标题 gap 3 weight 500 同。
- 顺序：clark 固定议题在前、雷达议题行在后；天枢 company 级议题按 created_at ASC。
- 空态：`.board .empty` 12px #77777c margin-top 12 1.6。

### 2.3 议题行
- 结构：clark `div.issueSlot` flex gap 7（:59），带 `data-home-issue` `data-issue-instance` `data-urgency`；内含 HeroUI ghost `.issue` + 兄弟引用钮（margin-right 1）。天枢裸 `<button class=issue data-urgency>` 无 slot、无 data-home-issue。
- 按钮：flex align flex-start gap 10（≤500 7）radius 9 1.55；字号 clark `var(--type-body)` 14（≥1800 16），天枢固定 15；hover #f5f5f7 + 侧阴影 `6px 0`/`-6px 0`（:22），战略/能力内 `#e9edf466`（:66）；选中 clark #3a83f70d；active clark #3a83f714（天枢 #007aff12）；过渡 150ms。
- 紧急点 6×6 margin-top 8：clark 红 #d94a43、黄 #c79624、灰 #8e8e93（:30-33）；天枢红 #e34b43 + `0 0 0 3px #ff3b3008` 光晕。
- 箭头 ChevronRight 14 #7c8a9b margin-left auto，≤500 隐藏；clark opacity 0 → hover/focus-visible .8（180ms）（:34-35）；天枢**恒 .8**。
- 会议时间（clark；天枢已有 scheduled 会议卡含 scheduledAt+issueIds，属纯前端映射，可做）：Clock3 13 #7b8794 +「M/D HH:mm」；「 · 会见中」NOT-BACKED；样式 `max(13px, body-1px)` #666d76 tabular gap 6 margin-top 2。
- 天枢独有：`<small>决定期限 YYYY-MM-DD</small>` 12px #a1443c；雷达议题悬停预览 strategicImpact（max-height 0→6.8em，180ms，12/1.65 #4f5866，role=tooltip）。
- 可访问名：clark「{需要尽快决策 | 需在窗口内决策 | 待决策}：{title}」+「。会议时间 {time}」；天枢黄色缺「需在窗口内决策」。
- HeroUI（浏览器核对）：按下 scale .98（瞬时）；select-none；focus-visible HeroUI ring-2 #075ccb offset 2 **加** 模块 outline `2px #8cb1e8, offset 3px`（:25）。天枢 `.shell button:focus-visible{outline:3px solid #007aff88;outline-offset:4px}` 压过；clark 用 `:not([data-slot])` 豁免 HeroUI。
- 回执（clark；天枢首页无决策动作 → NOT-BACKED）。

### 2.4 雷达信号磁贴
- clark：HeroUI ghost `class="${r.radar} ${s.radar}"` `data-origin="radar"`，外包 `.radarWrapper`（:89）。天枢 `class="${b.panel} ${b.radar}"`，**缺 r.radar** → 启动 chevron 永不出现（clark hover/focus 180ms 淡入，CM/radar.module.css:35-36），也没有 r.radar 的基础布局（align-items flex-start，gap 7，position relative）。
| 属性 | clark | 天枢 |
|---|---|---|
| 布局 | flex column space-between padding 20；≤1100 `17px 14px`（:9,:51） | flex column flex-start gap 8 padding `20px 20px 16px` |
| 背景 | `linear-gradient(145deg,#f1f7ff,#f8fafd 75%)`（:65） | #f0f4fa |
| 边框 | #dfe4e9 | #ffffffd9 |
| 圆角 | 22 | 20 |
- h2 两边 20（clark ≥1800 22）600 -.03em。状态行：clark absolute left 22 bottom 17（:57）；天枢在标题下文档流；两边 11px #617894。
- 雷达盘：clark stage min-height 104 max-height 132，盘高 116（上限 130），≤850 90，≤500 78；三个回波点 `.echo` 4px #498ee9，7s `echo` 关键帧，延迟 .7/2.3/4.9s（CM/radar.module.css:31-34）。天枢 stage flex 1 无上限，盘 max-height **170**，**无回波点**。两边扫描 7s linear、十字、19%/37% 环、中心点；reduced motion 扫描固定 35°，clark 回波 .35。
- 按下：clark scale(.98)。

### 2.5 雷达议题行（clark 独有，参照里从不渲染）→ 天枢雷达议题就是普通议题行，保持。

### 2.6 工具条与切换
- 工具条：clark flex space-between gap 12 padding 0 3px margin-bottom -4（视觉距栅格 9）（:37）；天枢 height 36 padding 0 4px。「战场」12px #7c8088。
- clark 切换：HeroUI ToggleButtonGroup（attached，md）single + disallowEmpty：高 36（≥768）padding 0 16 14/500；外角 30px 药丸、内角直角；未选背景 --default（≈#f3f3f5）字 #1d1d1f，hover ≈#e8e8e9；选中 --accent-soft（≈#ebf2fd）字 #3C66BF，hover ≈#e2ecfd；背景过渡 100ms；组内无按下缩放；focus 内嵌 2px #075ccb；role=radiogroup + role=radio aria-checked，方向键移焦（React Aria useToolbar），Space/Enter 选中。
- 天枢切换：自制分段 轨道 #e9ebef radius 10 padding 3；白滑块 radius 6 `0 1px 3px #172b4312` translateX 280ms cubic-bezier(.22,.72,.18,1)；按钮 12px min-width 62 padding 6px 18px 色 #7b8089；role=group + aria-pressed；两个 tab 停靠，无方向键。
- 状态逻辑两边相同（全局模式变化清空单卡覆盖）。
- 「查看 N 个 Mission」（天枢独有，→ /missions）：margin-right auto radius 8 padding 5px 8px 11.5/600 #3c4350，Flag 13，hover #f2f4f7。保留（按 clark 按钮语言重做）。

### 2.7 战场卡框架/rotor/面
- 两边：`.frame` radius 22 perspective 1800；`.rotor` preserve-3d，`rotateY(180deg)` 380ms cubic-bezier(.22,.72,.18,1)，阴影 `0 2px 6px #1d1d1f08, inset 0 1px 0 #fff`；`.face` radius 21 padding `21px 22px`（≥1800 `24px 28px`，≤1100 17）backface hidden clip-path。
- 差异：rotor 边框 clark 恒 #dfe4e9（都有 data-health）/ 天枢 #1d1d1f1f；hover clark 仅阴影 `0 3px 10px #1d1d1f0e`，天枢 边框 #1d1d1f2b + 阴影；clark 面用 HeroUI Card（flex column gap 0）。隐藏面 inert + aria-hidden + pointer-events none；reduced motion 无变换、隐藏面 visibility hidden；背面背景 `linear-gradient(155deg,#fff 50%,#f5f8fc)`。
- 背面环境光（翻转后 100ms 延迟 180ms 淡入）：clark **静态** 径向 `#a2bddf26` 于 17% 84%、`#c5c3e518` 于 86% 14%，第二层 `#b3d4d626` 于 76% 84%（CM:8-11）；天枢**动画** ambientDrift 26s / ambientReturn 34s + 更浓色 → 改静态。

### 2.8 卡头
- 容器 flex center gap 12（≤1100 6）min-height 30；下距 clark 正面 0 背面 5；天枢都 5。clark 皇冠或引用钮 margin-left auto 把 [皇冠][引用][翻转] 推到右侧；天枢都没有 → **翻转钮紧跟标题**（应推到右侧）。
- 标题：clark 正面 HeroUI ghost `.title` 含 h2 + ChevronRight 14（#8c98a6 opacity .35 无 hover 变化），点击开战场详情；背面纯 h2。天枢两面纯 h2。h2 20/600/1.4/-.025em，≤1100 18，clark ≥1800 22。
- 皇冠（clark；天枢可用 ownerId 对 /api/people roles 判断 → 新增调用；目的地页面不存在）：28×28 radius 9 透明 #748092；Crown 17 stroke 1.65；hover/focus 背景 #eaf0f9 色 #35699f 160ms；focus outline 2px #5a97dd offset 2；aria「你兼任{name}的战场 DRI，打开进展」；tooltip「你兼任这个战场的 DRI」。
- 翻转钮：
| 属性 | clark（HeroUI Button sm secondary） | 天枢 |
|---|---|---|
| 高 | 32 | min-height 32 |
| padding | 0 12（≤1100 6） | 6px 9px |
| 圆角 | 药丸 30 | 9 |
| 字 | 14/500 | 12 |
| gap | 8 | 5 |
| 图标 | 16（ArrowLeftRight / ArrowLeft） | 15 / 14 |
| 背景 | --default ≈#f3f3f5，hover ≈#e8e8e9 | #f1f3f6 … |
| 字色 | #3C66BF | #626873 |
| 按下 | scale(.98) 250ms | 无 |
- 背面紧急数徽章两边相同：16px radius 8 背景 #c43e3412 字 #b6342c 10px。

### 2.9 正面主体
- clark 战场总结块：NOT-BACKED 且被禁止（健康/状态/headline）。
- 天枢上下文块（独有，保留，按 clark 样式语言）：「负责人 · {name|待指派}」12px #6e6e73；Missions 胶囊（背景 #e8f1ff 字 #0a5dc2 radius 7 padding 4px 7px 12/600，Flag 11 + chevron 11 打开时**不旋转**）→ 内联列表 max-height 132；「六个月目标 · …」12px #5b6472 两行截断。注：契约注释与设计文档 §2.4 说目标属于**正面**。
- 议题区：clark `role="region"` aria-label「{name}议题列表」`margin:0 -6px; padding:0 6px; overflow:visible`（卡随内容长高）；`.directIssues` margin-top 8，共用行样式 padding `4px 0` **无分隔线**。天枢 `.list` 卡内滚动 margin-top 8 分隔 #1d1d1f0d；行 `.listButton` padding 9px 0 14/1.6 hover #f5f5f7 **无侧扩**；箭头 #8c98a6 仅 hover .8（focus 不显示）；点色内联；滚动列表贴边导致 4px 外偏 focus outline 左右被裁。
- 空态：clark `p.empty` 12px #77777c；天枢 `p.missing` 规则写错（`.missing p` 匹配嵌套 p）→ 显示为 **14px 深色**（bug）。

### 2.10 背面主体
- clark 三环/状态药丸/进展看板/反馈与依据：三环、状态、看板 NOT-BACKED 且禁止；「反馈与依据」部分可由 latestFeedback 支撑（样式可借用）。
  - 反馈与依据 disclosure：按钮行 min-height 28 11px #717882，「›」打开时旋转 90° 160ms，右侧「上次收集：{collectedAt}」10px #92969e；弹层 left/right 16 bottom 49 `max-height: calc(100% - 110px)` border #dce2ec radius 12 背景 #fffffff5 blur(12px) 阴影 `0 8px 30px #20305018` padding 12px 14px，opacity 160ms / translateY(5px→0) 200ms；Escape 关闭并阻止冒泡。
- 天枢背面（独有，保留）：当月战场结果 / 普通待办 / 最新负责人反馈；块标题 12/500 #777d88；待办卡 背景 #f5f7fa radius 10 padding 9px 11px；主体滚动，页脚注释固定底部；`dueAt`、`observedAt`、`sourceRef` 原样打印 ISO/内部引用（bug：应格式化）。

### 2.11 公司能力
- clark：栅格格子 padding `21px 22px`（≥1800 `24px 28px`，≤1100 17）gap 10 背景 #fbfcfd；标题 HeroUI 按钮 width auto min-height 30 gap 8；h2 20/600/1.4/-.025em（≤1100 18）；ChevronRight 14 紧贴文字 opacity .35 hover 不变亮；点击开能力详情（天枢无页面）；右上引用 top 22 right 23；固定分类 **产品 / 技术 / 综合**，只显示有可见议题的组：section aria-label「{name}能力建设议题」padding `12px 0 8px` border-top 1px #1d1d1f0f；h3 12px #73777e 500 下距 5；行 padding `5px 0`；右列格子一列 gap 0；满行格子 `auto-fit minmax(250px)` 列距 25（:84-87）。
- 天枢：独立 section padding `22px 26px` min-height 124；h2 + 分隔线；**每个已登记能力一组（即使无议题）**：h3 code 胶囊 + 名称 + 组标签；**六个月结果**；「Mission · N」→ /missions?capabilityId=；议题行或「暂无待决策议题」；组栅格 `auto-fit minmax(220px)`，左边框 #ccd2dc66。
- **天枢与 SSOT CEO-01 冲突**：「「公司能力」首页卡只列与能力建设相关的议题，不直接摆能力域的目标」。分组依据（`CapabilityCardPayload.group` 分类 vs 按能力）需决定。

### 2.12 clark 独有其他：演示更新、「演示」标记、重置 → NOT-BACKED。
### 2.13 字号：clark .shell title 20 / body 14 / meta 12 / note 11；≥1800 **22/16/13/12**；≤1000 title 18。天枢无 ≥1800 档，行字固定 15。

## 3. 交互
| 触发 | clark | 天枢 |
|---|---|---|
| 战略标题 | 原地打开战略 view，整块 `[data-origin]` 面板形变为详情 | 不可点 |
| 雷达磁贴 | 原地开雷达 view，同形变 | `router.push('/radar')` |
| 雷达议题行 | 开雷达 view 并选中信号、标记已读；形变起点是雷达磁贴 | 天枢为普通议题 → /issues/:id |
| 议题行 | 原地开议题工作区，`[data-home-issue]` 挂 notice-card | /issues/:id |
| 战场标题 | 开战场详情（待决策面） | 不可点 |
| 皇冠/进展看板 | 开战场详情进展面 | 无 |
| 翻转钮 | 只翻这张（单卡覆盖）；useLayoutEffect 把焦点移到另一面对应按钮（progress-card.tsx:37-43） | 同（BattlefieldCard.tsx:27-32） |
| 模式切换 | 设全局模式清覆盖；方向键 | 同逻辑；仅 Tab |
| 引用钮 | 切换全局对话引用；stopPropagation | 无 |
| 反馈与依据 | 开/关弹层；Escape 关 | 无 |
| Missions | 无 | 内联列表或 /missions… |
转场与焦点见 05 报告 §3；天枢来源取按钮矩形而非 `[data-origin]` 卡片，1500ms 过期；无返回动画与焦点还原；首页在 view 打开时 inert + aria-hidden（workspace.tsx:586）。

## 4. 后端支持
| 功能 | 状态 |
|---|---|
| 战略议题列表 | ALIGN |
| 战略标题 → 详情 view | 无页面，需决定 |
| 紧急颜色与可访问名（含黄色） | ALIGN |
| 议题行会议时间 | MISSING-BUT-BACKED（首页集合里已有 scheduled 会议卡，纯前端映射） |
| 「 · 会见中」 | NOT-BACKED |
| 议题行引用钮 | MISSING-BUT-BACKED（选择状态目前在 ConversationDock 内） |
| 面板/战场卡/能力面板引用 | NOT-BACKED |
| 首页回执 | NOT-BACKED |
| 雷达磁贴与未读数 | ALIGN |
| 「正在扫描」 | MISSING-BUT-BACKED（lastRun.status running；首页只取一次） |
| 雷达回波点、启动 chevron、布局 | ALIGN（纯视觉） |
| 模式切换/翻转/单卡覆盖/紧急数 | ALIGN |
| 战场标题 → 详情 | 无页面（API：「战场没有独立页面」） |
| 皇冠 | 指示器 MISSING-BUT-BACKED（需 /api/people）；目的地 NOT-BACKED |
| 战场总结块、三环、状态药丸、进展看板 | NOT-BACKED 且禁止 |
| 反馈与依据 + 上次收集 | 部分支撑（latestFeedback） |
| 演示更新/演示标记/重置 | NOT-BACKED |
| 能力分组 产品/技术/综合 | 可用 `group`，歧义 |
| 能力标题 → 详情 | NOT-BACKED |
| 战场上下文块、背面目标/待办/反馈/无百分比注释、决定期限、雷达影响预览、Mission 入口 | TIANSHU-ONLY |
| 能力六个月结果 / 列出全部能力 | TIANSHU-ONLY，与 CEO-01 冲突 |
| ≤1000 显示看板 | TIANSHU-ONLY |

## 5. 文案
| 位置 | clark | 天枢 |
|---|---|---|
| 战略空态 | 暂无待决策议题 | 暂无跨战场待决策议题 |
| 战场空态 | 暂无已核验的待决策议题 | 暂无待决策议题 |
| 能力空态 | 暂无待决策议题（无组有议题） | 暂无需要关注的能力建设议题；每个能力下 暂无待决策议题 |
| 雷达状态 | 正在扫描 / {n} 条未读 / 看看外面的变化 | {n} 条未读 / 看看外面的变化 |
| 黄色可访问名 | 需在窗口内决策：… | 待决策：… |
| 行第二行 | {M/D HH:mm}[ · 会见中] | 决定期限 {YYYY-MM-DD} |
| 工具条 | 战场 · 待决策 / 进展 | 战场 · 查看 {n} 个 Mission · 待决策 / 进展 |
| 共同 | 公司战略议题、雷达信号、公司能力、进展、待决策、查看{name}进展、返回{name}待决策、{n} 条紧急议题、战场展示方式 | 同 |

## 6. 待定
- 能力面板：CEO-01 支持去掉能力目标、隐藏无议题能力；分组依据待定。
- 皇冠/战场详情/战略与能力详情：CEO-01 与 C-01 要求，但天枢无页面。
- 三环/总结/状态药丸：CEO-01 要求，天枢文档 §2.4 与 API 明确排除 → 不加。
- 天枢目标放哪面：契约与文档说正面；天枢现在在背面。
