# Clark v1 · 前端 Demo 实现规格（PRD-FE v1.0）

> **给执行 agent 的读法**
> 本文件是本次交付的唯一权威依据。**"硬约束"一节里的每一条都不允许自行推翻**——它们不是风格偏好，是产品定位的边界，违反其中任何一条都会让这个产品变成它明确宣称"不是"的东西。
> 其余部分（组件拆分、目录细节、动画、具体实现手法）你可以自行判断。
> 遇到本文件未覆盖的决策：**选更简单的那个**，并在 `DECISIONS.md` 里记一行（决策 / 理由 / 影响面）。
> 交付前必须逐条跑通第 11 节的自检清单。

**版本** v1.0 ｜ 2026-08-07 ｜ **范围**：纯前端，无后端，无鉴权

---

## 1. 这是什么产品

Clark 是给公司一号位用的**战略参谋 Agent**。它的主体不是对话，是一个叫 **Strategic Issue（战略议题）** 的持久对象——公司的判断被沉淀成可版本、可回放的对象，而不是散落在聊天记录里。

用户在产品里只做四类动作：**处置、对谈、确认、评分**。

### 四个"不是"（产品定位，全局适用）

1. **不是资讯流** —— 不做信息聚合、不做"今日要闻"、不追求覆盖率
2. **不是通用聊天** —— 所有对话必须挂在某个议题上，没有自由漂浮的会话
3. **不是会议纪要** —— 输出的是结构化的 Decision，不是转写整理
4. **不替 CEO 决策** —— Agent 只能提案，所有状态变更由人确认

**这四条会被界面上的具体设计不断挑战。每次拿不准，回来读这四条。**

---

## 2. 本次交付范围

一条完整旅程 + 两个内部工具页。演示脚本就是这条线：

```
提请列表 → 对谈（含反向挑战）→ 升级/交接包 → 会前 Brief
   → 会后 Closure 确认 → 写回 → 时间线回放
```

| ID | 页面 | 路由 | 优先级 |
|---|---|---|---|
| FE-0 | 提请列表（CEO 首页） | `/` | **P0** |
| FE-1 | Issue 列表 | `/issues` | **P0** |
| FE-1b | Issue 详情 = Context 时间线 | `/issues/[id]` | **P0** |
| FE-2 | 对谈 | `/issues/[id]/talk` | **P0** |
| FE-3a | Decision Brief（只读） | `/issues/[id]/brief` | **P0** |
| FE-3b | Closure 确认（可编辑） | `/issues/[id]/closure` | **P0** |
| FE-4 | 影子评审台（内部） | `/ops/shadow` | P1 |
| FE-5 | 会议校对工位（内部） | `/ops/proof/[meetingId]` | P1 |

P1 两页视觉可以粗糙，但字段不能缺——它们是"卡片经过精度门"和"30 分钟 SLA"的证明现场。

---

## 3. 技术栈与硬约束

### 3.1 栈

| 项 | 选型 | 说明 |
|---|---|---|
| 框架 | **Next.js 15+ App Router** | 单应用承载全部角色视图 |
| 语言 | **TypeScript，`strict: true`** | 不可关闭 |
| 样式 | **Tailwind CSS** | |
| 组件 | **shadcn/ui** | 组件代码复制进仓库，不做黑盒依赖 |
| 图标 | **lucide-react** | |
| 状态 | React 内置 + SWR/TanStack Query 二选一 | 不引 Redux/Zustand，规模不需要 |
| 包管理 | pnpm | |

### 3.2 硬约束（不可推翻）

**H1 · 不引入任何富文本编辑器。** 不用 TipTap / Slate / ProseMirror / Quill。所有编辑都是字段化的 `input` / `textarea` / `select`。
> 理由：Closure 是结构化对象，一旦给自由文本框，写回就无法解析，Decision 当场退化成会议纪要（违反"不是"第 3 条）。

**H2 · 不做乐观更新。** 所有状态变更走 `await api.xxx()` → 拿到返回的新对象 → 再渲染。变更期间显示 pending 态。
> 理由：真实后端的状态机会拒绝非法迁移；现在养成本地先改的习惯，接后端时全要返工。

**H3 · 不出现模型/Provider 切换器、Worker 模式切换器、插件市场、设置页。**
> 理由：违反基线"一个前台 Agent，后台 Worker 不暴露"。

**H4 · 动作全集封闭。** CEO 侧只有：处置（三选一）、对谈、确认、评分。不新增第五类动作。
> 理由：这个集合不膨胀，将来做移动端就只是同样四类动作的另一种布局。

**H5 · 不用桌面独有的交互隐喻。** 禁止：hover 才出现的操作、右键菜单、拖拽、多列并排比较。
> 理由：这些无法迁移到移动端，用了就是欠债。本月不做移动端，但不许留坑。

