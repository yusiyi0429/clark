# Claude Code「计划清单 + 在做什么那一行」调查（2026-11-16）

只读调查，没有改、没有运行任何安装包里的文件。解包用自写的只读脚本（按 asar 头读出 js/css 到临时目录）。

标注：**【代码】** = 在打包后的 js/css 里看到代码确认；**【推断】** = 从本人截图、命名或上下文推出来，没找到直接代码。

## 看了哪些

| 来源 | 位置 |
| --- | --- |
| 命令行版 2.1.318（Bun 单文件） | `C:\Users\10021\.local\share\claude\versions\2.1.318`（`~/.local/bin/claude.exe` 同一份） |
| 桌面版 5.11492.5.0（Electron，MSIX） | `C:\Program Files\WindowsApps\Claude_5.11492.5.0_x64__pzs8sxrjxfjjc\app\resources\ion-dist.asar`（网页前端，Code 页在里面，codename `epitaxy`）、`app.asar`（主进程） |

下文 `ion/` 指 `ion-dist.asar` 里的 `assets/v1/`。

## 1. 转圈动画

### 桌面版现在用的：「WorkingMark」位图动画 【代码】

- 工作那一行前面的图标是 `TurnStatusClayMark`：20×20、颜色 `var(--cds-clay)`（陶土橙），按 activity（`think` / `tool-use` / `default` / `blocked` / `sphere` 等）播一套 sprite sheet（`grow`、`*.in`、`*.loop`、`*.out`），用 `translateY` 一格一格换帧。
  - `ion/shared-41-DR3k7a1K.js`：`style:{...r,width:Rg,height:Rg,color:"var(--cds-clay)"}`，`"data-cds":"WorkingMark"`，`var ig=["sphere","default","think","blocked"]`，`import("./c8677db5f-CJKAHncR.js")`（素材）。
  - 素材没加载好或者要静止时，画一个实心小圆点：`p("span",{className:"absolute inset-0 m-auto block rounded-full bg-current",style:{width:Rg*Lg,height:Rg*Lg}})`（`Lg=.35`，约 7px）。
- 这套素材就是 Claude 的星形标志动起来，**天枢不能用**（本人要求不用 Anthropic 标志或图片）。

### 桌面版的字符转圈（ion 里还在，用于示意图） 【代码】

- `ion/c3a36db6f-BhoJgnuY.js`：
  `var r=["\u00B7","\u2722","\u2736","\u273B","\u273D"]`（· ✢ ✶ ✻ ✽），竖着排，每个字一行，`lineHeight:"2em"`，外框 `overflow-hidden`，默认颜色类 `text-clay-emphasized`。
- `ion/c6a992d55-k2XF_vDB.css`：
  `.code-spinner-animate{animation:1.2s step-start infinite codeSpinnerSpin}`，关键帧 0%→40% 每 10% 往上推一格（0、-2em…-8em），50% 停在最后一格，60%→90% 推回来——**1.2 秒一个来回，10 拍，每拍 120ms，跳格不过渡**。
- 这个组件只被两个营销示意图引用（`c9500abe8`「claude — zsh」假终端、`cc20c35ef` Chrome 介绍页），真会话里用的是上面的 WorkingMark。
- 这条 CSS 没有对应的减少动态效果规则（对比同文件 `.ph-fade` 有）。

### 命令行版 【代码】

- `2.1.318` 里：
  `p=["\xB7","\u2722","*","\u2736","\u273B","\u273D"]`，`f=[...p,...p.toReversed()]`（来回）；ghostty 终端用 `✳` 代替 `*`、最后一帧 `✻`。
- 帧间隔 120ms：`[c,o]=ll(t?null:120)` … `C=Math.floor(o/120)%_.length`。
- 减少动态效果（设置里关动画）时不转，画一个静止的 `●`：`if(t){let h; … h=e(n,{color:"text",children:"\u25CF"})`。
- 主转圈（带「Thinking…」的那个）颜色随状态渐变（`dS(z,P,PO(f))` 在两种 rgb 之间插值，出错时偏向 error 色）。

**天枢的做法**：用桌面版字符转圈那五个字和那条关键帧（1.2 秒、跳格、来回 10 拍），颜色换成站内强调色 `var(--accent)`；减少动态效果时停在第一帧「·」（相当于 Claude 的静止小圆点）。

## 2. 那一行的结构（桌面版 Code） 【代码】

