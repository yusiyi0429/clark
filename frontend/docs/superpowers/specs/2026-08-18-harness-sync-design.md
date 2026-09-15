# harness 同步：正式版接 M7 本体与新模型网关

日期：2026-08-18 · 分支：`ui/apple-restraint` · 状态：设计已确认，待写实施计划

---

## 1. 背景

`clark-main` 是正式版前端，当前装的是词元云集这家公司的本体，作为案例 demo 用于上周末的展示；它同时也是公司自己的实例。这一轮做的是**词元云集的 MVP 版**，demo 数据保留。

`tkos-lab`（同级独立仓库，Python + FastAPI）是新建的实验台，给方法部门在隔离场景里调 prompt 输出。它承载的是**更新一代**的 harness：模型网关、GraphKnowledge M7 本体客户端、A1a/A3/A4 三个 agent 设计。实验台侧的图谱连接与模型 API 连接**都已验证通过**。

两侧本体接的是同一台主机上的**两代 API**：

| | clark-main（现状） | tkos-lab（对齐目标） |
|---|---|---|
| 地址 | `http://115.190.213.44:8000` | `https://115.190.213.44:8443/graph` |
| 接口 | `POST /v1/context-packs:render`，Bearer，取回一大块 Markdown，本地再用 `compile.ts` 压缩 | M7 四个只读端点 P0/P1/P2/P3，Basic，S01/S02/S03 三配方，16,000 字上限，内容哈希冻结快照 |
| 取不到 | `no_match` → 静默降级 | 三态分开：命中 / `AnchorNotFound`（转纯外部，是正确结果）/ `GraphKnowledgeUnavailable`（就地失败） |
| 锚点 | 无，拿标题当查询 | autopick + 两条相对阈值，编号/分数/次名进 trace |

`clark-main` 代码里对 `GRAPHKNOWLEDGE` 的引用数为 **0**——五个环境变量已由 Sean 预置在 `.env.local`，但没有任何代码读它们。

## 2. 目标与范围

**这一轮的目标只有一条：把 api + harness + 本体的连接跑通**，参考实验台的做法。交互、prompt 内容、UI 后续再调。

### 做

- 新建 `src/lib/graphknowledge/`：M7 客户端、三态错误、S01/S02/S03 配方、autopick 锚点、快照冻结、四层自检
- 新建 `src/lib/models/`：`ModelSpec` 注册表（火山三个别名）+ 现有 `pro`/`flash`/`alt` 槽位映射 + 四项 token 计量
- 新建 `src/lib/agent/harness.ts`：五段 prompt 装配、trace、usage、机器自检、思考深度→研究规模
- 新建 `src/lib/agent/a1a/`：信号 → 议题，三条路
- 改 `src/lib/agent/a3/`、`a4/`：上下文源换 M7，套 harness 基类，**输出形状不动**
- 删 `src/lib/ontology/`（`client.ts` + `compile.ts`），改掉三处调用点
- 新建 `prompts/`：13 个工程 prompt（md），认知段留空
- 新建 `agentRuns` 集合：每次运行落一条可复现记录
- 装 vitest，把实验台的阈值用例翻过来

### 不做（本轮明确排除）

- **会前 / 会后两条 agent 链路**：留空，是之后的测试任务
- **prompt 正文**：A1a/A3/A4 的认知段由 Sean 在测试后提供，本轮只留占位
- **`update_issue` / `new_issue` 的写回**：只留接口，见 §11
- **AWS Bedrock 六个别名**：不搬
- **交互与 UI 调整**
- 与本轮目标无关的重构

## 3. 已确认的取舍

| # | 决策 | 后果 |
|---|---|---|
| 1 | 本体**全面换成 M7**，`render` 那条拆掉 | `src/lib/ontology/` 整个下线；三处调用点改到 M7 |
| 2 | **只搬火山三个别名**，Bedrock 不搬 | 火山三个模型都不吃 `effort`，所以思考深度在正式版只驱动 harness 研究规模，从不发给模型。`acceptsEffort` / `sampling` 能力位仍保留在 `ModelSpec` 上，将来加 Claude 不需要改结构 |
| 3 | A1a **落 Run 记录 + `ignore` 那条真写回** | 三条路都跑、都落 Run；写回只实现 `ignore` |
| 4 | A3/A4 **只换上下文源 + 套 harness 基类** | 输出形状与 validate→repair 循环不动，UI 零改动 |
| 5 | **砍掉实验台的 step-wise 单步重放** | 有意分歧，见 §8 |
| 6 | **装 vitest** | 三个阈值常量有自动化把关 |

