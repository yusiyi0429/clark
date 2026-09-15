# TKOS 前端（clark-main）交接 · 截至 2026-08-13 round 8

## round 8 增量（先读这一段，底下 round 7 那份仍然有效）

- **「带上会」整条链路删掉。** 落点档改叫 `direction`（战略方向判断）。会议议程改成算出来的：
  域里已产出 `direction` 判断的议题就在议程上。屏幕文案、参谋预设答复、系统提示词一并改过 ——
  再看到「带上会 / 提交上会」三个字就是漏网的。
- **潜在议题详情页 `/signals/[id]`**（`_views/signal-view.tsx`）：左 21rem 窄栏 = 动摇哪条判断的
  在版原文 + 预研没答上来的几条 + 三键处置；右主栏 = `ChatPane`。**这一页故意没有判断链路图**，
  理由写在 `signal-view.tsx` 顶部的注释和 `DECISIONS.md` K-3，别照着议题研究页给它补一个。
- **对话抽成 `components/advisor/chat-pane.tsx`**，两页共用；差异只有一个 `preface` 口子。
  导航条 `components/chat/thread-rail.tsx`（只标他的提问，少于 3 轮不出现）。
- **卡片入口**：`card-four-part.tsx` 的标题与 meta 行末尾那句都链到 `/signals/{issueId}`；
  首页小窗三条同理。`Card.preResearchAt` 为空 = 预研还在跑，此时不给链接。
## round 9 增量（判断链路图重做）

- **`probe-map.tsx` 整个重写。** 节点上只剩：判断句 + flag + 「细节 ▾」+「就这句聊 →」。
  **成色徽章（还不成熟 / 开始立得住）删了，别加回来** —— 理由见 `DECISIONS.md` L-2。
  图面上只留三个标记：方向判断 / 已写回本体 / 已放下。
- **细节里固定四问**：为什么扣着这件议题（`ProbeNode.whyOnTopic`）/ 忽略它会怎样
  （`ifIgnored`）/ 边界 / 引用（内部与外部分开列）。两个新字段目前**可选**，种子里九条都写了。
- **唯一留在图面上的依据信息是「什么都没有」**：`groundless`（knowledge 里只有 `agent`
  或为空）时写「参谋推断 · 没有外部依据」/「您记下的 · 参谋还没解读」。
- ~~**他自己能开一支**：报告原文划词 →「记成判断」→ `api.addProbeNode`~~
  **2026-08-20 撤掉了**（`DECISIONS.md` N-1）：划词只剩「引用提问」一枚，`addProbeNode`
  与溯源面板一并删除；`useSelectionQuote(ref)` 不再收工具条宽度那个参数。
- **汇报体是硬规矩**：point 落图时重写成向人汇报的一句话，判据是「单独摘出来发给一个没读过
  前面几轮的人，他能读懂」。写在 `ProbeNode.text` 的类型注释和 `instructions.ts` 里，
  种子里两条黑话已经照这条改过。
- **要看复杂链路图长什么样，去 `/issues/ISS-100`**（首页 →「已了结 N 件 →」→ 列表里点它）。
  新种子 `seed-launch.ts`：16 节点 / 5 条并列起点 / 最深 4 层，含一条 `dropped`（被参谋
  自己推翻、**留在图上**）、一条 `confirmed`（已写回 01-J1）、四条 `direction`、一条没有
  外部依据的、一条他自己划下来记的。**这一件的对谈转写是预置的**（`store.advisorThreads`
  破例带 ISS-100），因为图上每一条「您问」都必须在转写里查得到原话。
  ISS-106（贝壳案）保持原样 —— 它是当着他的面一轮一轮长出来的那个演示，不要预填。

---

