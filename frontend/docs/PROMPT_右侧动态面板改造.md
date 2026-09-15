# 任务：把首页右栏改造成「动态面板」（按原型还原）

## 0. 先读什么

1. 原型源码：`C:/Users/10021/Desktop/clark/tianshu-dynamic-panel.html`（单文件 HTML，含全部 CSS/JS，约 900 行）。先完整读一遍，特别是：
   - `<style>` 里 `/* ---------- panel ---------- */`、`/* ---------- dock ---------- */`、`/* ---------- sheets ---------- */` 三段
   - `<script>` 里 `renderFeed / cardHTML / openSheet / refreshSheet / popSheet / showBanner / setDock / startVoice / endVoice / caption / say / hear / updateHero`
   - 文件里有一份「机制说明」（`rulesHTML()`，11 条），那是设计规则，逐条对照实现。
2. 本仓库：`src/app/_views/home-view.tsx`（首页三栏）、`src/components/agenda/debrief-column.tsx`、`debrief-card.tsx`（现在的右栏）、`src/lib/data/types.ts` 里 `MeetingDebrief / DebriefPoint / DebriefTodo`（约 2580 行起）、`src/lib/data/store.ts` 里 `CEO_ACTOR`、`src/lib/agent/a7/debrief.ts`（会后提炼）。

不要动 `AGENTS.md / CLAUDE.md` 已有约定；沿用仓库的 Tailwind / 组件风格。

## 1. 目标（一句话）

首页右栏不再是「待确认的会议纪要」列表，而是原型里那块**iOS 锁屏式动态面板**：带色壁纸 + 磨砂玻璃卡片 + 顶部时间/状态行 + 底部「对话」主按钮与键盘按钮 + 点卡片开一层 sheet。**交互和视觉 1:1 还原原型；内容只有一种卡片：会后归到 CEO 名下的 action item。**

## 2. 布局约束（哪些动、哪些不动）

- **左栏完全不动。** 潜在议题卡片、业务域列表、底部品牌区：结构、配色、尺寸一个像素都不改。
- **中栏底色改成 `#F4F4F5`**（原来是 list-ground 那套，只换这一个底色）。中栏其余保持。
- **右栏整体替换**为动态面板。面板宽度沿用现在右栏的宽度。
- 「战略议题 / 已部署」那两颗点（`deployed-rail.tsx`）**不放进右栏**：它切换的是中栏，位置放在**中栏左缘、垂直居中**，默认只显示两个点，hover 展开标签（原型 `.rail` 的样式与行为，注意 hover 结束要收回：点击后 `blur()`，不要用 `:focus-within`）。

## 3. 右栏需要还原的机制（对照原型逐条）

### 3.1 面板本体
- 壁纸：原型 `.wp` 的 4 个模糊色块 + 慢速动画 + 一层 `::after` 暗色渐变。默认 `noon` 配色即可，不需要「换壁纸」按钮。
- 顶部 hero：小字状态行 + 大号时间（`font-weight:300`，tabular-nums）。状态行默认只显示「周三 9月2日」这种日期；打开 sheet 时变成「正在看 {ref}」；会议进行中变成计时 + 「会议进行中 · …」。**不要显示「N 件等你」。**
- 三层：`实时 / 待处理 / 参考`，都随 feed 滚动。这一版只有「待处理」会有内容（见第 4 节），另外两层为空时不渲染标签。
- 卡片：原型 `.card` 的玻璃样式（`backdrop-filter: blur(22px) saturate(160%)`、22px 圆角、左侧 38px 单字图标、右上时间、最多一个主动作 pill）。新卡片进场用 `cardin` 动画，被改动的卡片 `flash` 一下，移除用 `cardout`。

### 3.2 sheet（详情）
- 点任何卡片 → 右栏起一层 sheet（`top:58px`，顶部留一条 feed；feed 的 `.layers` 模糊 + 缩小，hero 的时间淡掉但状态行保持可读）。
- **只有一层**：再点别的东西，旧 sheet 加 `.recede`（上移缩小淡出）后移除，新 sheet 滑入。没有返回按钮，右上角只有 ×。点顶部那条 feed（backdrop）或 Esc 关闭。
- sheet 内容：上半是这件事本身；下半「它想到的」先显示「在想…」再填相关项（这一版相关项可以只是同一场会的其他 action item / 来源议题，没有就显示「暂时没想到相关的。」）。
- 打开 sheet 时 rail 无关（rail 在中栏），不需要隐藏。