## 4. 架构

**TS 原生落地**：把实验台的 harness 逐层翻成 TypeScript，放进 `clark-main`。

不选另外两条的理由：

- **正式版转发实验台 API**——实验台是方法部门的台子（整站一道共用口令、自己的实验记录库、step-wise Run），把生产流量压上去会把两边的生命周期绑死；而且它的产出是「一次实验的结果」，不是正式版要写回 store 的对象。Sean 的要求是「让正式版去对齐」，不是「让正式版去调用」。
- **抽共享 Python 服务部署两次**——正式版现在是单个 Next.js 容器，为此多一个 Python 运行时和一套部署，对 MVP 是纯负债。

代价是**两处代码各自维护**。对齐纪律见 §12。

```
src/lib/graphknowledge/     M7 客户端 / 三态错误 / S01·S02·S03 配方 / autopick / 快照 / 自检
src/lib/models/             ModelSpec 注册表 + pro·flash·alt 槽位 + complete()
src/lib/agent/harness.ts    基类：prompt 装配 / trace / usage / checks / 深度
src/lib/agent/a1a/          run.ts（两次模型调用）+ apply.ts（唯一写 store 的文件）
src/lib/agent/{a3,a4}/      改：上下文源换 M7，套基类
src/lib/ontology/           删
prompts/engineering/*.md    工程 prompt
prompts/cognitive/*.md      认知段（本轮留空）
```

## 5. 组件边界

### 5.1 `src/lib/graphknowledge/`

对外**只有一扇门**：

```ts
openContext(opts: {
  recipe: "S01" | "S02" | "S03";
  prefix: "CARD-" | "ISS-";
  q: string;                  // 自然语言问题，不含指令样板
  anchorCode?: string;        // 显式钉锚点：复现旧运行走这条
}): Promise<OpenedContext>    // throws GraphKnowledgeUnavailable

type OpenedContext = {
  mode: "anchored" | "external_only";
  bundle: ContextBundle | null;        // external_only 时为 null
  anchor: { code: string; score: number; rank: number;
            runnersUp: {code:string;score:number}[]; ambiguous: boolean } | null;
  noAnchorReason: string | null;       // 命中哪条相对规则
  snapshotId: string | null;
  trace: TraceNode[];
  warnings: string[];                  // q 被裁、语义段降级、TLS 未校验……
};
```

`AnchorNotFound` **在这扇门里面就被吃掉**、转成 `mode:"external_only"`；`GraphKnowledgeUnavailable` 原样抛出。这是三态不被混淆的结构保证：调用方拿不到「没找到」这个异常，所以没法误接成失败；也没法把「连不上」当成「没找到」，因为那个异常它必须处理。

内部文件，均不对外导出：

| 文件 | 职责 |
|---|---|
| `errors.ts` | `AnchorNotFound` / `GraphKnowledgeUnavailable` 两个类 |
| `limits.ts` | `P3_MAX_QUERY_CHARS = 100` 与 `clip()`。**服务端约束**，超长是 422 而不是静默截断 |
| `client.ts` | P0/P1/P2/P3 四方法；HTTP 状态 → 异常映射；Basic 认证；`base_url` 判空 |
| `lookup.ts` | `autopick()`：`MAX_CANDIDATES=8`、`TIE_RATIO=0.95`、`FLAT_RATIO=0.90`、`FLAT_MIN_SEEDS=4` |
| `recipes.ts` | `buildS01/S02/S03` → `ContextBundle`；`MAX_CONTEXT_CHARS = 16_000`，截断带显式后缀 |
| `snapshot.ts` | 内容哈希冻结，存进数据层 |
| `check.ts` | 四层自检，供 `/api/graphknowledge/check` |

三配方 P3 参数固定（不受思考深度影响）：

| 配方 | P3 参数 |
|---|---|
| S01 | Signal 标题，`k=5`、`budget=3000` |
| S02 | Issue 标题，`k=3`、`budget=1200` |
| S03 | core question `k=10`、`budget=6000`；Issue 标题 `k=5`、`budget=3000` |

