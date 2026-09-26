# 对照报告 03 · 对话（clark-main → Tianshu）

来源：2026-09-23 只读对照（agent），参照 clark-main v0.169.0 `src/components/ceo-warmap/*`，目标 `apps/web/src/conversation/ConversationDock.tsx`。

## 最大差距
- 天枢没有语音入口、没有键盘/语音切换。
- 历史：天枢是浅色模态三栏窗口；clark 是从输入条升起的深色非模态阅读面。
- 二级页：天枢每页自带侧栏+独立输入框；clark 把同一条全局输入条移入右侧 rail（页签 天枢 / 同事）。
- 对象页输入框里按 Escape 会跳回 `/`（违反 C-06）。
- 发送失败前就清空了输入和引用（违反 C-04）。
- 切换会话后旧流继续写入新会话（违反 C-03）。

## 0. 待定
- D1 参照哪条输入条：(a) `workspace.tsx:614-640` CEO 首页输入条（布局/caption/历史/引用）；(b) `conversation-composer.tsx`（二级页复用、语音「未接入」态）。语音层按 (b)，其余按 (a)。二者差异：最大高 196 vs 224、展开阈值、语音按钮是否可点。
- D2 会话/附件只有天枢有；clark 每个上下文一条连续线程。后端默认会话 `/api/conversations/:scope/messages` 正好对应。
- D3 流式：clark 不显示半截回复（思考行→完整回复）；天枢流式渲染。SSOT 未规定。
- D4 天枢测试编码了旧设计，对齐后会失败：`ConversationDock.test.tsx:129-131`、`:151-162`、`:164-180`；`signalReader.test.tsx:59-72`。

## 1. 结构对照
| 元素 | clark | 天枢 |
|---|---|---|
| 输入条层 | `div.layer[data-testid=global-controls]` 带 data-conversation-context / data-detail-context / data-has-references / data-history-open / data-composer / data-scoped-context（workspace.tsx:614） | 同名但无 data 属性（ConversationDock.tsx:923） |
| 「在全局讨论 · N」 | `.contextLabel.referenceContext`（:615-617） | 无 |
| Caption | `.caption` 可点正文 + X（:618-621） | 仅错误/流式时单按钮（:925-933） |
| 条体 | `.dock` typing/composerExpanded/thinking + data-mode + 内联高度（:622） | 恒为 keyboard（:654） |
| 引用托盘 | 条内 ReferenceTray（:623） | 条外兄弟节点（:539-571,:924） |
| 历史按钮 | 条内第一个（:624-626） | 仅浮动变体且历史关闭时（:655-665） |
| 键盘/语音切换 | 有（:627） | 无 |
| 按住说话 | `.voiceLayer>.holdButton`（:629-634） | 无 |
| 文本输入 | `.textLayer>form>HeroTextArea`+发送（:635-637） | form>textarea+发送/停止（:666-697） |
| 附件 | 无 | 历史窗口内回形针（:625-651,:698） |
| 引用选择器 | 无（卡片上的引用按钮添加） | Link2 + 深色列表（:699-734） |
| 历史层 | ConversationHistorySheet 非模态 section[role=dialog] + backdrop（:604,:611-613） | ExpandedConversationDialog 原生 dialog showModal，三栏（:112-234） |
| 消息 | ConversationTurn/MessageReferences/来源 details | 每条带可见「CEO/WarMap」角色行（:738-765） |
| 思考态 | ConversationThinking：脉冲点+阶段+秒数+停止 | 仅 `正在查证：{tool}`（:763） |
| 二级页右列 | TopicConversationRail：页签 天枢/同事、上下文行、日志、移动端触发+遮罩；全局输入条移入 rail 底部 | ConversationDock variant=sidebar 独立输入框，可折成 54px |
| Co-Agent 显示区 | CEO rail 不用；DRI 会议/邀请、Mission Card 页用 | 无 |

