# DRI 侧的网页：接 OM、接研究任务、上报信号

日期：2026-08-19 · 分支：`dri/web` · 状态：设计已确认，待写实施计划

前置：`HANDOFF.md` §10 两个已定的产品判断、`docs/00_前端开工前待确认清单_v0.1.md`
A-2/A-3/C-1、`src/lib/data/seed-agent-domain.ts` 里那份 8 月 Mission Card 复盘
（G2 条目级回传、A2 验收项分层、A4 Context 人肉搬运、H2 开放问题追踪）。

---

## 1. 这份 spec 定的是什么

内部三件事要亲自体验：**DRI 接收并调整 OM、接收调研议题任务、上报信号**。

载体在四种方案里选了「在本仓库加 DRI 侧网页」。不接飞书、不接微信的理由不重复，
只留结论中最硬的那一条：**条目级回传（五条 Mission 逐条标注 + 成功证据 + 里程碑 +
假设区 + 问题区）任何 IM 卡片都承载不了**，而它恰好是复盘 G2 认定「两轮收敛」的主因，
也是这个产品要证明的东西。飞书只在后面某一轮补一层「推到人 + 一键回执」，正文一律
跳网页——那与 A-3 已定的「IM 卡片 + 内嵌 H5」是同一个架构，不新增分支。

范围：**这不是第二个产品，是同一个应用的第二道门。** 同一个对象库、同一条 RPC、
同一副字。真正新建的只有两样：请求身份，和 Commitment 对象。

---

## 2. 勿增实体：刮掉的四样

写在最前面，因为后面每一节都要守住这条。

| 刮掉的 | 本来打算 | 为什么不要 |
|---|---|---|
| **第二个信号池** | DRI 上报落一个新集合 | `InboxSignal` 那个池子已经是「待挑信号」，抓取作业推进来的东西就在里面，处置路径也已经有了（`/signals-inbox`）。DRI 上报只是**同一个池子的第二个来源**，`Card.source` 早就有 `{kind:"dri", by}` 这一档 |
| **纲领录入页** | 一号位侧做一个表单录本期 OM | 一个月一次的操作，做一整个页面是为一次动作建一个实体。走机器口：`POST /api/om/intake` + `x-operator-token`，和抓取作业推信号同一个路数，本地一条命令灌进去 |
| **DRI 名册环境变量** | `TKOS_DRI_ROSTER` 列谁能进 | 名册在对象库里躺着（`tk.people` 里 `role: "dri"`，`api.listDris` 已经在用）。签名验过之后拿 personId 去解人，解不出 dri 就不放进来 |
| **版本 diff 视图** | v0.1→v0.2 逐字段对比 | 8 月实测收敛轮次 2，第二轮通常只改一两条。变更记录先是一段文字。真需要了再做 |

另外两样是**明确不做，不是暂缓**（见 §9）：今日那三张卡、给潜在议题打分。

---

## 3. 三条链路：库里已有什么，要加什么

### 3.1 上报信号

已有：`CardSource = {kind:"dri", by}`（`types.ts:238`）、`InboxSignal` 与
`inboxSignalsPut` 的幂等键、`/signals-inbox` 待挑页、`parseInboxPayload` 的形状校验。

加一个服务端方法 `submitDriSignal(input)`，落进同一个 `store.inboxSignals`。
**不落进一号位的任何「今日」视图**——他在待挑页里挑，和抓取作业推进来的那些排在一起。

这里有一处必须改形状，不能图省事：`InboxSignalInput` 是为抓取作业长的，带
`score` / `dimensions` / `kiq` / `runId` / `scannedAt`（`types.ts:1792`）。一个人报上来
的信号没有这些东西。**照现有形状塞就必须编一个分数和一个 Run id**，那正是这个仓库
反复禁止的那种假数据（同 `persist.ts` 与 `DECISIONS.md` I-3 的理由）。

所以 `InboxSignal` 拆成联合类型：

```ts
type InboxSignal = InboxSignalCommon &
  ( { kind: "crawled" } & CrawlerFields      // score/dimensions/kiq/runId/scannedAt
  | { kind: "reported"; by: string } );      // 一个人押上名字，没有分数
```

共享的是 `title` / `text` / `source` / `why` / `publishedAt` / `dedupeKey` /
`receivedAt` / 处置那三个字段。人报的那条 `dedupeKey` = 有 URL 就用归一化 URL，
没有就取「姓名 + 一句话 + 日期」的哈希。**缺的字段不给,不给 0。**