**平台注意**：图服务是 IP + 自签证书。`TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0` 在 Node 里不能靠 fetch 选项实现，需给 undici 传 `dispatcher: new Agent({ connect: { rejectUnauthorized: false } })`。只在 `client.ts` 一处，且必须进 `warnings`——这条链路不防中间人，不能变成一个没人记得的开关。

### 5.2 `src/lib/models/`

```ts
// registry.ts
type ModelSpec = {
  alias: string; display: string;
  providerModelId: string;      // 可由环境变量覆盖
  keyEnv: "ARK_API_KEY" | "ARK_AGENT_API_KEY";
  contextTokens: number;
  acceptsEffort: boolean;       // 火山三个均为 false
  sampling: boolean;            // 能不能发 temperature / top_p
  family: string;
};
// 三个别名：deepseek-pro、deepseek-flash、kimi-k3
```

**key 决定地址，不独立配置**：`ARK_API_KEY` 配 `/api/v3`（model 填接入点 `ep-*`），`ARK_AGENT_API_KEY` 配 `/api/plan/v3`（model 填模型名）。拿套餐 key 去打 `/api/v3` 会**静默多计费**，不报错——所以这条配对写在一处。

```ts
// slots.ts —— 保住正式版现有的不变量
type Slot = "pro" | "flash" | "alt";
resolveModel(slot): ModelConfig | null   // Ark 别名优先；无 Ark key 时回落 DeepSeek 直连
familyOf(model): string
areIndependent(a, b): boolean            // a.family !== b.family
assertSlotSanity(): void                 // 只告警，永不拦截
```

DeepSeek 直连那条回落**不进注册表**，只作为 `slots.ts` 里的一个分支保留——`.env.local` 里 `DEEPSEEK_*` 当前是注释掉的，为一条没启用的路径加两个 `ModelSpec` 只是多两处要维护的地方。保留它是因为删掉属于与本轮无关的行为变更。

**ALT 必须与 PRO 不同家族**这条不变量原样保留。否则交叉评审（rubric L4）和两路独立研究（A3/A4）变成走过场：同一批失败模式会被稳定放过，而通过率看着更好。默认 `pro=deepseek-pro`、`flash=deepseek-flash`、`alt=kimi-k3`——不同家族，且把第二把 key 用上了。

```ts
// complete.ts
callModel(opts: { slot?: Slot; alias?: string; messages: Msg[];
                  maxTokens?: number; temperature?: number;
                  effort?: Effort; json?: boolean })
  : Promise<{ text: string; usage: Usage; ms: number;
              model: string; providerModelId: string;
              effortSent: Effort | null; stopReason: string }>

type Usage = { inputTokens; outputTokens; cachedInputTokens; reasoningTokens };
```

`acceptsEffort=false` 的模型不发 `effort`——发过去是 400，不是被忽略。实际发出去的档位记在 trace 上（空 = 该模型不吃这个字段，不是「没选」）。

**兼容约束**：`a2` / `a6` / `a10` 三个 agent 也在用 `src/lib/agent/json.ts` 的 `callJson()`，它们不在本轮范围内，所以 **`callJson(messages, opts): Promise<string>` 的签名一个字不改**，只把内部改成调 `complete.ts`。另导出 `callModelJson()` 返回 `{ text, usage, ... }` 供 a3/a4/a1a 记账用。

### 5.3 `src/lib/agent/harness.ts`

提供：

- 五段 prompt 装配（工程 prompt + 可替换的 `{{COGNITIVE}}` 段）
- `contextBlock`：`external_only` 时返回 `NO_COMPANY_CONTEXT` 说明块，**永不返回空串**——空串会让模型自己编一套公司战略假设，然后引用它
- `DEPTH` 表：`low/medium/high/xhigh/max` → `{ searchK, maxProps, maxRounds }`，默认 `high`
- trace 累积、usage 累加、机器自检收集
- `AgentRun` 结果结构，含复现坐标：model / snapshotId / recipe / anchor / viewer / asOf / graphknowledgeBaseUrl / evidenceCacheId

### 5.4 `src/lib/agent/a1a/`