天枢各页放置：HomeShell 浮动 global；CardPage 仅 dock 时浮动；/plans、/missions/[id] 浮动；/radar 浮动但 scope=global label=雷达信号；/issues/[id]、/meetings/[id]、/radar/signals/[id] 嵌入侧栏。

## 2. 逐项
### 2.1 层位置
clark（conversation-dock.module.css）：fixed z1000；`right: calc(var(--shell-edge,14px) + 16px)`，`bottom:30px`，`width: calc(100vw - var(--main-start) - var(--shell-edge) - 32px)`（:1-14）；`justify-content:flex-end; align-items:flex-end`（:144）→ 语音药丸在主区右下。键盘态居中 `margin-right: var(--composer-shift)=(100% - composer-width)/2`（:35-36）。composer 宽 560；≥1800 为 620（:116）；≤1000 为 100%（:117,:298-300）（JS 在 ≥1800 估 600，CSS 620，存在不一致）。right/width 360ms cubic-bezier(.2,.8,.2,1)（:130）。历史打开（≥691）内缩 `--chat-inset=clamp(16px,1.6vw,36px)`（:131）。≤690：`right:16px;width:calc(100% - 32px)`，bottom `calc(12px + env(safe-area-inset-bottom))`（workspace.module.css:217-218）。带 rail 的二级页（≥760）：`right: calc(var(--shell-edge)+16px)`，`width: calc(var(--topic-rail-width) - 32px)`，`bottom: calc(var(--shell-edge)+20px)`，z106，composer 100%，同事页签时隐藏（workspace.module.css:236-237；移动端 :245-247）。
天枢：居中 `left: calc((100vw + var(--main-start) - var(--shell-edge))/2)`，`width:min(620px,…-32px)`，translateX(-50%)（:1-13,:83）；≤1250 `calc(70vw - 40px)`（:75）；≤690 `left:50%;width:calc(100% - 30px);bottom:max(17px,safe-area)`。

### 2.2 条体
clark（最终值，覆盖块 :272-288）：高 56（`.layer .dock{min-height:56px;height:56px}` :280）；padding 5，gap 5，border `1px solid rgba(255,255,255,.88)`，radius 26，背景 `rgba(248,248,250,.97)`；阴影 `0 4px 18px #1d1d1f12, 0 0 0 .5px #1d1d1f12, inset 0 1px 0 #fff`（:16-32）；过渡 height 260ms，width/margin-right 340ms cubic-bezier(.22,1,.36,1)，颜色 220–260ms。语音态 width:auto，内容盒 136（:281-282），总宽约 246。键盘态 `width: var(--composer-width)`。多行：display:block，高 = composerHeight+12，composerHeight=clamp(76, scrollHeight, 196)；含 `\n` 或 canvas 测宽 > max(80, textarea.clientWidth-24) 时展开（workspace.tsx:452）。多行时控件贴底：历史 left5/bottom5；切换 left54/bottom5；发送 right5/bottom5 44×44；textarea padding-bottom 54；底部 56px 渐隐（:167-181,:285-288）。有引用：宽 100%，min-height 96，padding-top 45，radius 23，阴影 `0 3px 18px #2437510c, inset 0 1px #fff`（:146,:284）。历史打开变深：`rgba(49,49,52,.98)`，border `rgba(255,255,255,.11)`，文字 #f5f5f7，图标 #b8bec7，禁用发送 #48484c/#85858c，可用发送 #0a84ff（:149-164,:182-184）。二级页/历史阴影 `--detail-composer-shadow: 0 8px 24px #45423d21, 0 2px 6px #45423d14, 0 0 0 .5px #827e7638, inset 0 1px #fdfdfb`（:221,:264-265）。材质：`material:monthly*` 香槟 `linear-gradient(115deg,#eeece7,#f5f4f0 48%,#eeeceb)`（:222-238）；`material:preflight-*` 蓝/薄荷（:246-261）。移动中 data-moving：无过渡无模糊，背景 #f8f8faf5（历史开 #313134f5）（:189-190）。含 reduced transparency / higher contrast / reduced motion（:119,:127-128,:307-308）。
天枢：恒键盘形；宽 340（≤1000 为 280），高 52，padding 6，gap 6；阴影更重 `0 16px 40px #1d1d1f26, 0 4px 12px #1d1d1f18, …`（:15-31）；内容盒固定 38（:54），无自动增高；`.composerExpanded/.typing/.modeButton/.leadingButton`（:118-132）无元素使用；`[data-has-references]`（:101）从未设置。历史窗内：高 56 radius 28 背景 #f7f8fa 无阴影；侧栏内：高 44 radius 22。