`parseInboxPayload` 与机器那条口一个字不动——DRI 侧走 `/api/data` RPC，是另一道门，
不过那个解析器。待挑页按 `kind` 分两种渲染：抓来的那条可信来自「有人在外面盯着变化」，
人报的那条可信来自「一个具体的人把名字押在上面」——`CardSource`
（`types.ts:224`）那段注释已经把为什么必须分开说清楚了。

DRI 侧四个字段：一句话 / 出处 / 你觉得它动摇哪条判断（可空，从在版判断里选）/
为什么是现在。第三个字段允许为空是刻意的：**要求上报人先答出「动摇哪条判断」等于
把上报门槛提到没人愿意报**。那道门槛属于出卡侧，不属于收件侧。

### 3.2 接收调研议题任务

已有：`assignIssue`、`HandoffStatus{unassigned|waiting|done}`（`types.ts:443`）、
`store.driReports[issueId]` 槽位、议题研究左栏「承接研究 · DRI」页签。

加两个方法：`listMyHandoffs()`（按请求身份过滤，不是前端过滤）、
`submitDriReport(issueId, doc)`。

DRI 交出来的东西**就是现有的 `ResearchDoc`，不新建类型**：

- `sourceText` 放原件（空行分段、`## ` 起小标题，与 `Doc.body` 同一套约定，已有）；
- 四节各写一到三句，每句 `traces: [{kind:"human", source:"<姓名>（<域> DRI）"}]`
  ——`TraceKind` 里 `"human"` 这一档就是为此存在的；
- `byAgentLabel` 写人名，不写 Agent 名。

同时**拆掉 `escalate` 里那段模拟**（`store.ts:3072`，注释自己写着「demo 把真实世界里的
半天压缩成一次调用」）。真人接手之后，议题停在 `WaitingEvidence` 等的是一个真的人，
屏幕上照实说等谁、从什么时候开始等。

### 3.3 接收并调整 OM

**唯一需要新建对象的一块。** 现在 `MissionCard` 是只读的，从种子 `allMissions` 拼出来，
数据层一个写口都没有，`outcomes-view.tsx:26` 明写着「只读，Mission 归 DRI，一号位在
这里能看不能改」。

复用已有的 `Period`（`types.ts:61`）和 `CompanyOutcome`。新增：

```ts
interface Commitment {
  id: string;                 // `${domainId}:${periodId}`
  domainId: string;
  periodId: string;
  version: number;
  /**
   * 纲领灌进来那一刻是 `drafted`（提案在了，DRI 还没标注）。
   * DRI 提交 → `submitted`；一号位逐条裁完 → `adjudicated`；
   * DRI 按裁决修订再提交 → version+1 且回到 `submitted`（这就是「一轮」）；
   * 一号位签一次 → `effective`，此后只读。
   */
  status: "drafted" | "submitted" | "adjudicated" | "effective";
  /** 本月唯一核心验收，一句话。卡的第一节，不是最后一节 —— 复盘 A1 */
  northStar: string;
  items: CommitmentItem[];
  /** ⚠ 假设 + 逾期默认路径 */
  assumptions: { text: string; defaultPath: string; dueOn?: string }[];
  /** 生效前提，硬上限 2 条（M2 承诺最低条件） */
  preconditions: string[];
  /** 复盘 H2 那张表：不追踪就会静默过期 */
  questions: { text: string; toWhom: string; needBy: string; closed: boolean }[];
  /** 与 JudgmentRevision 同形状，不另起一套 */
  revisions: { version: number; at: string; actor: string; note: string }[];
}

interface CommitmentItem {
  id: string;
  /** 公司提案的那条 Mission，原文照录 */
  proposed: string;
  verdict: "accept" | "modify" | "rewrite" | "reject";
  /** 非 accept 必填 */
  reason?: string;
  /** 成功证据 3–5 项：行为与结果证据，不是功能清单 */
  evidence: string[];
  milestone: { companyGate?: string; own?: string };
  /** 复盘 A2：被裁时才补分层已经晚了 */
  tier: "acceptance" | "required";
  /** 一号位的逐条裁决 */
  ruling?: { verdict: "endorse" | "revise" | "reject"; note: string; at: string; by: string };
}
```