`ion/c96d752d0-B7j9Y5kz.js`：`var Nmt="code-working-line"`，组件 `Pmt` → 行组件 `Jm`，参数：
`{state, label, statusAnnouncement, leading, elapsedSeconds, trailing, trailingAction, open, onOpenChange, busyStepKeys, children}`

- `leading`：前面那颗 WorkingMark。
- `label`：在做什么（见第 3 节）。
- `elapsedSeconds`：用时。
- `trailing`：用时后面的小字（token 数、正在思考的提示等）。
- `open / onOpenChange / children`：行尾可以展开（就是本人看到的「›」），展开里是这一段的步骤行（`steps.rows`）或这一步工具的详情（见第 6 节）。

## 3. 那一小段话从哪来、先后 【代码】

父组件 `B5`（同文件）算 label，先后是：

1. 系统状态：`Stopping…`、API 重试（`goe(...)`）、`Compacting session…`、`Sending…`（发送中那一刻）；
2. `spawnLabel`（开子会话、等人之类的专门文案）；
3. `toolLabel`：**正在跑的那个工具「说的话」**；
4. 都没有时：思考中 `Thinking…` → 15 秒 `Still thinking…` → 30 秒 `Thinking more…` → 45 秒 `Thinking some more…` → 60 秒 `Almost done thinking…`（`Emt`）；等待阶段 `Connecting… / Starting session… / Preparing… / Waiting for Claude… / Running tools…`（`A5`）；
5. 兜底 `Working…`。

```js
h = Fe ? "Stopping…" : Le ? (c===void 0 ? (we ? Te : _ ? "Compacting session…" : ne==="sending" ... ? g : void 0) : c) : void 0,
o = h ?? (Le ? b : void 0)          // b = toolLabel
```

「工具说的话」怎么来 【代码】：

- 每一行工具在跑时向一个共享对象 `say(...)`，**最新说的那一个算数**，那一行结束就撤掉、退回上一个（`ion/cb6930dae-BNuzgrUR.js`）：
  `say(e,t,n,r){return this.said.delete(e),this.said.set(e,{words:t,...}),this.showNewestSaid(),()=>{this.said.delete(e),this.showNewestSaid()}}`，`showNewestSaid(){let e=Array.from(this.said.values()).at(-1) …}`
  ——所以几件事同时在跑时，那一行写的是**最后开始的那件**。
- Bash / PowerShell 这一行说的话就是**执行方写在入参里的 `description`**，并把英文动词变成进行时（Run tests → Running tests）（`ion/c52b02f3f-DDgqUQlX.js`）：
  `case"Bash":case"BashTool":case"PowerShell":{let n=c("description") … let l=n?ar(n):void 0;return{… runningLabel:l?.running??n, doneLabel:l?.done??n …}}`
  没有 description 时退回命令本身（`meta: … i`，`metaIsCode`）。Task / Agent 也用 `description`；Read 是「Reading + 文件」，WebSearch 是「Searching web + 关键词」等。
- 本人截图里那句「看方案 A 测试具体哪一行没过」就是 Bash 的 description（中文不做动词变形，原样）。

计划清单里在做的那条（activeForm）：

- 桌面版 Code 的那一行**不用**计划条目当文字 【代码，按上面的先后里没有 plan】。
- claude.ai 的计划进度标题用「第一条 in_progress 的 activeForm，没有就 content」【代码，`ion/c8d25b7c4-B72ZmClv.js`】：
  `function NP(e){return e.status==="in_progress"?e.activeForm||e.content:e.content||e.activeForm}`，`PP` 里 `e.findIndex(e=>e.status==="in_progress")` 取第一条。
- 命令行版转圈那句话用在做的任务的 activeForm、没有就随机动词——【推断】（命令行版里看到任务存了 `activeForm:w??N?.activeForm??S??h`，但没追到转圈文字那一处）。

## 4. 用时 【代码】

- 从这一轮开始算：`k5` 里 `o=n??a`（`turnStartTime`，没有就取会话记的这一轮开始时间）；工具那一行接管时用工具开始的时间（`Lmt`：`t.startedAt`）。
- **满 2 秒才显示**：`Pmt` 里 `X = … N ? P : g>=2 ? g : void 0`；`B5` 里 `be=T>=2`。
- 格式：本人截图是「21m 11s」；同包里同类格式化是 `<60s → {s}s`，`<60m → {m}m {s}s`，再往上 `{h}h {m}m`（`ha()`：`"Thought for {minutes}m {seconds}s"`）【代码，是「Thought for」那条；工作那一行的 `J(m,i)` 没追到定义，格式按截图——推断一致】。
- 天枢沿用站内已有的 `duration()`（「N 秒 / N 分 M 秒 / N 小时 M 分」），不另起一套英文格式。