### 2.3 历史按钮
clark（:624-626,:530-533）：HeroButton ghost icon-only + tooltip（concept-control.tsx:8-10）；aria-label/title `查看“{contextLabel}”的对话记录` / 打开时 `收起当前对话记录`；aria-expanded；History 20/1.7，CSS 渲染 18（:121）；44×44 圆；色 #737780，hover 背景 #1d1d1f08 色 #202125，按下 scale .93，focus `2px solid #3A83F788` offset 2（:39-56）。二级页且为本页 scope 时改开 rail 的天枢页签（移动端展开 rail）（:385-391）。
天枢（:655-665）：38×38，图标 16，无 aria-expanded、无 tooltip、无切换文案，仅浮动变体。

### 2.4 键盘/语音切换
clark（:627）：背景 #ffffff95，阴影 `0 1px 4px #00000006`（:63）；aria-label `切换键盘输入` / 键盘态 `切换到按住说话`（Composer 为 `切换到语音入口`，conversation-composer.tsx:110）；tooltip `切换到键盘输入` / `语音暂不可用，使用键盘继续` / `切换到按住说话`；键盘/话筒图标交叉淡入：opacity 200ms，transform 320ms cubic-bezier(.22,1,.36,1)，scale .65 ±12°（:65-69）；监听时 5px #007aff 点（:64）；进入键盘态聚焦 textarea，离开回焦到切换钮（:431-442,:451）。天枢：无。

### 2.5 语音层
clark CEO 条（:629-634,:534-560；CSS :78-98,:274-276,:283）：蓝药丸 #3A83F7 白字 15/600 radius 22 padding `0 22px 0 18px` gap 8 撑满；hover #3479e6；failed 背景 #e4e7ec 字 #5f6572；busy #2a2a2e；文案 `按住 说话`/`连接中`/`松开 发送`/`发送中`/`语音未接入`/`正在回答`/`松开 取消`/`停止回答`（Square 16）；aria-label `停止本次回答`/`语音未接入，改用键盘`/`松开 取消`/可见文案；failed 后点击或 Space/Enter 切到键盘。
clark Composer（缺语音的样板，:115-122）：HeroButton `data-failed={!busy}` `isDisabled={!busy||!onStop}`；文案 `语音未接入` / busy `停止回答`；aria-label `语音未接入，请切换键盘输入` / `停止本次回答`。
规格：语音无后端 → 只用「未接入」态，绝不请求麦克风（SSOT C-07、AC-19）。

### 2.6 输入框与占位
clark（:636；CSS :100-105,:118,:304）：14/20，padding 7，高 34，最大 196，色 #282c32，caret #007aff，placeholder #9197a0 14px，无滚动条；≤690 字 16、placeholder 12。占位顺序：有引用 `围绕引用的卡片，聊聊你的判断…`；二级页 `继续聊聊…`；（议题/信号/材料/战役专用文案实际不可达）；否则 `输入你的想法…`。aria-label 全局 `全局对话输入`，否则 `{contextLabel}对话输入`。
天枢：浮动 `输入你的想法…`；历史 `问天枢：可引用 Issue、Meeting、计划、Mission、战场、能力与 Radar，或拖入文件…`（承诺了后端不支持的引用类型）；侧栏 `问点什么…` / `问天枢：本条信号…`；aria-label `公司全局对话输入`。