**H6 · 一切 URL 可寻址。** 每个 Issue、Brief、Closure 有独立 URL，刷新后状态可恢复。
> 理由：将来 IM 卡片一点直达，现在做成本为零，事后补成本极高。

**H7 · 不使用浏览器存储**（localStorage / sessionStorage / cookie 存业务数据）。所有数据经数据层。

**H8 · 不加载中文 Web 字体。** 用系统字体栈。
> 理由：中文字体文件几 MB，首屏会毁掉演示体感。

**H9 · 不写任何只为 demo 存在的代码分支。** 假数据只允许存在于第 5 节规定的唯一位置。
> 理由：这套代码要连续经过四次曝光（内部闭环 → 内部 CEO demo → 投资人 demo → 投资人自己使用），任何 mock 分支都会活到最后一次然后穿帮。

---

## 4. 设计系统

### 4.1 气质

**不能像**：聊天软件、资讯客户端、BI 看板、SaaS 后台模板。
**应该像**：一份呈到桌上的内参——有署名、有出处、有分歧标注。**责任感和可追溯性是视觉主题。**

### 4.2 Tokens

写进 `globals.css` 作为 CSS 变量，Tailwind 里映射。

```css
:root {
  --paper:      #FAFAF9;  /* stone-50  页面底 */
  --surface:    #FFFFFF;  /* 卡片底 */
  --ink:        #0F172A;  /* slate-900 主文字 */
  --ink-muted:  #475569;  /* slate-600 次级文字 */
  --ink-faint:  #94A3B8;  /* slate-400 元信息 */
  --rule:       #E2E8F0;  /* slate-200 分隔线 */

  /* 语义色：颜色即含义，不许挪作装饰 */
  --judgment:   #B45309;  /* amber-700  需要你判断 / 假设类分歧 */
  --confirmed:  #0F766E;  /* teal-700   已确认 / 已固化 */
  --counter:    #BE123C;  /* rose-700   反证 / 风险 / 告警 */
  --factual:    #0369A1;  /* sky-700    事实类分歧 / 外部事实 */
}
```

**语义色纪律**：这四个颜色只在其语义场景出现。不要用 amber 做"主题色"、不要用 teal 做普通按钮。**用户要能靠颜色一眼分辨"哪几条只有我能定"。**

### 4.3 字体

```css
--font-sans:  system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
--font-serif: "Songti SC", "SimSun", Georgia, serif;
--font-mono:  ui-monospace, "SF Mono", Menlo, monospace;
```

用法：**serif 用于议题标题和 Decision 正文**（呈报感）；sans 用于正文与界面；**mono 用于溯源标记、ID、时间戳、数值**。

### 4.4 Signature 元素：溯源徽章

**这是全产品的视觉记忆点。** 每一条事实性断言后面跟一个小徽章，标明来源类型。

```
组件：<TraceChip kind="ext|int|human|agent" source="8/4 客户会纪要" href="..." />
样式：左侧 2px 竖线（语义色）+ 浅色底 + mono 小字 + 外链图标
```

| kind | 显示文字 | 颜色 | 含义 |
|---|---|---|---|
| `ext` | 外部事实 | `--factual` | 公开信息 |
| `int` | 内部事实 | `--confirmed` | 投喂材料 |
| `human` | 人的判断 | `--ink` | CEO/DRI 说过的话 |
| `agent` | 推断 | `--judgment` | 无外部来源的 Agent 推演 |

**规则：任何生成内容里的事实断言必须挂徽章。没有来源的必须标 `agent`（显示"推断"），不允许裸露。**

### 4.5 布局

桌面优先，内容区最大宽度 **768px**（阅读舒适，且天然接近移动端布局，将来迁移小）。不做侧边栏导航——页面之间靠面包屑和明确的动作按钮跳转。

---

## 5. 数据层（本次交付最关键的架构决定）

**假数据只允许存在于一个地方。** 目录：

```
src/lib/data/
  types.ts        # 全部对象类型定义（第 6 节）
  seed.ts         # 种子数据（第 10 节）—— 唯一的假数据出口
  client.ts       # API 客户端：目前从 seed 读，将来改成 fetch
```

`client.ts` 暴露的接口就是将来的后端契约：