- **链路图的知识关系折起来**（round 8；round 9 已并入「细节」面板）。
- **验证的坑（round 8 踩到）**：这个 Linux 沙箱**跑不了 `next build` / `next dev`** ——
  `node_modules` 是在 Windows 上装的，没有 Linux 的 SWC 与 tailwind/postcss 原生绑定；
  而且挂载不允许 `unlink`，`.next` 写不动（`EPERM: unlink`）。能跑的只有
  `npx tsc --noEmit` 和 `npx eslint <文件>`（`npx eslint .` 会超时，逐文件跑）。
  **要看真效果得在他自己机器上 `pnpm dev`。**

---

# round 7 交接 · 截至 2026-08-12

新窗口从这份文件接手。读完这一页就能继续干活，不需要翻旧会话。

---

## 0. 一句话现状

第 7 轮（Elios 的 12 条 UI 反馈）全部做完并验证通过，已写回
`C:\Users\10021\Desktop\clark\clark-main`。当前没有未完成的改动。

这一轮动的是结构，不只是样式：**顶栏从五格流程条改成两个大类**、**议题研究改成两栏
对半 + 覆盖式对话**、**全站统一一副字**、**新增追加调查（轻量深研）**。理由逐条写在
`DECISIONS.md` 的 H 节，改之前先读那一节。

---

## 1. 环境与位置

- 用户机器（真源）：`C:\Users\10021\Desktop\clark\clark-main`，通过 device bridge 读写。
- 云端工作副本：`/root/work/clark-main`（`~` 在这个容器里是 `/root`，不是 `/home/claude`）。
- **写回流程（round 7 踩过的坑）**：不要用 `SendUserFile` 逐个文件传（20 个文件 = 20 张
  文件卡）。打一个 tgz → `SendUserFile` → `device_commit_files` 落到 `clark` 根目录 →
  `device_bash` 解到 `/tmp` 再 `cat > 目标文件` 覆盖。
  **`tar -x` 直接覆盖会失败**（`Cannot open: File exists` —— 挂载不允许 unlink），
  `cat >` 可以。写之前先 `find src -newermt` 确认他没在本地同时改。
- `.env.local` 里有 `DEEPSEEK_API_KEY`，**故意不上传到云端**，继续保持不动。
- `src/app/fonts/*.woff2` 是两个品牌字体子集。**打包同步时不要漏掉它们** ——
  没有这两个文件，`pnpm build` 会以一条完全看不出原因的 Turbopack panic 失败
  （`Missing content when trying to generate the content hash for static asset`）。

## 2. 栈与硬约束

Next.js 16.3 App Router / React 19.2 / TS 5.9 strict / Tailwind 4 / shadcn（拷贝进仓）/ SWR / pnpm。

PRD-FE 硬约束 H1–H9，常踩的：H2 服务端说了算（不做乐观更新）、H5 不做 hover-only 操作、
H6 URL 可寻址、H7 不用浏览器存储、H8 不加载网络字体、H9 假数据只放 seed。

数据层在服务端进程内存：`src/lib/data/{types,seed,seed-tokenking,seed-agent-domain,seed-demo,store,client}.ts`，
模块加载时从 seed 克隆（房懂懂那几份演示种子 `seed-beike / seed-launch / seed-ontology /
seed-docs` 已删，见 `seed.ts` 头部）。**整页刷新不再清零**：每次 `/api/data` 调用后状态
排进落盘队列，落在 `.data/store.json`；只有种子指纹变了才丢弃快照从种子重建 ——
两条都在 `persist.ts` 头部。

## 3. 术语（改过好几轮，别用旧词）

- **两个大类**：议题（主页 `/` = 战略议题）、会议（`/meetings`）。「五个环节」这个说法
  已经废弃，顶栏里没有那条流程条了。
- 潜在议题（`/signals`）= 战略议题的上游，入口在主页左上角那个小窗。
- 议题研究（`/issues/[id]`）= 每件议题下面的一页，不是一个独立目的地。
- 把关区 = 议题研究右栏。**屏幕上不再写「把关区」三个字**（标题栏让给了两挡页签）。
- 议题拆分点 / 新潜在议题，两者统称 IR；带上会 / 纳入会前准备；打回重研；本体类 / 行动类。
- **追加调查**（round 7 新增）= 只针对一条拆分点的轻量深研，不是「打回重研」。