### 2.7 发送/停止
clark：44×44 圆，背景 #007aff，border #006de5，阴影 `0 2px 7px #007aff38`，ArrowUp 19/2 渲染 17，按下 .91；禁用 #e0e4e9 / border #d8dde4 / 图标 #939ba6；aria-label `发送` / 空时 `输入内容后发送`；data-ready。Composer busy 时换成停止 Square 16 `停止本次回答`（:138-142）。
天枢：30（侧栏 34、历史 38），图标 14；禁用 #f1f3f6/#e6e9ed/#8e9099；停止为 X 17 `停止本轮回答`。

### 2.8 Caption 气泡
clark（:618-621；CSS :111-115,:193-218,:292-297,:305）：有 caption/语音错误/回答中且未关闭、历史未开时显示；显示最后输入或最后回复；回退 `正在快速查证…`/`正在整理回答…`/`正在思考…`。absolute `bottom: calc(100% + 9px)`（有「在全局讨论」时 +62px），右对齐跟随 --composer-shift；`min-width:min(220px,100%)`，`max-width:min(720px,100%)`；背景 #242831e8，border #ffffff25，radius 18，13/1.65，blur(20px)，淡入 220ms；正文为按钮 padding `10px 42px 10px 14px`，`max-height:min(58dvh,520px)` 可滚，pre-wrap 不截断，aria-label `查看“{contextLabel}”的完整对话记录`，文字 aria-live=polite；关闭钮 27×27（44×44 热区）top/right 7 `关闭本次对话气泡` X15；≤690 `max-height: calc(100dvh - 180px - env(safe-area-inset-bottom))`；切换上下文时清空。
天枢：居中，只在错误（role=alert）或流式时显示，流式截断 90 字，无关闭钮，完成即消失。

### 2.9 引用
clark 模型（card-reference.ts）：`{id,title,kind,content,source}+capturedAt`；MAX 16；各字段长度上限；超限 4 秒 toast（role=status + Check）：`最多同时引用 16 张卡片。` / `这张卡片内容较长，请引用其中的具体事项。`。卡片上的引用按钮（card-references.tsx:16-28）28×28 radius 9 Quote/Check 14，aria-label `引用到全局对话：{title}` / `取消引用：{title}`，tooltip `引用到全局对话` / `已引用到全局对话 · 点击移除`。引用只属于全局对话；二级页隐藏托盘改为 chip `在全局讨论 · {n}`（ArrowUpRight 12，aria-label `在全局讨论已引用的 {n} 张卡片`，tooltip 标题换行拼接，点击打开全局历史；CSS 色 #4b6e99 11/18 min-height 44 padding `9px 12px`）。托盘：条内 absolute top8 left/right12 高 28；chip 高 26 radius 8 border #8d9aaf25 背景 #e8ecf27a，标题上限 190（≤690 为 145）11/16；点标题切换预览（深色面板 #292d35f7 radius 20 `max-height:min(48dvh,400px)`，显示 kind/h3 标题/source/pre 内容，关闭 `关闭引用预览`，Escape 先关预览）；chip X `移除引用：{title}`；多于一个时 `清空引用`。带引用发送跳过本地指令并打开全局历史。已发消息快照：`引用了 {n} 张卡片`，每项 标题 + `{source} · 发送时快照` + pre。其他预填：议题划词 `关于“{text}”，`；战役 `关于{campaign.name}，`。
天枢：`{cardId,version}`，仅 issue/meeting/monthly-plan/mission；无前端上限（API 上限 20）；Link2 选择器；chip `{title} v{version}`，点标题=移除，无预览；托盘在条外重叠；历史窗「本次引用」栏；引用只存在本页组件实例，无跨页篮子，卡片上无引用按钮。