- `run.ts` → `A1aResult { route, status, body, trace, checks, usage }`。选路与写正文是**两次**模型调用（`a1a.triage` → `a1a.issue.*`），为的是让「路由选错」和「正文写得不好」在评分时分得开。路由值看不懂**就地失败**，不猜——随便挑一条会产出一份格式完整却走错了路的议题，而且没有任何迹象。
- `apply.ts` → `applyA1aResult(run)`，**唯一碰数据层的文件**。

### 5.5 Run 记录落在哪

新增 `agentRuns` 集合，走**现有**的数据层机制，不另开一套：类型进 `src/lib/data/types.ts`，读写方法进 `api` 对象，因而自动纳入 `POST /api/data` 的方法白名单，并跟着现有的 JSON 快照持久化（`persistSoon()` / 种子指纹失效）走。

一条 Run 记录：`{ id, agent, status, input, output, route?, contextMode, noAnchorReason?, trace[], checks[], checkSummary, usage, violations?, degraded?, 复现坐标… , createdAt, finishedAt }`。

**依赖方向**：`graphknowledge` 与 `models` 互不相识，也都不认识 `agent`；`harness` 依赖这两个；每个 agent 只依赖 `harness` + 自己的 prompt/validate；只有 `apply.ts` 写 store；route 与 UI 层**不许直接 import `graphknowledge`**。

## 6. 数据流

三条链路共用同一根骨架：route 立即返回 → `tasks.ts` 后台跑 → 上下文只在第一步取一次并冻结 → 后续步骤只读快照 → 落 Run 记录 → 只有 apply 层写 store。

### A1a（信号 → 议题）

```
POST /api/agent/a1a { signalId }
  └ runTask("a1a", signalId, …) → 立即返回，UI 轮询
      1. store.signal(signalId)
      2. openContext({ recipe:"S01", prefix:"CARD-", q: signal.headline })
         ├ throws Unavailable ─────────────→ Run{ status:"failed" }，就地停
         ├ mode:"external_only" ─→ 4'
         └ mode:"anchored"      ─→ 3
      3. callModel("a1a.triage") → route
         ├ "ignore"       → 结束，不调第二次模型，status:"ignored"
         ├ "update_issue" → callModel("a1a.issue.update")   // 产出取代旧议题的新议题
         ├ "new_issue"    → callModel("a1a.issue.new")
         └ 其它           → 就地失败
      4' callModel("a1a.issue.external")    // 无外部检索，只凭信号原文
      5. Run 落 agentRuns（trace / checks / usage / 复现坐标）
      6. applyA1aResult(run)
         ├ ignore → 信号留在列表，标注「调研后判为噪音」
         └ 其它   → throw NotWiredYet
```

三条路的语义（照搬实验台）：

| 路由 | 什么时候 | 产出 |
|---|---|---|
| `update_issue` | 已有一条议题在说同一件事，但它的说法被这条信号改变了 | 一条**取代**它的新议题，必须照录旧议题的说法（`replaces.statementBefore`）、说清变的是哪一处、以及为什么是取代而不是另开一条 |
| `new_issue` | 公司还没有承接它的议题 | 一条新的潜在议题 |
| `ignore` | 看着声量很大、甚至来自 CEO，但结合本体分析下来是噪音 | 不改也不新增，只留下这个判断。必须说得出「什么情况下它会重新值得处理」 |

`ignore` 在选路那一步就结束，**空产出在这条路上是正确结果**（`status:"ignored"`，不是 `failed`）。

纯外部路上「取代旧议题」不成立（看不到任何既有议题），三条路只剩两条，由 `a1a.issue.external` 一次调用处理，且**不做外部检索**——考的就是从这段原文能推出什么。

**CEO 加的信号**：即使调研后判为无价值，也**留在信号列表里并标注出来**，由 CEO 自行删除或归档。

### A3 / A4

```
A3: openContext("S02","ISS-", q=issue.statement) → 冻结快照
    → callModelJson(slot:"pro", maxTokens:4000) → validatePreResearch
    → 违规原文回喂重试，MAX_REPAIR=2 → PreResearchDoc（形状不变）

A4: openContext("S03","ISS-", q=issue.statement) → 冻结快照
    → PRO 四节（maxTokens:12000）→ validateResearch → repair ≤ 2
    → if (pro && alt && areIndependent(pro, alt)) ALT 独立反证
        → dedupe(前 24 字去空白) → tagIndependent(alt.model) → 重新校验（不再 repair）
    → ResearchDoc（形状不变）+ challengeCount / challenged
```