落在 `store.commitments: Commitment[]`，跟着整库快照走，不单独做落盘。

两条产品规矩写进实现：

- **`modify` 超过两条时给一句话**（「分歧超过两处通常是结构性的，建议先约谈再回传」），
  **不拦提交**。这是复盘 G3 的经验，不是校验规则——把经验做成硬校验就变成官僚。
- **收敛轮次是算出来的**，从 `revisions` 长度得；不设字段。屏幕上每一个数字都算出来，
  这条规矩在 `store.ts` 文件头第四条已经立过。

---

## 4. 身份与授权：最小，但服务端是真的

四件事，缺一不可。第四件最容易漏，也最贵。

### 4.1 签名身份

`src/lib/identity.ts`，与 `src/lib/access.ts` 同构、共用 `TKOS_ACCESS_SECRET`：
HMAC over `tkos-who-v1:${personId}`。

一人一条链接 `/dri/enter?t=<sig>` → 落 `tkos_who` cookie（httpOnly，30 天）。
生成用 `scripts/dri-link.mjs`，本地跑一次吐几条链接。不做账号、不做找回、不做发信。

**撤销的代价说清楚**：只能轮换 `TKOS_ACCESS_SECRET`，那会同时踢掉一号位的访问
cookie。六个内部人这样是对的；等外部人要进来（陪跑、灯塔）必须换成带 kid 的
签名和一份吊销名单——那一天到了再改，`identity.ts` 是唯一要动的文件。

### 4.2 谁能进哪个区（`src/proxy.ts`）

现在是一把共享口令开全站。改成两个 cookie 两个区：

| 带着 | 能进 |
|---|---|
| `tkos_demo_access`（一号位那把口令） | 全站，照旧 |
| `tkos_who`（签名身份，解出来是 `role: "dri"`） | 只有 `/dri/*` 与 `/api/data`、`/api/health` |
| 两个都有 | 一号位那把说了算 |

`/dri/enter` 进 `PUBLIC_PATHS`——DRI 没有那把共享口令，这是他进来的唯一入口。
它自己的门是 URL 里那道签名。

### 4.3 `viewer()` 改成请求作用域

现在是常量：`const viewer = () => findPerson(tk.VIEWER_ID)`（`store.ts:762`），
所有写操作都盖一号位的名字。改成 `AsyncLocalStorage`（`src/lib/data/actor.ts`），
在 `/api/data` 入口从 cookie 塞进去，**默认值仍是一号位**——70 处调用点一行不动。

### 4.4 方法可见性表（这一条不能省）

`/api/data` 是按方法名分发的单入口，白名单就是 `api` 自己的键
（`src/app/api/data/route.ts:21`）。谁拿到任意一个 cookie 就能调 `signClosure`。

`src/lib/data/scope.ts` 导出

```ts
export const METHOD_SCOPE: Record<keyof Api, "ceo" | "dri" | "both"> = { … }
```

类型标成 `Record<keyof Api, …>`，于是**新加一个方法而忘了分类，`tsc` 直接报错**——
和 `client.ts` 里 `const api: Api` 保证键覆盖是同一个机制。分发前查表，不合法回 403。

DRI 能看到的边界，沿用 HANDOFF §10 已定的「DRI 同步边界 = 分层」：自己域的
Commitment、派给自己的议题（交接包正文）、自己上报的那几条。看不到一号位的对谈记录、
没勾进会议的条目、判断本体全貌。

---

## 5. 页面

新路由组 `src/app/(dri)/`，**自己的 shell，不套 `StageNav`**——DRI 侧没有「议题 / 会议」
这两个大类，顶栏只有「你是谁」加三个去处。

| 路由 | 一句话 |
|---|---|
| `/dri` | 三句话：我的 OM 到哪一步了 / 派给我几件研究 / 我上报的被怎么处置了。是入口，不是仪表盘——没有统计、没有进度条 |
| `/dri/commitment/[periodId]` | 核心页。左边纲领原文，右边逐条标注。一条 Mission 一张卡，卡内不折叠 |
| `/dri/handoff/[issueId]` | 一件研究任务：读交接包 → 写回一份 `ResearchDoc` |
| `/dri/report` | 上报信号。一屏一个表单，四个字段 |