## 4. 议题研究页（当前形态）

`lg:grid-cols-2`，两栏对半，整页 `h-[calc(100vh-4rem)] overflow-hidden` —— **页面本身不滚**。

**这一页没有自己的 header。** 议题编号、标题、语音过一遍（话筒图标）、指派负责人全部长在
顶栏里 —— `components/advisor/issue-header.tsx`，由 `StageNav` 按 `/issues/[id]` 路由决定
渲染与否。两条 header 摞起来吃掉 168px，合并省下 ~90px 全给了正文。加东西进这一行之前先
想清楚砍掉什么。

- 左 `components/advisor/report-pane.tsx`：页签「深研报告 · CEO Agent」「承接研究 · DRI」
  「知识关系」。知识关系是**真图**：布局后量 `getBoundingClientRect` 画 SVG 贝塞尔连线，
  节点全文不截断；测量放在 ResizeObserver 回调里（不是效应体里，否则被
  `react-hooks/set-state-in-effect` 拦下）。
- 右 `components/advisor/ir.tsx` 的 `IrRail`：标题栏是三格网格
  `[5.5rem | 居中页签 | 5.5rem]`，左格空着是**故意的** —— 进到某一条的追加调查详情时，
  「返回」落在那一格。
- **对话是覆盖层**，不是第三栏：`absolute inset-0` 盖住右半栏，收起后变成右下角胶囊
  （`createPortal` 挂 body）。收起时组件不卸载，只是 `opacity-0 + pointer-events-none +
  inert`，所以流式回复不会因为收起而丢。
- 划词只做一件事：「引用提问」。报告、轻报告、**参谋在对话里说的话**、判断板
  （2026-08-20 加的）都能划，共用 `components/provenance/selection-quote.tsx`。
  ~~溯源那一枚按钮与 `trace-panel.tsx` / `api.advisorSources()`~~ 已删（`DECISIONS.md` N-1）
  —— 句子背后的来源还在句末那枚上标里（`trace-chip.tsx`）。
- 引用不塞进输入框，是输入框上方一排可删卡片（`quoted: string[]`）。

## 5. 追加调查（round 7 新增）

- 数据层：`api.startIrResearch(issueId, irId)` / `api.listIrResearch(issueId)`。
  任务存在模块级 `irJobs`，**进度按真实时钟算**（`Date.now() - startedAtMs`），
  视图只轮询、不自己计时 —— 自己计时的话切走页面会停住。
- 轮询：`IrRail` 里一个 `setInterval(700ms)` 问**全部**任务，不是一条一个轮询。
- 轻报告内容在 `seed-beike.irResearchDocs`（IR-106-c1/c2/c3 各一份，`irResearchEta`
  分别 96 / 54 / 38 秒）。没预写的走 `client.ts` 的 `fallbackIrDoc`：**不编内容**，只复用
  报告里已有的 Statement 和它自己的溯源。
- 卡片上「开始调查」= 开跑 + 进详情，一个按钮一件事。

## 5.5 首页的战略议题卡（round 7 追加）

- 卡片**只用两级字**：标题 15px、其余 12px。别再往里加第三级。
- 右半两行是两份研究：**自动深研**（机器）与**承接研究**（人）。任一份到手
  （`IssueSummary.canOpenResearch`）就允许进议题研究页；「进入议题研究」钉在参谋意见栏的
  标题行上，不随正文滚。
- 列表**只显示没了结的**（`settled`），已了结的走「已了结 N 件 →」进 `/issues`。
- 自动深研跑得完：`seed.runningResearch` 声明还在跑的轮次（进度按真实时钟算），
  `seed.pendingResearchDocs` 是它跑完交出来的报告，`client.ts` 的 `settleResearch()` 在每次
  读议题前把到点的装上。**规矩：有交付物才给进度条。** 没有预备报告的议题只说「在跑」——
  一个走到 100% 却什么也不发生的进度条比没有更糟。