快照在上下文那一步冻结一次，后续步骤只读快照，不再访问 GraphKnowledge。

## 7. 错误分级

| 边界 | 出错 | 落到哪 |
|---|---|---|
| 图服务连不上 / 地址为空 | `GraphKnowledgeUnavailable` | Run `failed`，就地停，**不产报告** |
| 图谱里没这条锚点 | 不是错误 | Run 照跑，`contextMode:"external_only"`，UI 顶部横幅换评分尺子，引用为空是对的 |
| P3 语义段降级（`query_embedding_not_cached` / `_failed`） | 不是错误 | 进 `warnings`，P0/P1/P2 的确定性上下文照用 |
| q 超 100 字 | 不是错误 | 由 `clip()` 先裁，裁了进 `warnings`。**不裁会 422**，而 422 的表现是「找不到锚点」——实验台踩过这个坑 |
| 锚点首名次名咬得紧（`< TIE_RATIO`） | 不是错误 | 自检标红「这句问题指向不唯一」，不拦截，由人判断 |
| 模型 401 / 模型未开通 | `ModelUnavailable` | Run `failed`，错误信息带上**该补哪个 key 的变量名**和服务端应答正文 |
| `max_tokens` 截断 | 错误 | 认出 `finish_reason === "length"` 并说人话（现有 `json.ts` 已有，保留） |
| 输出不是 JSON 对象 | `ValueError` | 单元素数组套壳 → 拆开并在 trace 留 `shapeFixed`；其它非对象 → Run `failed`，trace 记实际形状 |
| 校验不过 | 不是错误 | repair ≤ 2 次，超了 `degraded:true` + `violations[]` 一起落 |

后两态绝不能混：图服务挂了要是被当成「图谱里没有这条议题」，每一次运行都会悄悄降级成纯外部，还照样产出一份格式漂亮的报告——那种坏产出没人查得出来。

## 8. 与实验台的有意分歧

这四条是刻意的，不是漏搬：

1. **砍掉 step-wise 单步重放**（`STEPS` / `advance` / `repeat_step` / `MAX_STEPS`）。那是给方法部门重跑单步用的实验台功能；正式版有 `tasks.ts` 整体跑。
2. **锚点查询 `q` 取 `issue.statement`**。实验台里 `q` 是测试人员粘进来的整块 S01 handoff，前 100 字全是「以下内容来自 S01 handoff，请执行 S02 Pre-research。Issue Origin: ...」这类样板，裁到 100 字之后拿去检索的等于是模板文字。正式版有结构化的 `Issue` 对象，`q` **不含任何指令样板**。
3. **A4 的 ALT 独立反证是正式版独有的**，实验台没有这一步。必须保住：`dedupe` 按前 24 字去空白，`tagIndependent` 标 `{ kind:"agent", source:"独立第二源 · ${model}" }`，label 记条数，让「跑了但没找到」和「没跑」分得开。
4. **prompt 用 `.md` 文件**而不是 TS 模板字符串，服务端首次用到时读盘并缓存。理由是 prompt 要能改完就生效、不用重新构建；代价是它不进构建产物。

## 9. 环境变量

`.env.local` 里五个已由 Sean 预置，本轮开始真正读它们：

```bash
TKOS_GRAPHKNOWLEDGE_BASE_URL=https://115.190.213.44:8443/graph   # 无默认值，宁可报「地址为空」
TKOS_GRAPHKNOWLEDGE_AUTH=<user>:<password>                        # Basic
TKOS_GRAPHKNOWLEDGE_VERIFY_TLS=0                                  # IP + 自签证书
TKOS_GRAPHKNOWLEDGE_MOCK=0
TKOS_GRAPHKNOWLEDGE_VIEWER=PSN-01
```

`as_of` **没有环境变量**，默认取运行当天；只有复现旧运行时才从 Run 记录里的复现坐标钉回去。给它一个环境变量意味着有人会把它设成某个日期然后忘掉，之后每次运行都在读一份过期视图，而产出看不出任何异常。

新增：`TKOS_MODEL_MOCK`（默认 `0`，见 §10 ③）。