```ts
export const api = {
  listPending():                   Promise<Card[]>,
  listIssues():                    Promise<IssueSummary[]>,
  getIssue(id: string):            Promise<Issue>,
  getTimeline(id: string):         Promise<TimelineEvent[]>,
  getConversation(id: string):     Promise<Conversation>,
  getBrief(id: string):            Promise<Brief>,
  getClosureDraft(id: string):     Promise<Closure>,
  getMeeting(id: string):          Promise<Meeting>,
  listShadowQueue():               Promise<ShadowCard[]>,

  // 状态变更：一律返回变更后的完整对象
  disposeCard(cardId, action: 'discuss'|'watch'|'dismiss', reason?): Promise<Issue>,
  sendMessage(issueId, text: string):                               Promise<Message[]>,
  escalate(issueId, revealStance: boolean):                         Promise<Issue>,
  confirmClosure(issueId, fields: Closure):                         Promise<Issue>,
  submitRating(targetId, quality: number, experience: number, note?): Promise<void>,
  reviewShadowCard(cardId, verdict, reason?):                       Promise<ShadowCard>,
  submitProofread(meetingId, segments: Segment[]):                  Promise<Meeting>,
};
```

**实现要求：**

- 每个方法内部 `await sleep(200~600ms)`，模拟真实网络。**不要让交互瞬间完成**——那会掩盖 pending 态的设计缺陷。
- 变更类方法必须真的修改内存中的 seed 状态，**保证同一次会话内前后一致**（在 Issue 详情页看到的状态，必须反映刚才在提请页做的处置）。
- 组件里**不允许**出现 `import { seed }`。只能 `import { api }`。
- 页面刷新后回到初始种子状态，这是可接受的。

> 这样设计的意义：接后端时只改 `client.ts` 一个文件。这是 H9 的技术实现。

---

## 6. 对象类型

写进 `types.ts`。字段名与后续后端对象模型对齐，不要自行改名。

```ts
type Sensitivity = 'L1' | 'L2' | 'L3';
type TraceKind   = 'ext' | 'int' | 'human' | 'agent';

type IssueState =
  | 'Candidate' | 'Watching' | 'Exploring' | 'Researching'
  | 'ReadyForDecision' | 'WaitingEvidence' | 'Decided'
  | 'Monitoring' | 'Reopened' | 'Closed' | 'Dismissed';

interface Trace { kind: TraceKind; source: string; href?: string; }

interface Statement { text: string; traces: Trace[]; }   // 带溯源的一句话

interface Card {                    // 提请卡片（四段式）
  id: string;
  issueId: string;
  what: Statement[];                // ① 发生了什么
  why: string;                      // ② 为何现在重要
  strategyRef:  { id: string; statement: string };        // ③ 影响哪条判断（必填）
  hypothesisRef?: { id: string; statement: string };
  suggestion: Statement;            // ④ 建议动作
  createdAt: string;
}

interface Issue {
  id: string; title: string; state: IssueState;
  origin: 'signal' | 'manual' | 'backfill';
  strategyRefs: string[]; hypothesisRefs: string[];
  nextActionForUser: string | null;   // null = 目前不需要用户做什么
  updatedAt: string;
}

type TimelineEventKind =
  | 'state' | 'signal' | 'talk' | 'deep'
  | 'handoff' | 'judgment' | 'decision' | 'trigger';

interface TimelineEvent {
  id: string; kind: TimelineEventKind; at: string;
  headline: string;
  actor?: string;
  detail?: string;
  defaultOpen: boolean;              // 见 7.3 折叠规则
}

interface AssemblyManifest {         // 装配清单
  total: number;
  groups: { label: string; items: string[] }[];
}

interface Message {
  id: string; role: 'clark' | 'user';
  blocks: MessageBlock[];
  at: string;
}

type MessageBlock =
  | { type: 'text';      statements: Statement[] }
  | { type: 'manifest';  manifest: AssemblyManifest }
  | { type: 'challenge'; items: { conflict: string; basis: string; alternative: string }[] }
  | { type: 'question';  text: string; suggestedDri: string; deadline: string };

interface Divergence {
  kind: 'fact' | 'hypothesis' | 'value';
  text: string;
  note: string;                      // "可查证·需2天" / "只能您拍板"
}

interface Brief {
  issueId: string;
  problem: string;
  driRecommendation: Statement;
  keyEvidence: Statement[];
  strongestCounter: Statement;       // 最强反证，独立区块
  divergences: Divergence[];
  suggestedQuestions: { q: string; implication: string }[];
}

interface Closure {                  // 七要素，顺序固定
  choose: string; notChoose: string; why: string;
  keyHypothesis: string; riskAccepted: string;
  commitment: string; reopenTrigger: string;
}

interface WriteBackResult {          // 确认后展示"写回了什么"
  decisionId: string;
  updatedObjects: string[];          // ["Hypothesis H-05 → v2", ...]
  triggersArmed: number;
  evidenceActions: number;
  newState: IssueState;
}

interface ShadowCard {
  id: string; headline: string; relation: string;
  status: 'pending' | 'passed' | 'rejected';
  verdict?: 'yes' | 'edge' | 'no';
  reason?: string;
}

interface Segment { t: string; speaker: string; text: string; }
interface Meeting { id: string; title: string; durationMin: number;
                    uploadedAt: string; slaDeadline: string; segments: Segment[]; }
```