### 2.10 历史层
clark（conversation-history-sheet.tsx；workspace.module.css:3,:15,:90-118,:219-225）：非模态 section[role=dialog][aria-modal=false]，aria-label `{context}的对话记录`；fixed z100；`left: calc(var(--main-start) + var(--chat-inset))`，`right: calc(var(--shell-edge) + var(--chat-inset))`，bottom 16，`height: calc(100dvh - clamp(72px,10vh,136px) - 16px)`；背景 #252527，border #ffffff24，radius 28，阴影 `0 24px 80px #10101826, inset 0 1px 0 #ffffff0b`；从下方 18px 升起 240ms cubic-bezier(.2,0,0,1)；backdrop 按钮 `关闭对话记录` 色 #25252712 radius 24 淡入 180ms z90；把手 36×4 #b3b6bc61；页头 padding `16px 26px 19px`：TianshuMark 27、小字 `独立对话 · {context}`（11px .06em #9ca6b6）、h2 `天枢` 19/600；页头按钮 44×44 圆 背景 #ffffff12 色 #cdd4df：静音 `静音模型声音`/`取消静音`（无后端，应省略）、收起 `收起对话记录` ChevronDown 24；正文 padding `28px 36px 130px`，内容最大宽 720（≥1800 为 800）16/1.8；重工作区浅色：月度 `#fffcf5 → #fff → #f7f1e4`，会议 `#eef3f5 → #f7f9f8 → #eaf0ed`（:107-118）；移动端二级页 left 62，首页 8。空态：全局 `从你正在想的事情开始。` + 两条建议（ArrowUpRight 16，p 21px，建议行满宽 padding `15px 0` 底边 #ffffff1a）；其他 `从“{contextLabel}”里你最想弄清的地方开始。`。
天枢：原生模态 dialog，居中 `min(1273px,…)×min(885px,…)`，浅色，三栏（会话 260 / 对话 / 本次引用 360），删除确认弹窗，空态统一且样式类未定义，无建议。

### 2.11 消息
clark：article data-chat-role，aria-label `你`/`天枢`，无可见角色行；15/1.85（≥1800 16，≤690 14）；助手 #ececef 下距 34；用户药丸最大 82% padding `11px 19px` radius 22 背景 #ffffff12；Markdown 标题 17；助手 meta `用时 {n} 秒`（tooltip `本轮处理的实际用时，包含模型生成、检索与服务等待`）+ `· 已查证 {n} 个来源` 等；来源 `查看来源 · {n}`（无后端）；浅色：助手 #25282e，用户 #1d1d1f0a（月度 #f1ece1，会议 #e3eae8）。
天枢：13/1.7，可见 `CEO`/`WarMap`，引用 `来源 {n} 张 Card`，消息附件未渲染。

### 2.12 思考态
clark：脉冲点 7×7 #c5cedc 1.8s；role=status `正在思考`/`正在快速查证`/`正在整理回答`；秒数 `{n} 秒`（tabular，#85858f，每 500ms，最小 1）；`停止`（aria-label `停止本次回答`）12px padding `6px 10px` radius 9；行 gap 9 13px #aaaab5 min-height 30 margin `4px 0 30px`；按住按钮同时变 `停止回答`。
天枢：只有 `正在查证：{工具原名}`（泄露内部工具名）。
后端映射：无事件=thinking；`tool:started` 后=researching；首个 `message` 后=answering。