- ISS-105 的那一轮：eta 480 秒、加载时已跑 340 秒，所以 demo 开场约 2 分 20 秒后它会当着
  他的面跑完、卡片翻绿、按钮亮起。要改这个节奏就改 `seed.runningResearch`。

## 5.4 主页版面（round 7 追加）

三栏变两栏：左边（潜在议题小窗 + 业务域）不变，**战略议题与参谋意见合成一块板** ——
2×2 网格，一条 header、中间一条发丝线（左侧两格带 `border-r`），两半各自滚。
「战略议题」是这块板的标题，顶栏上没有它了。域名不写第二遍（左列正亮着）。
`CounselPanel` 因此拆成 `CounselHeader` / `CounselBody` 两块，好落进同一条基线。
外层 `<section>` 必须带 `overflow-hidden`，否则圆角切不掉滚动内容。

## 5.6 议题拆分点的状态机（round 7 追加）

**只有两个出口：带上会 / 弃掉。** 点下去就是迁移，没有勾选态、没有第二颗提交按钮
（`queueOne` / `api.dequeueFromMeeting`）。把关区底栏只剩一句账 + 打回重研。
卡片上的动作按重量分三档（`Pill` 的 `solid` / `outline` / `quiet`）：实心=改状态且是主出口，
描边=次要出口或工具，无框=弃掉。往这一行加按钮之前，先想清楚它是这三档里的哪一档。

底栏有 `pr-[11.5rem]`：对话收起时那枚胶囊浮在这一栏右下角，不留位「打回重研」会被盖住。

## 6. 会议页（round 7）

`/meetings?stage=pre|post&domain=D-0x&id=ISS-xxx`。左边是**业务域**（与主页共用
`components/domain-nav.tsx`）—— 会是按域开的。

**会前准备**（`components/meeting/prep.tsx`）回答三件事：第几次会、议程齐了没、能不能开。
**议程是算出来的**（哪些议题带了拆分点上会），不是存下来的清单。没提交的那几件给一条
「去研究室 →」。议程为空时「开始会议」是灰的。开始 → `running`；散会 → `closed` 并生成闭环单。

**会后确认**：有等着签发的闭环单就是那份单子（`components/meeting/closure-sheet.tsx`），
没有就退回 `DecisionsView bare`。闭环单是四区（拍板/派发/未决/沉淀），
**从会前带上会的那些拆分点装出来**（`client.ts` 的 `buildClosure`）——不从转写里猜，
因为「带上会」在这个产品里是一次真实的状态迁移，每条拆分点自带去向、要翻的判断、
重开条件。装配补的字段标 `drafted`（琥珀「AI 补全 · 待核」），从对象搬来的标 `confirmed`。
圈除单条 = 转未决、其余照签；按住 1 秒落章，**签发后不跳走**，回执就地展开
（`invalidate` 时要把 `closure:` 开头的 key 排除掉，否则单子会被重挂、回执消失）。

`/issues/[id]/brief` 已改为 `redirect()` 到会议页。

## 7. 字体与排版（round 7 重做，别改回去）

全站**一副无衬线字**。`--font-serif` 是 `--font-sans` 的别名；`.report` 保留但语义变成
「阅读节奏」（更松的行高），不再是「衬线」；`.meta` 从等宽改成同一副字 + `tabular-nums`。
`--font-weight-medium` 被重定义为 **600**（微软雅黑没有 500，请求 500 会静默落到 400，
`font-medium` 在 Windows 上等于没写）。理由与实证来源写在 `globals.css` 的注释和
`DECISIONS.md` H-1/H-2。

`--text-read`（16px / 1.85）是报告正文那一档，只给要连读几分钟的东西用。