## 5. 计划清单里多条同时在做 【代码 + 推断】

- 状态允许多条 `in_progress`：桌面版处理 `update_plan` 的 `start` 只把那一条设成 in_progress，不清别的（`ion/cb27dab29-nJPglHF4.js`）：
  `V(t.start,n.length)&&(n[t.start-1]="in_progress")`；`advance` 只把第一条 in_progress 完成、下一条 pending 设成 in_progress。
- 每条各自按状态画：做完实心勾变淡、在做细圆弧转圈、没开始虚线空圈——【推断，来自本人截图；没找到清单行组件的具体代码】。
- 那一行放在清单**下面**：`ad({cardHoldsTail,planHoldsLoader,heldRedialReported}){return e?!t&&"card":t&&!n?"plan":!1}`，`setOutletUnderPlan(e)` ——这一轮有计划时，工作那一行挪到计划下面【代码，`ion/cb6930dae`、`ion/cf74bc599-B4BR9v3I.js` 的 `markedRowBelowTailSlot:ev({cardHoldsTail:Bs,planHoldsLoader:Is,…})`】。

## 6. 展开「›」看到什么 【代码】

- 工具那一行接管成工作那一行时（`Oze`），`Jm` 带 `open/onOpenChange/children:s`，`s` 是**这一步工具的详情**（命令输出等）。
- 普通工作那一行（`Pmt`）带 `steps`：`busyStepKeys:S?.busyKeys`、`children:S?.rows`——**这一段的步骤，一步一行**。
- 天枢的取法（最小）：子会话展开这一段过程的步骤（本来就有的一步一行）；伙伴 / 项目对话展开这一轮服务端报的步骤（`StepList`）；都没有就不给「›」。

## 7. 减少动态效果 【代码】

- 桌面版：`html[data-reduce-motion=true]` 或 `prefers-reduced-motion: reduce` 时工作那一行附近的动画都停（如 `.cc-working-dots>span{animation:none}`、`.epitaxy-thinking-shimmer` 停）；WorkingMark 收到 `reduceMotion` 停在静止的小圆点。
- 命令行版：画静止的 `●`。
- 天枢：`@media (prefers-reduced-motion: reduce) { .mark > span { animation: none; } }`，停在第一帧「·」。

## 8. 结束就消失 【代码】

- 那一行只在这一轮在跑时出（`isActuallyWorking`、`Le=!!Pe&&i&&!q`），停下时短暂写 `Stopping…`，结束后整行不画。

## 9. 天枢手上有什么数据（落实现时查的）

| 地方 | 有什么 | 取哪句 |
| --- | --- | --- |
| 子会话（本机事件） | `tool_call` 事件本来就原样带入参 `input`（`apps/local/src/agents/claudeCode.ts`：`input: clipInput(c.input ?? {})`），Bash / PowerShell / Agent 的 `description` 在里面；标题 `title` 是本机 `describeTool` 写的「运行 …」「读文件 …」。计划来自 TodoWrite，**本机发 plan 事件时把 activeForm 丢了**（只留 content、status）。 | 正在跑的那一步的 description → 那一步的标题；两步之间：计划里第一条在做的 content。**不用改本机程序和契约**：网页折事件时把 `input.description` 记进步骤。 |
| 伙伴 / 项目对话（对话流） | `step` 事件（label、status active/done…）、`tool` 开始时的 `label`（在查什么）、阶段 `stage`（connecting / offline / researching / answering…）、`plan` 事件（伙伴的 update_plan，content + status）、`startedAt`。 | 连不上 / 等网络 → 在跑的那一步 → 在查什么 → 计划里第一条在做的 → 阶段词（正在查资料、正在整理回答）；都没有只留动画和用时（不写笼统的「正在思考」，同站内 5.4.3 的规矩）。 |

没加的：activeForm。Claude Code 桌面版那一行本来就不用它；要用的话本机程序 `TodoWrite → plan` 那里和 `LocalPlanEntry` 契约各要多带一个可选字段，这次不需要。