---

## 7. 逐页规格

### 7.0 FE-0 · 提请列表 `/`

**这一页要解决的问题**：让一个每天只给 5 分钟的人，在这 5 分钟里做完 0–3 个判断，并且不产生"我是不是漏了什么"的焦虑。

**⚠ 命名纪律**：内部代码标识符用 `digest`；**界面上不出现任何栏目名**——不写"晨报"、不写"提请"、不写"今日"。Clark 直接说话。

**结构**

```
[Clark 头像] Clark
早上好。今天有两件事想请您定一下。

[卡片 1]
[卡片 2]

（页脚 mono 小字）今日 2/3 项
```

**卡片结构（四段式，默认折叠）**

默认只显示 ① 发生了什么 + ③ 影响哪条判断，以及一个展开按钮"为何现在重要 · 建议动作"。展开后显示全部四段。

- ③ 区块的标签后面加一句 mono 小字「· 出卡门槛」——它是这张卡存在的理由。
- Strategy 用深色实心小标签显示 ID（如 `S-02`），Hypothesis 用 amber 实心。
- 每条事实语句后面跟 `<TraceChip>`。

**三动作（卡片底部，等宽三格）**

| 按钮文字 | 图标 | 语义 | 样式 |
|---|---|---|---|
| **聊聊** | MessageSquare | discuss | 深色实心（主动作） |
| **先看着** | Eye | watch | 描边 |
| **不看** | X | dismiss | 描边、文字次级色 |

**界面上不出现 Discuss / Watch / Dismiss 这些英文词。**

- 三个动作**都不弹二次确认框**。
- 点「聊聊」→ `await api.disposeCard(...)` → 跳转 `/issues/[id]/talk`
- 点「先看着」→ 卡片就地收缩为一行已处置摘要
- 点「不看」→ 卡片区域内展开四个原因标签：`不相关` `已知道了` `时机不对` `判断错了`，外加一个 mono 的「跳过」。**原因不强制**。

**空态（必须实现，且是合格输出不是错误）**

```
今天没有需要您看的变化。
有事随时找我 →
```

不放插图、不放"系统运行正常"、不放本周统计。

**预算纪律**：页脚只显示 `今日 2/3 项`。**绝对不出现**"还有 N 条未显示"、"查看更多"、"未读"。超限的内容由系统顺延，用户不需要知道。

---

### 7.1 FE-1 · Issue 列表 `/issues`

**排序按"需要你判断的"优先，不按时间。**

分三组，组标题用 mono 小字：

1. **需要判断** —— `nextActionForUser !== null`，左边框 amber
2. **进行中** —— Exploring / Researching / ReadyForDecision / WaitingEvidence
3. **已固化** —— Decided / Monitoring

每行：状态 + ID（mono 小字）+ 标题（serif）。

**不做**：看板视图、筛选器、标签体系、搜索框。v1 的议题是个位数，任何筛选 UI 都是过度设计。

---

### 7.2 FE-1b · Issue 详情 = Context 时间线 `/issues/[id]`

**页面主体就是时间线。这不是"带附件的详情页"。**

**顶部固定块**（深色底）：

```
（mono）ISS-014 · Monitoring
（serif 大字）议题标题
（teal 小字）目前不需要您做什么 · 已布控 3 条 Re-open Trigger
```

若 `nextActionForUser` 非空，最后一行改为 amber，并给一个跳转按钮。**没有待办时要明说"目前不需要您做什么"**——沉默会让人以为漏了什么。

**时间线**：倒序（最新在上）。左侧圆点 + 竖线；圆点颜色按事件类型。

**折叠规则**（`defaultOpen`）：

| 展开 | 折叠 |
|---|---|
| 状态迁移、交接发出、Judgment 回传、Decision 固化、Trigger 命中 | Signal 进入、对谈、深研完成 |

判据：**组织动作和状态迁移导向判断（展开）；过程性内容不导向判断（折叠）。**

每个事件：mono 时间 + mono 类型标签 + 标题 + actor + 可展开详情。

**这一页是"全程数据落库可回放"的举证界面，演示时的收尾环节。**

---

### 7.3 FE-2 · 对谈 `/issues/[id]/talk`

**这一页有两个东西是标准聊天 UI 没有的，它们正是产品价值的证明。**

#### (a) 装配清单 —— 必须实现

Clark 的**第一条消息**里必须交代"我带了什么进来"。形式：消息内一行可点击的折叠行