## 8. 验证回路（照做即可）

```bash
cd /root/work/clark-main
npx tsc --noEmit && pnpm lint && pnpm build
pkill -f next-server            # 必须单独一条命令，跟别的命令连写会 SIGTERM 掉自己（exit 144）
nohup /tmp/run-server.sh > /tmp/server.log 2>&1 & disown   # 端口 3101
cd /tmp/smoke && node shot.mjs && node pages.mjs && node probe.mjs
```

- `/tmp/smoke/shot.mjs`：主线九屏截图（主页 → 议题研究 → 知识关系 → 追加调查 → 对话
  展开/收起 → 会议两挡 → 返回主页）。
- `/tmp/smoke/pages.mjs`：16 条路由逐个开一遍，看状态码与 pageerror。
- `/tmp/smoke/probe.mjs`：追加调查全流程 + 轻报告划词引用 + 对话回复溯源。
- **DRI 链路**（信号上报 → 研究任务 → Commitment）的验证走一号位视角实跑，不是自动冒烟 ——
  仓库里没有 playwright 测试工具链，为一条在沙箱里跑不起来、CI 里也没有任何东西会去跑它的
  spec 引入整套依赖，正好撞在这个项目「如无必要勿增实体」上。
- `round2/3/5/6.mjs` 断在改过的旧文案上，**不是回归**，需要时用新文案重写。
- playwright-core，chromium 可执行文件在 `/opt/pw-browsers/chromium`
  （注意：是文件本身，不是目录，别写成 `/opt/pw-browsers/chromium/chrome`）。
- 划词要用 `mouse.down/move/up` 真拖选，`click({clickCount:3})` 选不出东西。

## 9. 已知坑（都已修，别改回去）

- **贝壳案是换血单元，同 id 以它为准。** `store.issues` 必须是
  `[...beike.issues, ...seed.issues.filter(不与 beike 同 id)]` —— 两份种子里都有 ISS-106，
  直接拼接会让 store 里躺着两条同 id 的议题（`findIssue` 取第一条所以逻辑一直对，但
  `/issues` 把整张清单铺出来时 React 就报 duplicate key）。别的 seed 字段是对象展开、
  同 key 天然覆盖，只有数组这一处要自己去重。

- `useInvalidate` 接「此刻在屏幕上的 key」（字符串或判定函数），这些 key 只重新去问、
  不清成 undefined —— 清了会让 AsyncBoundary 掉回骨架、整栏重挂，页签跳回第一挡。
- 报告里挂了沉淀的句子是 `<span>` + 一枚计数片按钮，**不要再整句包 `<button>`**。
- React lint `react-hooks/set-state-in-effect`：用渲染期校准，或者把 setState 放进
  ResizeObserver / setTimeout 回调，别在 effect 体里同步 setState。
- 任何「盖住全屏」或「fixed 定位」的东西都要 `createPortal` 挂 body：祖先带
  `animate-panel`（transform + fill:both）会造出层叠上下文，fixed 的基准会变成祖先。

## 10. 两个已定的产品判断（他问过，别再重新讨论）

1. **DRI 同步边界 = 分层**：同步两份研究报告 + 勾进会议清单的拆分点；不同步 CEO 的
   对话记录和未勾条目。理由：试探性的话直达 DRI 会被当成指令执行。
2. **衍生的新潜在议题 = 两处都在**：把关区保留出生上下文，同时以预研卡进潜在议题池并
   标出处；**只出预研卡，完整深研要等他在池子里按「自动深研」**（成本分层）。

## 11. 他的工作方式

- 中文 + 英文技术词；先给结论再展开；欢迎被直接反驳。
- 讨厌 AI 味文案：产品里不要「给你的建议」「赋能/闭环」，没信息量的话直接删。
- 拿不准的设计细节不要反复问 —— 综合判断后实现你认为的最优解，再说明理由。