### 3.3 底部 dock（永远在最前层）
- 居中一个「对话」按钮（150×46，玻璃底 + 两端各约 20% 的蓝/紫渐变提示，白字，左侧声波 icon 无圆底），右侧 12px 处一个 46px 圆形键盘按钮。用一个隐形占位让「对话」按钮真正居中（原型 `.side.ghost`）。
- 点「对话」→ 按钮变成 76px 圆球（`orb-core` 的旋转 conic 渐变），球有 `listening / thinking / speaking` 三态动画；左侧出现播报开关，右侧键盘按钮保留；再点球结束。
- 点键盘 → 「对话」按钮展开成输入框（宽 `min(520px, 100% - 110px)`，56px 高），键盘按钮变 ×；Enter 提交，Esc/× 收回。
- 球上方一条 caption（单行、省略号）：用户说的话以「你 · 」前缀显示，agent 的回复覆盖它；点 caption 开一层「对话记录」sheet。
- **不要把 dock 的模式名写成 class `bar`**——原型曾因此让 dock 继承了 `.bar` 样式跑到顶部。无模式时 dock 只有 `dock` 一个 class。
- 语音/文字对话的后端先接现有 `api/chat` 或留 TODO；这一步只要 UI 状态机完整。

### 3.4 横幅
- 实时层的新卡片在 sheet 打开时以横幅从顶部压下来（`.banner`，6.5s 自动收回，点它关 sheet 并打开对应卡片）。这一版没有实时数据源，把机制做出来即可，可留一个开发用的触发。

## 4. 内容：右栏只放「归 CEO 的 action item」

### 4.1 现状
会后 `MeetingDebrief` 已有 `points[]`（要点，可勾）和 `todos[]`（待办，`owner` 只在录音里真点了名才有）。提炼在 `src/lib/agent/a7/debrief.ts`。

### 4.2 改成
- 提炼时对每条 `todos[]`：判断 `owner` 是否是 CEO（对照 `CEO_ACTOR.personId` 对应的 `Person.name`，以及「我 / 我来 / 一号位」这类第一人称——只有转写里明确说了才算，**不许猜**，猜错人是这条链路最坏的错，见 `types.ts` 里 `DebriefTodo` 的注释）。
- 结果落到 `DebriefTodo` 上新增一个字段（例如 `assignedTo?: { personId: string; name: string; confidence: "explicit" }`），未来推给别人也用这个字段。
- **右栏只渲染 `assignedTo.personId === CEO` 的 todo**，每条一张卡：
  - 图标「任」，kind 显示「任务 · {issueRef}」，右上是会议时间
  - 标题 = todo 文本；副行 = 来源议题标题（一行截断）
  - 主动作一个：「完成」→ 标记完成、卡片 cardout；确认逻辑复用现有 debrief 的处置接口，不要再造一套
  - 点卡片 → sheet：todo 全文 + 来源会议摘要（`summary`）+ 这场会的其他 action item（作为「它想到的」）
- 原来右栏的「待确认纪要」卡片（要点 checklist + 无需再议/还需再议）**从右栏移除**，不删除其数据和处置接口；`decisions-view`（会后确认页）继续承接它。
- 其他角色的 todo 这一版**不显示**，也不推送——只做 CEO 这一条判断。
- 原型里的全部示例内容（ITEMS / FEEDS / SCRIPTS）**一律不要搬进仓库**，右栏没有数据时显示空状态：「会后归你的事会落到这里。」

## 5. 实现建议

- 新建 `src/components/panel/`：`dynamic-panel.tsx`（壁纸 + hero + feed + dock + sheet 容器）、`panel-card.tsx`、`panel-sheet.tsx`、`panel-dock.tsx`。原型的 CSS 直接搬成一个 `panel.css`（或 CSS module），变量名保持原型的 `--glass / --glass-hi / --glass-border / --dark-glass / --sheet / --on-glass-*` 以便对照。
- `home-view.tsx` 里把 `DebriefColumn` 换成 `DynamicPanel`；数据用现有 `useResource` 拉 debriefs，在客户端过滤 CEO todo。
- 状态：`sheet: {id} | null`、`dock: 'idle' | 'typing' | 'voice'`、`voiceState`、`caption`、`transcript[]`。
- 时间每秒刷新一次；`prefers-reduced-motion` 下关掉壁纸与球的动画。

## 6. 验收

1. 左栏截图与改造前逐像素一致；中栏底色 `#F4F4F5`；rail 在中栏左缘且 hover 后能收回。
2. 右栏：壁纸 + 时间 + 状态行；没有 CEO todo 时显示空状态；有时一张卡一条 todo。
3. 点卡 → sheet 滑入；点另一张卡 → 旧 sheet 后退消失、新 sheet 进入；× / Esc / 点顶部 feed 关闭。
4. 「对话」→ 球 → 再点收回；键盘 → 输入框 → × 收回；三种状态 dock 都在底部、水平居中，`getBoundingClientRect().top` 不变。
5. 跑一场带明确「我来做 X」的转写，提炼后右栏出现这一条；「小张来做 Y」不出现。
6. `pnpm lint && pnpm test` 通过；新增的判断逻辑有单测（参考 `store.debrief-assign.test.ts` 的写法）。