```
▸ 带了 12 项 Context
```

展开后按组显示（原 Signal / 相关 Strategy·Hypothesis / 历史 Decision / Decision Memory / 过往对谈），每组下列条目，底部一行 mono：`M03 assembly manifest · 可在 Issue 时间线回查`。

> 这是"CEO 永远不需要从头介绍背景"的可见证明。**演示时会专门打开它。**

#### (b) 反向挑战 —— 必须带来源

`challenge` 类型的消息块渲染为左侧 4px rose 竖条的区块，标题行 mono rose：`在回答之前，两条反向挑战`。每条三段：

```
挑战正文
（mono 次级）依据：与 S-02 陈述冲突
（浅底小块）替代解释：……
```

区块底部 mono 小字：`每条挑战必须带来源`。

**如果某条挑战没有 `basis`，渲染成告警样式**——那是表演性抬杠，是要被抓的东西。

#### (c) 不暴露模式切换

**界面上不出现 Explore / Research / Challenge / Frame 的切换器。** 它们是后台分工。

#### (d) Frame 出口

当 Clark 收敛出可判断的问题时，在对话流中给一张 amber 底的结构化卡片：

```
（mono）问题已经收敛 · Decision Question
（serif）是否……？
（mono）建议承接：XX DRI · 时限 半天

──────────────
☐ 同时告诉 DRI 我的倾向
  （次级小字）默认关。交接包只呈现「您关注的问题」，
  不呈现「您的倾向」——防止 DRI 的研究结论向您收敛。

[ 升级并交给 DRI → ]
```

**复选框默认不勾。** 点升级 → `await api.escalate(issueId, revealStance)` → 跳 `/issues/[id]/brief`。

#### (e) 输入框

底部一个普通输入框 + 发送。发送后调 `api.sendMessage`，pending 期间显示 Clark 正在输入的占位。**不做语音、不做附件上传、不做快捷指令。**

---

### 7.4 FE-3a · Decision Brief `/issues/[id]/brief`

只读页。七个区块，**分歧标注是这一页的核心**。

**顺序固定**：当前问题 → DRI 推荐 → 关键 Evidence → **最强反证** → 开放分歧 → 建议追问。

**最强反证必须独立成块，且视觉权重不低于 DRI 推荐**：2px rose 边框、独立卡片、标题带 AlertTriangle 图标。
> 缩成脚注就等于没有防迎合机制。

**开放分歧**：每条一个左边框 4px 的块，颜色按 kind：

| kind | 底色/文字 | 标签 | 备注文字 |
|---|---|---|---|
| `fact` | sky 浅底 | 事实 | 可查证 |
| `hypothesis` | amber 浅底 | 假设 | 需验证 |
| `value` | **深色实心、白字** | 价值 | 只能拍板 |

区块底部 mono：`颜色即语义 · 深色块 = 只有您能定`。

**建议追问**：每条问题下面浅底小块显示"不同答案分别意味着什么"。

底部按钮：`会已开完 · 看 Closure 草案 →`

---

### 7.5 FE-3b · Closure 确认 `/issues/[id]/closure`

七要素，**顺序固定**：Choose / Not Choose / Why / Key Hypothesis / Risk Accepted / Commitment / Re-open Trigger。

**交互模式：整体审阅 + 局部改。**

- 全文呈现，每个字段右上角一个 mono 的「改」
- 点「改」→ 该字段就地变 textarea（amber 边框），失焦即保存到本地 state
- 底部**一个**按钮：`✓ 确认并写回`
- 按钮下方 mono 小字：`不改的话 1 次点击 · 任一字段点「改」即可局部修订`

> **不要做逐字段确认。** 七次点击会把治理正确性直接变成摩擦。治理要求的是"CEO 确认过"，不是"CEO 点了七次"。

**顶部**显示 mono 的 `会后 26 分钟` —— 这是 30 分钟 SLA 的兑现证据。

**写回后**（`confirmClosure` 返回 `WriteBackResult`）：

**不跳转、不弹庆祝动画。** 就地把页面转为已固化状态：teal 左边框卡片，标题 `✓ 已固化并写回`，下面 mono 列出：

```
Decision D-2026-08-06 · v1
Hypothesis H-05 → v2（已标注修订）
Evidence Action ×1 · 到期 8/20
Re-open Trigger ×3 · 已布控回 Sensor 靶点
ISS-014 → Monitoring
```

> 这是"同一版本认知"的可见证明，也是演示的高潮点之一。

**随后弹评分浮层**（见 8.2）。

---

### 7.6 FE-4 · 影子评审台 `/ops/shadow`（P1）

内部工具，视觉可粗糙，**字段不能缺**。