复用 `Panel`/`PanelHead`、`AsyncBoundary`/`useResource`、`Pill` 三档按钮、`.report`
阅读节奏。视觉不新设计一套。硬约束照旧：H2 服务端说了算（不做乐观更新）、H6 URL
可寻址、H7 不用浏览器存储。

---

## 6. 一号位那侧动三处

1. `/outcomes` 从纯只读长出裁决入口：某个域有 `status: "submitted"` 的回传时出一条入口，
   进去逐条裁决（endorse / revise / reject + 一句话）。裁完 `adjudicated`，DRI 那侧看到；
   DRI 收敛后再提交，一号位签一次变 `effective`。
2. `/signals-inbox` 多一类来源标注：「DRI 上报 · <姓名>」与「外部靶点」并列。
3. 议题研究左栏「承接研究 · DRI」页签接真数据，`escalate` 的模拟拆掉。

---

## 7. 运维：跑真实一个月的三条硬前提

- **`TKOS_SEED_FROZEN=1` 先上。** `docker-compose.yml` 现在默认 `0`，意思是谁改一行种子
  文案，下一次重启就把一个月的真实回传全部抹掉换回示例数据，日志里只有一行 warn
  （`persist.ts:31` 那段注释已经把这件事写清楚了，只是开关还没打开）。
- **`replicas: 1` 别动。** 快照是单进程单写者（`persist.ts:9`），两个副本互相覆盖。
- **备份。** `.data/store.json` 每天带日期拷一份，一行 crontab，写进 `deploy/ecs`。
  不做等于拿一个月的真实数据赌一次磁盘。

还有一条数据口径：**9 月周期从空白建，不复用 `seed-agent-domain.ts` 里那五张示例
Mission**（它们是手写的 04 域示例，会跟真实 OM 撞 id）。真实周期的第一件事是把纲领
灌进去。

---

## 8. 顺序

今天 8/19，纲领下发大约在 8 月底，倒推十天。顺序按「最快见到真实数据流动」排，
不按「哪块重要」排。

| | 内容 |
|---|---|
| D1–D2 | 地基：`identity.ts` + `proxy.ts` 两区 + `scope.ts` 可见性表 + `actor.ts` 请求作用域 + DRI shell 与三个空页。判据：六条链接发出去，每个人进来看见自己的名字，且打不到一号位的任何东西 |
| D3 | 上报信号全链路。最短的一条，当天就能真用 |
| D4–D5 | 研究任务收发：两个页面 + 两个方法 + 拆掉 `escalate` 的模拟 |
| D6–D9 | OM 逐条回传：新对象 + 核心页 + 一号位裁决入口 + 纲领机器口 |
| D10 | 冻种子、上备份、把纲领灌进去 |

时间紧时的取舍已经定了：OM 第一版只做「下发 → 回传 → 逐条裁决 → 生效」这一轮，
第二轮修订的 diff 视图不做。

---

## 9. 明确不做

- **今日那三张卡**（每天最多三张的出卡预算、`WithheldItem` 那本账）。live 模式下
  `store.digests` 本来就是空的，这一轮不碰。
- **给潜在议题打分**。将来要让上报的信号自动排序，靠的是打分而不是出卡预算——那时候
  再设计，这一版不预留字段。
- **通知**。网页没有推送能力。这一轮靠在群里说一句「OM 发了，去这个链接」。装一个假的
  通知（页内红点、定时邮件）只会让人以为有推送。
- **飞书那一层**。等三条链路在网页上跑顺了再补，且只做「推到人 + 一键回执」。
- **完整权限模型与审计**。C-1 已定：只做够用的那一层（这一版是 §4.2 两区 + §4.4 方法表）。

---

## 10. 验证

- 纯函数的部分上单测（`vitest`）：签名签发与校验、可见性表覆盖全部 `api` 键、
  Commitment 状态机（含 `adjudicated → submitted` 那条回边与 version+1，以及
  `effective` 之后拒绝一切写入）、
  `modify` 计数那句提示的触发条件。
- 一条 playwright 冒烟：一条 DRI 链接进来 → 上报一条信号 → 一号位在待挑页看到它 →
  接一件研究任务并提交 → 议题研究页那个页签变真。
- 环境的坑照 `HANDOFF.md` §8：Linux 沙箱跑不了 `next build`/`next dev`，只能
  `npx tsc --noEmit` 和逐文件 `npx eslint`；真效果要在他自己机器上 `pnpm dev`。