### 2.13 二级页 rail
clark（topic-conversation-rail.tsx；workspace.module.css:229-247）：fixed top/right/bottom = --shell-edge(14)；宽 --topic-rail-width 360（≥1600 400；760–1000 310）；radius 22（760–1000 为 20），背景 `var(--tianshu-reading-surface,#fdfdfe)`，border #e1e5eb，阴影 `0 3px 18px #23354b05`，z105；主区让出 rail 宽+12；桌面不可折叠；按对象 key 重挂载；aria-label `当前议题对话` data-tone=light。页头 padding 12 底边 #e9ebef：页签 `天枢`（Sparkles 16）、`同事 · {n}`/`指派并对话`（Users 16），min-height 44 14px；≤759 显示 X `收起议题对话`。上下文行 12/1.65 #7c828c 两行截断 padding `15px 22px 12px`。日志 role=log aria-label `与天枢的议题对话`。空态：Sparkles 27；h2 `先一起想一想。<br/>有了方向，再请同事加入。`（21/500）；p `资料就在左侧。你的判断、疑问和讨论，都留在这件事里。`；按钮 `这件事，最值得先弄清什么`（发送 `这件事为什么值得现在研究？还有哪些关键问题需要弄清楚？`）。存储错误 `对话或草稿暂未保存，请保留当前页面。`。≤759：触发钮 `对话` / `对话 · {n}`（aria-label `展开议题对话`）fixed `bottom: calc(88px + safe-area)`；遮罩 `收起议题对话` #253a5925；rail 变 role=dialog aria-modal，焦点在 rail 与输入条间循环，Escape 关闭并回焦触发钮。同事页签仅浏览器本地存储（无后端）。
天枢：in-flow 栅格列 `clamp(340px,28vw,410px)`，可折 54px 竖排；页头有新建会话/会话列表/折叠；无页签、上下文行、空态、思考行；≤1280 堆叠到内容下方。

### 2.14 输入条跨上下文移动
clark：captureDock 记矩形 + data-moving（workspace.tsx:170）；layout effect FLIP `translate(dx,dy) scaleX(from.width/to.width)` → identity，origin `100% 100%`；打开 360ms cubic-bezier(.2,.8,.2,1)，关闭 250ms cubic-bezier(.4,0,.2,1)；reduced motion 跳过。天枢：路由切换即重挂载。

### 2.15 Co-Agent 显示区
CEO rail 不用；天枢无（/missions/[id]、会议页）。不在对话契约内，仅标记。

## 3. 交互语义
- Enter/Shift+Enter/IME：clark 检查 isComposing、keyCode===229、composition 标志；天枢只查 isComposing → 补齐。
- Escape：C-06 输入→浮层→对话→工作区。clark 全局：通知 peek→移动端 rail→键盘态（回焦切换钮）→历史→sheet→重工作区→雷达信号回列表→view。局部先处理：引用预览、移动端 rail。Composer：textarea 内 Escape 退出键盘态；IME 中只阻止冒泡。天枢 CardPage.tsx:56-65 任何 Escape（无 dialog 时）都 `router.push('/')`，含输入中、IME 取消，丢草稿。
- 草稿（C-03）：clark 按上下文 key 存 contextDrafts，切换时交换（:229-231），存 localStorage `tianshu-topic-agent-drafts-v1`（:238）。天枢一个组件实例一个 input，不持久。规格：localStorage 按 scope（+会话）存草稿。
- 发送失败（C-04）：clark 先本地写入用户消息再清空；失败文案：超时 `这次回答等待较久，已停止。你仍可以打开战场、查看目标或研究已有议题。`；其他 `对话服务暂时没有接通。页面操作仍可用；可以试试“看看灯塔项目正在研究什么议题”。`。天枢请求前清空输入和引用（:467,:474），API 在检查（404 scope、404/409 引用 `Card 引用版本已过期`、409 TURN_IN_PROGRESS（锁按 scope）、400 附件）通过后才存用户消息 → 这些失败丢输入。规格：SSE 200 开始前保留输入和引用，失败则恢复；REFERENCE_VERSION_CONFLICT 保留 chip 并标记需重选。
- 停止：clark abort + `已停止本次回答。`；离开上下文即 abort。天枢 abort fetch，服务端中止；但卸载/切会话/切 scope 不 abort → 旧流写入新会话，且锁仍占用导致 409。
- 历史焦点：clark 记住打开者并在仍连接时还原，打开不移焦（非模态）。天枢打开移焦到关闭钮，关闭总回到历史钮。
- 自动滚动：clark 历史打开时每条平滑滚到底，打开时跳到底，rail `block:'nearest'`。天枢从不滚动。
- 流式：clark NDJSON 阶段事件→完整回复；天枢 SSE `message` 增量渲染，忽略 usage/compaction/warning。