**顶部门槛条**：本周精度 `64%` / 放闸门槛 `≥70%` / 距门槛 `-6pt` / 影子第几天 `D3 / 14`。右侧一句话：`未过精度门不见 CEO——第一印象只有一次`。

**左侧队列**：候选卡片列表，显示 ID、标题、战略关联（无关联的用 rose 显示）、状态。

**右侧评审面板**：

1. 卡片四段式全文 + 溯源（评审员要能一键跳原文核对）
2. **精度评分**：三个按钮 `该发` / `边缘` / `不该发`
3. **归因**（选"边缘"或"不该发"时出现，必填）：`靶点问题` `关联判定错` `事实有误` `重复信号` `时机不对` `表述差`
4. 动作：`放行` / `退回` / `改写后放行`

> **归因字段是这一页最重要的设计。** 没有它，"精度不达标 → 归因（靶点质量 vs 管道质量）"就是空话。

---

### 7.7 FE-5 · 会议校对工位 `/ops/proof/[meetingId]`（P1）

**顶部**：会议标题、时长、`SLA 倒计时 18:24`（amber 大字，serif）。

**逐段列表**，每段一行：

```
[▶ 00:01:44]  [说话人 ▾]  [可编辑文本]
```

- 说话人是 **select 下拉**，不是输入框——与会者是已知的封闭集合
- 值为「未识别」时，select 显示 rose 边框和底色
- **存在未识别段落时，提交按钮禁用**，按钮文字变成 `还有 N 段未标说话人`
> 分歧归属错会污染 Decision State 四分类，是链路上最早的污染源。

提交后显示 teal 文字：`抽取中 · 预计 4 分钟后产出 Decision State`。

---

## 8. 全局机制

### 8.1 溯源徽章

见 4.4。实现为一个组件，全站复用。点击行为：v1 只需 `console.log` 或弹一个显示 `source` 的小浮层，不需要真跳转。

### 8.2 评分浮层

**触发时机**：Closure 确认后、对谈结束时（用户离开对谈页）。

**形式**：页面底部非阻塞卡片，不遮挡内容。

```
这次的结果怎么样？
结果质量  ☆☆☆☆☆
使用体验  ☆☆☆☆☆
[提交]  跳过
```

两项分差 ≥2 时，追加一个单行输入：`最大的问题是什么？`

**规则**：可跳过；**跳过后本次会话内不再对同一对象追问**。10 秒内能完成。

### 8.3 加载与错误

**加载**：骨架屏或简单的 mono 文字 `…`，**不要用旋转 spinner**（廉价感）。按钮的 pending 态用文字变化表达（`确认并写回` → `正在写回…`）。

**错误**：任何失败给一句中文人话 + 一个「重试」。**不允许**白屏、英文报错、`undefined`。

### 8.4 无障碍与键盘

所有可点元素是真的 `<button>` / `<a>`，可 Tab 到达，有 focus 样式。**不做快捷键**。

---

## 9. 文案表（直接使用，不要改写）

界面文案是产品声音的载体，**不要替换成通用 SaaS 中文**。

| 位置 | 文案 |
|---|---|
| 提请页开场 | `早上好。今天有两件事想请您定一下。`（数量动态） |
| 空态主句 | `今天没有需要您看的变化。` |
| 空态次句 | `有事随时找我 →` |
| 三动作 | `聊聊` / `先看着` / `不看` |
| Dismiss 原因 | `不相关` / `已知道了` / `时机不对` / `判断错了` / `跳过` |
| 四段式标签 | `发生了什么` / `为何现在重要` / `影响哪条判断` / `建议动作` |
| 出卡门槛注 | `· 出卡门槛` |
| 展开卡片 | `为何现在重要 · 建议动作` |
| 装配清单 | `带了 N 项 Context` |
| 装配清单页脚 | `M03 assembly manifest · 可在 Issue 时间线回查` |
| 挑战区标题 | `在回答之前，N 条反向挑战` |
| 挑战页脚 | `每条挑战必须带来源` |
| Frame 卡标题 | `问题已经收敛 · Decision Question` |
| 披露开关 | `同时告诉 DRI 我的倾向` |
| 披露说明 | `默认关。交接包只呈现「您关注的问题」，不呈现「您的倾向」——防止 DRI 的研究结论向您收敛。` |
| 升级按钮 | `升级并交给 DRI →` |
| 无待办 | `目前不需要您做什么` |
| 分歧页脚 | `颜色即语义 · 深色块 = 只有您能定` |
| Closure 按钮 | `确认并写回` |
| Closure 说明 | `不改的话 1 次点击 · 任一字段点「改」即可局部修订` |
| 写回成功 | `已固化并写回` |
| 评分问句 | `这次的结果怎么样？` |
| 评分维度 | `结果质量` / `使用体验` |
| 评分追问 | `最大的问题是什么？` |
| 精度门提示 | `未过精度门不见 CEO——第一印象只有一次` |