下线：`TKOS_ONTOLOGY_BASE_URL`、`TKOS_ONTOLOGY_CONTEXT`。

`/api/health` 的 `upstream` 加一项：`graphknowledge: { configured, verifyTls }`——`verifyTls:false` 要在这里露出来，理由同 §5.1。现有的 `ontology` 那一项随 `src/lib/ontology/` 一起去掉。

读环境变量**永不抛异常**——一个 `Number("50 秒")` 会让模块导入失败，表现是每条路由都 500。解析失败记进告警列表，由 `/api/health` 报出来。

认证只报「配了没有」，凭据不进日志、不进自检返回值——那个结构会经 HTTP 暴露出去。

## 10. 验证方式

按从便宜到贵排，前三级不花 token。

**① 类型与 lint** —— `npx tsc --noEmit`；lint 逐文件 `npx eslint <file>`（`npx eslint .` 会超时）。

**② 图谱四层自检（本轮主验收口）** —— `GET /api/graphknowledge/check`，不调模型：

```
网络   base_url 配了没有、TLS 校验开没开、能不能建连
P0     /context/static 能不能取到、viewer / as_of 生效没有
锚点   拿一条真实 issue.statement 跑 autopick，报出编号 / 分数 / 次名 / rank
P3     /context/dynamic 语义段取到没有、有没有降级
```

卡在哪层报哪层。**这一条通了，「api + 本体连接跑通」就算立住了。**

**③ Mock 模型 + 真图谱** —— `TKOS_MODEL_MOCK=1`（对应实验台的 `verify_graphknowledge.py`）：三条链路整跑，证明五段 prompt 装配、快照冻结、Run 落库、`applyA1aResult` 写回都对，一个 token 不烧。

**④ 真模型各一条** —— A1a/A3/A4 各跑一条，看四项 token 计量有没有值、trace 上 `effortSent` 是否为空（火山三个都不吃）、复现坐标齐不齐。

**⑤ 三态各跑一次（整轮最该盯的一条）**

| 输入 | 必须得到 |
|---|---|
| 图谱里有的议题 | 有引用、有公司上下文，`contextMode:"anchored"` |
| 图谱里没有的议题 | **跑完出报告**，`external_only` 横幅，引用为空 |
| 把 `BASE_URL` 临时改错 | **就地失败**，绝不产出报告 |

三种输入必须得到三种不同结果。这条不过，三态等于白做。

**⑥ UI 回归** —— `preview_start { name: "clark" }` 起 dev server（`.claude/launch.json` 已有 `clark`:3000），走一遍参谋室，确认 `PreResearchDoc` / `ResearchDoc` 渲染一个字没变。输出形状不动就是为了这一步能空手过。

**单测（vitest）** —— 仓库此前没有测试框架。本轮装 vitest，只覆盖纯函数：`autopick` 的两条相对规则与 tie 判定、`clip()` 的断句、`recipes` 的 16,000 字截断、`familyOf` / `areIndependent`。这几个都是「改了不会报错、只会让锚点选得越来越差」的常量，是单测最值钱的地方。

## 11. 留给下一轮的接口

| 留口 | 现在的行为 | 等什么 |
|---|---|---|
| `applyA1aResult()` 的 `update_issue` / `new_issue` | Run 已落、产出可见可评分，写回处 `throw NotWiredYet` — **不静默 no-op** | Sean 提供测试后的 prompt |
| `prompts/cognitive/*.md` | 空文件 + 占位说明 | 同上 |
| 会前 / 会后两条 agent 链路 | 不存在 | 之后的测试任务 |

## 12. 对齐纪律

两处代码各自维护，靠三条规矩防漂移：

1. 每个从实验台搬过来的文件，**头部注释写明「对齐自 `tkos-lab/src/tkos_lab/<路径>`」**。
2. **阈值常量逐字照搬，不改**：`TIE_RATIO=0.95`、`FLAT_RATIO=0.90`、`FLAT_MIN_SEEDS=4`、`MAX_CANDIDATES=8`、`MAX_CONTEXT_CHARS=16_000`、`P3_MAX_QUERY_CHARS=100`，以及三配方的 `k`/`budget`。
3. **有意分歧集中记在 §8**，不散落在代码注释里。

这样将来「实验台调了阈值 → 正式版跟」是一次能 diff 出来的比对，不是凭记忆重写。