## 4. 后端支持
| clark 功能 | 状态 | 说明 |
|---|---|---|
| 每上下文连续历史 | ALIGN | 默认会话 GET/POST `/:scope/messages` |
| 发送 + SSE | ALIGN | message/tool/usage/compaction/warning/error/done |
| 阶段文案 | MISSING-BUT-BACKED | 由事件推出 |
| `用时 N 秒` | MISSING-BUT-BACKED | 实时计时；历史用 createdAt 差 |
| 来源 | NOT-BACKED | tool 事件无 URL |
| 停止 | ALIGN | 文案改 `已停止本次回答。` |
| 超时文案 | ALIGN（需映射） | TURN_TIMEOUT 180s |
| 失败文案 | MISSING | 错误码映射中文 |
| 卡片引用 | ALIGN（有差异） | `{cardId,version}` ≤20；issue/meeting/monthly-plan/mission |
| 引用预览/发送快照 | MISSING-BUT-BACKED | Card.payload / referencesSnapshot.payload |
| 跨页全局引用篮 + 「在全局讨论 · N」 | MISSING | 纯前端 |
| 字段/划词引用 | NOT-BACKED | |
| 每上下文草稿 | MISSING | 前端 localStorage |
| 按住说话/ASR | NOT-BACKED | 只保留「语音未接入」 |
| TTS/静音 | NOT-BACKED | 省略 |
| 本地指令 | NOT-BACKED | 原型启发式 |
| 同事频道 | NOT-BACKED | 若显示须写明未接入 |
| Co-Agent 显示区 | NOT-BACKED | |
| view/campaign/material scope | NOT-BACKED | 契约只允许 global/issue/signal/meeting/monthly-plan/mission |
| 会话列表/新建/删除 | TIANSHU-ONLY | 建议放 ConversationHistorySheet 的 headerActions 槽位，保持单栏阅读 |
| 附件 | TIANSHU-ONLY | 作为引用托盘里的 chip；默认会话也可上传 |
| usage/compaction/warning | TIANSHU-ONLY | 至多一行安静 meta |
| 消息附件 | TIANSHU-ONLY | API 返回但未渲染 |

## 5. 文案差异
| 位置 | clark | 天枢 |
|---|---|---|
| 全局输入 aria-label | `全局对话输入` | `公司全局对话输入` |
| 二级页占位 | `继续聊聊…` | `问点什么…` / `问天枢：本条信号…` |
| 有引用 | `围绕引用的卡片，聊聊你的判断…` | 无 |
| 停止 | `停止本次回答` / `停止回答` / `停止` | `停止本轮回答` |
| 停止后 | `已停止本次回答。` | `已停止，本轮没有保存 assistant 成功消息。` |
| 思考 | `正在思考` / `正在快速查证` / `正在整理回答` + `{n} 秒` | `正在思考…` / `正在查证：{tool}` |
| 历史页头 | `独立对话 · {context}` + `天枢` | `天枢 · 全局对话` + `作用域：首页 · 全公司` |
| 非全局空态 | `从“{label}”里你最想弄清的地方开始。` | `从你正在想的事情开始。` |
| 角色 | 不可见（读屏 `你`/`天枢`） | `CEO` / `WarMap` |
| 已发引用 | `引用了 {n} 张卡片` / `{source} · 发送时快照` | `来源 {n} 张 Card` / `{title} v{n}` |
| 移除引用 | `移除引用：{title}` | `取消引用 {title}` |
| Caption | `查看“{label}”的完整对话记录` / `关闭本次对话气泡` | 无 |
| 语音 | `语音未接入` / `语音未接入，请切换键盘输入` | 无 |
| 错误 | 见上 | `Conversation 发送失败` / `Pi Runtime 失败` / `Conversation 流在完成前断开` / 原始服务端消息 |