**禁用词**：暂无数据 · 敬请期待 · 操作成功 · 系统繁忙 · 加载中... · 更多 · 未读 · 消息 · 会话 · 助手 · AI

---

## 10. 种子数据

**⚠ 这是占位内容，8/15 拿到真实议题后必须整体替换。** 写在 `seed.ts` 一处，替换时只改这个文件。

**主线议题（轨 A，词元云集自身）**

```
ISS-014 · 灯塔项目定制交付与 Clark 产品通用化的资源冲突
```

**卡片 1（ISS-014）**
- 发生了什么：
  - `竞品「智策」8/3 发布私有化部署版本，公开定价为标准版 2.4 倍。` → `ext` / `厂商官网`
  - `灯塔项目 7 月定制交付占用研发人力 62%，环比上升 14 个百分点。` → `int` / `7 月人力表`
- 为何现在重要：`两条信号在 48 小时内同时出现，且指向同一个问题：定制交付到底是通往产品的路径，还是替代产品的路径。9 月 Outcome 规划前需要给出答复。`
- 影响哪条判断：`S-02` 产品化优先于项目化：单客户定制不超过交付量的 30%；`H-05` 灯塔的定制需求可沉淀为通用能力
- 建议动作：`建议 Discuss —— 这条同时挑战了 S-02 的红线和 H-05 的成立条件。` → `agent`

**卡片 2（ISS-015，用于演示"先看着"）**
- 发生了什么：`陪跑团队 7 月投入工时中，非产品化工作占 48%。` → `int` / `7 月工时统计`
- 为何现在重要：`连续第二个月上升，已越过年初设定的观察阈值。`
- 影响哪条判断：`S-04` 陪跑团队在 Q3 前转为产品运营角色
- 建议动作：`建议 Watch —— 趋势成立但尚不需要本月决策。` → `agent`

**装配清单（12 项，5 组）**
- 原 Signal：竞品私有化发布（外部）、7 月人力表（内部）、CEO 7/29 周会发言（主观）
- 相关 Strategy / Hypothesis：S-02 产品化优先于项目化、H-05 定制需求可沉淀为通用能力
- 历史 Decision：D-2026-06-03 否决 X 客户源码交付诉求（含否决理由）
- Decision Memory：原则「不为单一客户改变产品形态，除非该形态可复用」（您 6/3 确认）
- 过往对谈：无——本议题首次进入对谈

**两条挑战**
1. 冲突：`把定制交付算作产品化路径，会让 S-02 的 30% 红线失去意义。` 依据：`与 S-02 陈述冲突` 替代：`除非把「可复用的定制」本身算作产品能力——但那需要先证明它能复用到第二个客户。`
2. 冲突：`H-05 可能已经失效，而不是这一次例外。` 依据：`与 D-2026-06-03 的假设前提冲突` 替代：`6 月否决 X 客户时的依据就是 H-05。如果 H-05 塌了，那次否决也需要重看。`

**Decision Question**
`是否把灯塔的定制交付正式定义为产品化路径的一部分，还是限定为一次性项目并接受资源占用上限？` · 建议承接：产品线 DRI · 时限 半天

**Brief**
- DRI 推荐：`定义为产品化路径，但限定为「可复用的定制」——每一项定制必须先证明第二客户可用。` → `human` / `产品线 DRI`
- 关键 Evidence：`近 6 个月三个客户的定制需求中，有两项功能重合度超过 70%。` → `int` / `需求台账 8/5`
- 最强反证：`两项重合不足以判定这是共性需求。若实为偶发，标准化投入将成为沉没成本，且 S-02 的红线一旦破例就难以恢复。` → `agent`
- 分歧：
  - `fact`：`完全通用化后的维护成本增量未测算。` / `可查证 · 需 2 天`
  - `hypothesis`：`H-05「定制可沉淀为通用能力」是否仍成立，还是仅此项目例外？` / `需验证 · 建议抽查另两个客户需求`
  - `value`：`本季交付收入确定性 vs 产品通用化路线的完整性。` / `只能您拍板`
- 建议追问：`另外两个客户的定制需求，是否也能落进同一套抽象？` → 含义：`若是 → 这是形态问题，标准化成立；若否 → 这是个案，按项目处理。`

**Closure 七要素**
- Choose：`把定制交付定义为产品化路径的一部分，但限定为「可复用的定制」——每项定制需先通过第二客户可用性论证。`
- Not Choose：`不做单客户专属功能；不为单一项目改产品主干代码。`
- Why：`定制需求已出现两次重合，具备复用前提；但通用化的维护成本尚未验证，不在本次承诺内。`
- Key Hypothesis：`H-05 修订为：灯塔定制需求中约六成可沉淀为通用能力，其余按项目一次性处理。`
- Risk Accepted：`接受 Q3 研发人力中定制占比不超过 40%。超出即触发重开。`
- Commitment：`产品线 DRI 在 8/20 前给出可复用性论证方法与两项已有定制的评估。`
- Re-open Trigger：`① 出现第三个不可复用的定制诉求；② 定制人力占比超 40%；③ 抽查结果与修订后的 H-05 不符。`

**时间线 9 个事件**（倒序）：Decision 固化 → 状态迁移 → Judgment 回传 → 状态迁移 → 交接包发出 → 对谈 3 轮 → 状态迁移(Discuss) → 候选卡片生成·经影子评审放行

**影子队列 5 张**：3 待评审（其中 1 张「无关联」用于演示该退回）、1 已放行、1 已退回

**会议**：`8/6 EXCO · 定制交付形态` / 92 分钟 / 5 个转写段落，其中 2 段说话人为「未识别」

---

## 11. 交付自检清单

逐条勾，做不到的在 `DECISIONS.md` 里写明原因。

**架构**
- [ ] `grep -r "seed" src/app src/components` 无结果（组件不直接引种子数据）
- [ ] `pnpm tsc --noEmit` 零错误，`strict: true`
- [ ] `pnpm build` 通过
- [ ] 全项目搜索 `localStorage|sessionStorage` 无结果
- [ ] 全项目无 tiptap / slate / prosemirror / quill 依赖
- [ ] 所有状态变更都是 `await api.*()` 后再更新 UI，无本地先改

**边界**
- [ ] 界面上没有模型/Provider 切换器、没有设置页、没有插件入口
- [ ] 界面上没有出现 "晨报"、"Discuss"、"Watch"、"Dismiss"、"Worker"、"Agent 模式" 字样
- [ ] 无 hover-only 操作、无右键菜单、无拖拽
- [ ] 每个页面有独立 URL，刷新后停在同一页面

**功能**
- [ ] 提请页 → 聊聊 → 对谈 → 升级 → Brief → Closure → 写回 → 时间线，全程可点通
- [ ] 装配清单可展开，显示 12 项分 5 组
- [ ] 至少一条挑战显示了「依据」和「替代解释」
- [ ] 三类分歧颜色不同，价值类是深色实心
- [ ] 最强反证是独立区块，不是脚注
- [ ] 披露倾向的复选框默认未勾选
- [ ] Closure 不改的情况下 1 次点击完成写回
- [ ] 写回后显示了写回对象清单和 Trigger 数量
- [ ] 空态可触发（种子里留一个开关或一个空的日期）
- [ ] Dismiss 可跳过原因
- [ ] 评分浮层可跳过，跳过后不再弹
- [ ] 校对工位在有「未识别」段落时提交按钮禁用

**质感**
- [ ] 没有出现第 9 节的禁用词
- [ ] 所有事实性语句后面都有溯源徽章
- [ ] 加载态不是旋转 spinner
- [ ] 中文用系统字体，无 web font 请求

---

## 12. 明确不做

富文本编辑器 · 模型/Provider 切换 · Worker 模式切换 · 设置页 · 通知中心 · 全局搜索 · 筛选器 · 标签体系 · 看板视图 · 多主题/暗色模式 · 登录注册 · 移动端适配 · 快捷键 · 拖拽排序 · 动画库 · 图表 · 导出 · 打印样式 · 国际化 · Outcome 对齐相关全部界面 · 秘书协作账单 · 准备队列 · 一句话调度 · 异步深研进度界面 · 弃用降级模式 · 周度回看 · 会中实时界面。

---

## 13. 目录结构建议

```
src/
  app/
    layout.tsx  globals.css
    page.tsx                      # FE-0 提请
    issues/page.tsx               # FE-1
    issues/[id]/page.tsx          # FE-1b 时间线
    issues/[id]/talk/page.tsx     # FE-2
    issues/[id]/brief/page.tsx    # FE-3a
    issues/[id]/closure/page.tsx  # FE-3b
    ops/shadow/page.tsx           # FE-4
    ops/proof/[meetingId]/page.tsx# FE-5
  components/
    ui/                           # shadcn
    trace-chip.tsx                # signature 元素
    card-four-part.tsx
    timeline.tsx
    divergence-block.tsx
    rating-toast.tsx
  lib/data/
    types.ts  seed.ts  client.ts
DECISIONS.md
```

---

*本规格覆盖第一版纯前端 demo。真实议题数据到位后替换 `seed.ts`；接入后端时只改 `client.ts`。*
