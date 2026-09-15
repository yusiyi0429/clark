# harness 同步（下半）：harness 基类与 A1a / A3 / A4 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在上半交付的 `src/lib/graphknowledge/` 与 `src/lib/models/` 之上，装出五段 prompt 装配、机器自检、harness 基类，落地 A1a 三条路，把 A3/A4 的上下文源从 `render` 换到 M7，并删掉 `src/lib/ontology/`。

**Architecture:** 一根骨架三条链路。`harness.ts` 是**被组合的具体类**（不是要继承的模板）：每条链路自己 `new Harness({agent})`，用它的 `openContext` / `callPrompt` / `callMessages` / `finish`，trace 和 token 在基类里累，子类不自己记。A1a 用 `prompts/engineering/*.md` 装 prompt（方法部门改完就生效）；A3/A4 保留现有的 TS prompt builder，只换上下文源，输出形状一个字不动。只有 `a1a/apply.ts` 决定写回什么，store.ts 提供写入原语。

**Tech Stack:** TypeScript 5.9 / Next.js 16.3 App Router / vitest（上半装的）/ 无新依赖。

## Global Constraints

- 阈值常量逐字照搬，不改：`TIE_RATIO=0.95`、`FLAT_RATIO=0.90`、`FLAT_MIN_SEEDS=4`、`MAX_CANDIDATES=8`、`MAX_CONTEXT_CHARS=16_000`、`P3_MAX_QUERY_CHARS=100`，以及三配方的 `k`/`budget`。本半份计划**不碰**这些常量。
- 每个从实验台搬过来的文件，头部注释写明「对齐自 `tkos-lab/src/tkos_lab/<路径>`」。
- 三态永不混：`GraphKnowledgeUnavailable` 一路抛到 `runTask` 外面（Run `failed`，**不产报告**）；`AnchorNotFound` 在上半的 `openContext()` 里就被吃掉，本半份代码拿不到它。
- 上下文段**永不返回空串**：`external_only` 时一律填 `NO_COMPANY_CONTEXT`。空串会让模型自己编一套公司战略假设，然后正常引用它。
- 思考深度用官方五档 `low/medium/high/xhigh/max`，英文原词；火山三个模型 `acceptsEffort=false`，所以这个值在正式版**只驱动 harness 研究规模**，从不发给模型。
- `callJson(messages, opts): Promise<string>` 的签名一个字不改（`a2`/`a6`/`a10` 在用，不在本轮范围内）。
- A3/A4 的输出形状（`PreResearchDoc` / `ResearchDoc`）与 validate→repair 循环**不动**，UI 零改动。
- 读环境变量永不抛异常；凭据不进日志、不进任何经 HTTP 出去的结构。
- `route` 与 UI 层**不许直接 import `@/lib/graphknowledge`**。要用就经 `src/lib/agent/` 下的一层。
- 每个任务结束前跑 `npx tsc --noEmit` 和逐文件 `npx eslint <file>`（`npx eslint .` 会超时）。
- 单测跑 `npx vitest run <file>`。

## 与 spec 的三处收敛（都是有意的，执行时按这里写的做）

1. **`Issue` 上没有 `statement` 字段**。spec §8② 说锚点查询 `q` 取 `issue.statement`；clark-main 的 `Issue` 只有 `title`，而它本来就是一句干净的自然语言议题（不含任何指令样板），正是 spec 那条要求要的东西。所以 A3/A4 的 `q` 取 `issue.title`，A1a 取 `card.headline`。
2. **A1a 的触发走独立 route，不走 `api` 对象**。`store.ts` 已经 import 了 `a3/run` 和 `a4/run`；如果 A1a 的触发也放进 `api`，而 `a1a/apply.ts` 又要写数据层，就成了 `store → a1a/run → a1a/apply → store` 的循环 import。spec §6 写的 `POST /api/agent/a1a` 恰好避开这个环，照它做。
3. **`agentRuns` 的写入不进 `api` 对象**，只导出一个模块级函数（和上半的 `contextSnapshotPut` 同一处理）。`api` 上的每个方法浏览器都能经 `POST /api/data` 直接打；Run 记录的写入口不该对浏览器开放。读方法（`listAgentRuns` / `getAgentRun`）进 `api`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `prompts/engineering/a1a.{triage,issue.update,issue.new,issue.external}.md` | A1a 四个工程 prompt（①②④⑤段），照录实验台 |
| `prompts/cognitive/README.md` | 认知段目录说明；本轮四个 md **不建**，`{{COGNITIVE}}` 留占位 |
| `src/lib/agent/prompts.ts` | 五段装配：读盘 + 缓存 + 占位符替换 |
| `src/lib/agent/checks.ts` | 机器自检（规则可判定的那部分）+ `summarize` + 锚点自检 |
| `src/lib/agent/harness.ts` | `DEPTH` / `NO_COMPANY_CONTEXT` / `Harness` 类 / `AgentRunRecord` 组装 |
| `src/lib/models/mock.ts` | `TKOS_MODEL_MOCK=1` 的假模型，一个 token 不烧 |
| `src/lib/agent/a1a/run.ts` | 三条路，两次模型调用 |
| `src/lib/agent/a1a/apply.ts` | 唯一决定写回什么的文件 |
| `src/lib/agent/company-context.ts` | 给 route 层的门（chat 用），route 不直连 graphknowledge |
| `src/app/api/agent/a1a/route.ts` | A1a 的触发与轮询 |
| `src/lib/data/{types,store}.ts` | `AgentRunRecord` / `Card.agentVerdict` / 三个写入原语 |
| `src/lib/agent/{a3,a4}/{run,prompt}.ts` | 改：上下文源换 M7，套 harness |
| `src/lib/ontology/` | 删 |

---

### Task 1: 五段 prompt 装配与四个 A1a 工程 prompt

**Files:**
- Create: `src/lib/agent/prompts.ts`
- Create: `prompts/engineering/a1a.triage.md`
- Create: `prompts/engineering/a1a.issue.update.md`
- Create: `prompts/engineering/a1a.issue.new.md`
- Create: `prompts/engineering/a1a.issue.external.md`
- Create: `prompts/cognitive/README.md`
- Modify: `next.config.ts`
- Test: `src/lib/agent/prompts.test.ts`

**Interfaces:**
- Consumes: 无（本任务是本半份计划的第一块）
- Produces:
  - `class PromptKeyError extends Error`
  - `const PROMPT_SYSTEM: string`
  - `type CognitiveSource = "runtime" | "default" | "empty"`
  - `type AssembledPrompt = { key: string; system: string; user: string; cognitiveUsed: string; cognitiveSource: CognitiveSource; chars: number }`
  - `async function assemble(key: string, parts: { input?: string; context?: string; evidence?: string; challenges?: string; cognitive?: string }): Promise<AssembledPrompt>`

- [ ] **Step 1: 写失败测试**

`src/lib/agent/prompts.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { assemble, PROMPT_SYSTEM, PromptKeyError } from "./prompts";

const A1A_KEYS = ["a1a.triage", "a1a.issue.update", "a1a.issue.new", "a1a.issue.external"];

describe("五段 prompt 装配", () => {
  it("四个 A1a 工程段都读得到，system 段是固定那一句", async () => {
    for (const key of A1A_KEYS) {
      const p = await assemble(key, { input: "信号原文：X", context: "【公司经营状态】Y" });
      expect(p.system).toBe(PROMPT_SYSTEM);
      expect(p.user).toContain("信号原文：X");
      expect(p.user).toContain("【公司经营状态】Y");
    }
  });

  it("key 不存在时报出 key 名，不回落到空模板", async () => {
    // 回落成空模板的话，模型自由作文，产出仍是一份 JSON —— 看不出 prompt 根本没装上。
    await expect(assemble("a1a.nope", {})).rejects.toThrow(PromptKeyError);
    await expect(assemble("a1a.nope", {})).rejects.toThrow("a1a.nope");
  });

  it("认知段没给、也没有默认文件时，占位说明必须留在 prompt 里", async () => {
    const p = await assemble("a1a.triage", { input: "X" });
    expect(p.cognitiveSource).toBe("empty");
    expect(p.user).toContain("尚未提供");
  });

  it("运行时给了认知段就用它，并记下来源", async () => {
    const p = await assemble("a1a.triage", { input: "X", cognitive: "先问它在说什么" });
    expect(p.cognitiveSource).toBe("runtime");
    expect(p.user).toContain("先问它在说什么");
  });

  it("所有占位符都被换掉，不留花括号", async () => {
    const p = await assemble("a1a.issue.new", {});
    expect(p.user).not.toContain("{{");
    expect(p.user).toContain("（无）");
  });

  it("上下文里的 $& 这类替换符号照原样进 prompt", async () => {
    // String.replace 的第二个参数是字符串时，$& 会被当成「整个匹配」展开 ——
    // 图谱正文里真出现一次 $& 就会把 {{CONTEXT}} 这五个字符塞回去。所以必须用函数形式。
    const p = await assemble("a1a.triage", { context: "毛利率 $& 同比 $' 变化" });
    expect(p.user).toContain("毛利率 $& 同比 $' 变化");
  });

  it("chars 是 system 加 user 的总字数", async () => {
    const p = await assemble("a1a.issue.update", { input: "X" });
    expect(p.chars).toBe(p.system.length + p.user.length);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/prompts.test.ts`
Expected: FAIL，`Failed to resolve import "./prompts"`

- [ ] **Step 3: 建 `prompts/engineering/a1a.triage.md`（照录实验台，一个字不改）**

```markdown
## 输入
你会收到一条信号（外部靶点或内部经营 Evidence）的原文与来源，以及公司当前
战略上下文。

{{INPUT}}

## 公司决策上下文
下面的内容来自公司战略数据库。每行末尾的 [member:x][partition:y][source:z]
是锚点，用于事后核对。【催生的议题】那一段里的 ISS-* 就是这条信号目前已经
关联上的既有议题——判断「要不要取代其中某一条」只能看这一段和上下文里真实
出现过的编号。

{{CONTEXT}}

## 你要想清楚什么
{{COGNITIVE}}

## 这一步只做一件事
定这条信号往哪条路走，三选一：

- `update_issue`：已经有一条既有议题在说同一件事，但它的说法被这条信号改变
  了——应该产出一条新的议题去**取代**那一条。
- `new_issue`：公司现在还没有承接它的议题，应该新建一个潜在议题。
- `ignore`：它看起来量很大，甚至是 CEO 直接给过来的，但分析完之后它是噪音
  ——既不改既有议题，也不新增。

**不要在这一步写议题正文。** 选路和写正文分两次做，是为了让「路由选错」和
「正文写得不好」在评分时分得开：合成一步的话，走错了路只会看到一份怪产出，
看不出该改哪一段。

## 输出格式
只输出 JSON，不要任何解释文字。

判定为 `update_issue` 或 `new_issue` 时：
{"decision": "update_issue" 或 "new_issue",
 "signal_reading": "这条信号在说的事，一句话，不要复述原文",
 "target_issue_code": "要被取代的既有议题编号，只有 update_issue 才给，否则空字符串",
 "rationale": "为什么是这条路，而不是另外两条"}

判定为 `ignore` 时：
{"decision": "ignore",
 "verdict": "此信号应被忽略，不改动也不新增议题",
 "signal_reading": "这条信号在说的事，一句话",
 "reason": "为什么它是噪音——它缺的是哪一点",
 "what_would_change_it": "什么情况下它会重新变得值得处理"}

## 硬约束
- `decision` 只能是 `update_issue` / `new_issue` / `ignore` 三者之一，原样小写
  英文。这三个值是下游分支的开关，换成「修改」「新增」「忽略」会让这一步的
  结果无法被识别。
- `update_issue` 时 `target_issue_code` 必须是上面上下文里**真实出现过**的
  `ISS-*` 编号。图谱里没有的编号一律视为编造。
- 只有当某条既有议题在说**同一件事**时才选 `update_issue`。相邻、相关、可以
  放在一起讨论，都不算——那些是 `new_issue`。
- 判定 `ignore` 时 `verdict` 必须**原样**是「此信号应被忽略，不改动也不新增
  议题」，不要改写、不要加标点。下游按这句话识别这个分支。
- `ignore` 是一个判断，不是搁置。说不出「什么情况下它会重新变得值得处理」的，
  就不要选 `ignore`。
- 上下文里没有的事实不要写进 `rationale` / `reason`。
```

- [ ] **Step 4: 建 `prompts/engineering/a1a.issue.update.md`**

```markdown
## 输入
一条信号的原文与来源，以及上一步的定性结论：它改变了某条既有议题的说法，
要产出一条新的议题去取代那一条。要被取代的编号写在下面。

{{INPUT}}

## 公司决策上下文
下面的内容来自公司战略数据库。每行末尾的 [member:x][partition:y][source:z]
是锚点，用于事后核对。要被取代的那条议题的原说法就在这里面，照录时从这里取。

{{CONTEXT}}

## 你要想清楚什么
{{COGNITIVE}}

## 这一步产出的是取代，不是补充
既有议题**不改字**——它已经被引用过、被讨论过，改掉它等于改掉一段历史。
你要写的是一条**新的议题**：它成立之后，旧那条就不再是当前的说法了。

所以必须同时说清三件事——新议题正文是什么、它和旧那条差在哪一处、为什么是
取代而不是另开一条。第三件说不清，通常就说明这本来该是一条新议题。

## 输出格式
只输出 JSON，不要任何解释文字。

{"decision": "update_issue",
 "target_issue_code": "被取代的既有议题编号",
 "replaces": {"code": "同上",
              "statement_before": "旧议题的说法，从上下文里照录"},
 "issue_statement": "新议题正文，取代旧那条",
 "what_changed": "相对旧议题，变的是哪一处",
 "why_replace_not_new": "为什么是取代，而不是另开一条新议题",
 "shakes_assumption": "动摇哪条战略假设",
 "suggested_handling": "建议怎么处理",
 "cited_member_ids": ["你引用到的 member id"]}

## 硬约束
- `target_issue_code` 必须是上面上下文里真实出现过的 `ISS-*` 编号。
- `statement_before` 从上下文**照录**，不要改写——事后要靠它对出新旧两条差在
  哪里。
- `issue_statement` 不能和 `statement_before` 相同，也不能只差标点：那不是取代。
- `what_changed` 要指到具体一处（范围 / 前提 / 时点 / 取舍的方向），不要写
  「更全面了」「更清晰了」这类。
- `cited_member_ids` 里的每一个 ID 都必须出现在上面的上下文里。编造 ID 视为失败。
- 上下文里没有的事实不要写进来。
- 每段一句到三句，不要展开成段落。
```

- [ ] **Step 5: 建 `prompts/engineering/a1a.issue.new.md`**

```markdown
## 输入
一条信号的原文与来源，以及上一步的定性结论：公司现在还没有承接它的议题，
要新建一个潜在议题。

{{INPUT}}

## 公司决策上下文
下面的内容来自公司战略数据库。每行末尾的 [member:x][partition:y][source:z]
是锚点，用于事后核对。

{{CONTEXT}}

## 你要想清楚什么
{{COGNITIVE}}

## 输出格式
只输出 JSON，不要任何解释文字。

{"decision": "new_issue",
 "issue_statement": "新潜在议题的正文",
 "what_happened": "发生了什么",
 "why_now": "为什么现在重要",
 "shakes_assumption": "动摇哪条战略假设",
 "suggested_handling": "建议怎么处理",
 "cited_member_ids": ["你引用到的 member id"]}

## 硬约束
- `issue_statement` 是议题正文，不是信号摘要：写成一个公司需要想清楚的问题
  或取舍，不要复述发生了什么（那是 `what_happened` 那一段的事）。一到三句。
- `cited_member_ids` 里的每一个 ID 都必须出现在上面的上下文里。编造 ID 视为失败。
- 上下文里没有的事实不要写进来。
- `shakes_assumption` 必须指向上下文里具体的某一条，不能泛泛而谈。
- 四段每段一句到三句，不要展开成段落。
```

- [ ] **Step 6: 建 `prompts/engineering/a1a.issue.external.md`**

```markdown
## 输入
你会收到一条信号（外部靶点或内部经营 Evidence）的原文与来源。

{{INPUT}}

## 公司决策上下文
{{CONTEXT}}

## 你要想清楚什么
{{COGNITIVE}}

## 这一次的特殊之处
公司战略数据库里没有与这条信号对应的锚点，所以你**没有**任何公司内部材料：
不知道公司现有的战略假设是什么，也没有可引用的 member，更看不到任何既有议题
——所以这次不存在「取代某条既有议题」这个选项，只有两条路：新建，或者忽略。

这不是让你停下来。这条信号仍然可能值得变成一个潜在议题——只是这次判断的依据
只有信号本身和公开可查的通行事实。所以要回答的是一个更基本的问题：

**如果只看这条信号本身，它够不够分量成为一个需要公司层面去想的潜在议题？**

值得的标准不是「这件事重要」或「这个话题很热」，而是：它指向的变化，一旦成立，
会让某类企业不得不重新考虑自己在做什么。够不到这个高度的（一次性事件、执行层
面的操作问题、和公司所处领域无关的行业新闻、只是热度高的话题），就是不值得。

宁可判不值得。这条路上没有内部材料兜底，把不够分量的信号放进议题队列，后面
每一步（预研、深度研究）都会照着它跑，代价远大于漏掉一条。

## 输出格式
只输出 JSON，不要任何解释文字。

判定为**不值得**时：
{"decision": "ignore",
 "verdict": "此信号不值得转化为潜在议题",
 "reason": "为什么不值得——它缺的是哪一点",
 "what_would_change_it": "什么情况下它会重新变得值得处理",
 "cited_member_ids": []}

判定为**值得**时：
{"decision": "new_issue",
 "issue_statement": "潜在议题的正文",
 "why_it_qualifies": "值得成为议题的解释",
 "cited_member_ids": []}

## 硬约束
- `decision` 只能是 `ignore` 或 `new_issue`，原样小写英文。这条路上没有既有议题，
  `update_issue` 不成立。
- 判定不值得时，`verdict` 必须**原样**是「此信号不值得转化为潜在议题」，不要
  改写、不要加标点。下游按这句话识别这个分支。
- 判不值得也是一个判断，不是搁置：必须说得出什么情况下它会重新变得值得处理。
- `issue_statement` 是议题正文，不是信号摘要：写成一个公司需要去想清楚的问题或
  取舍，不要复述新闻发生了什么。一到三句。
- `why_it_qualifies` 要说清「一旦成立，什么会不得不变」。两到四句。
- `cited_member_ids` 必须是空数组 `[]`。这次没有任何 member 可引，写进去的一定
  是编的。
- 不要出现「公司现有战略假设是……」「公司此前认为……」这类句子。你不知道，这次
  没有材料告诉你。
- 上下文和信号原文里都没有的事实不要写。
```

- [ ] **Step 7: 建 `prompts/cognitive/README.md`（本轮这个目录里只有这一个文件）**

```markdown
# 认知指令段（第 ③ 段）

这个目录是**方法部门唯一要编辑的地方**。工程段（`prompts/engineering/`）管输入
契约、上下文注入、输出格式、硬约束；认知段管「你要想清楚什么」——同一个工程
骨架配不同的认知指令，产出的判断质量差得远。

## 本轮为什么是空的

A1a / A3 / A4 的认知段正在实验台（`tkos-lab`）里调，测完之后由 Sean 提供。
所以这一轮**故意不建** `a1a.*.md`：建一个空文件比不建更糟——`assemble()` 会
把空文件当成「给过了」（`cognitiveSource: "default"`），而实际上 prompt 里
那一段是空的，从结果上看不出区别。

文件不存在时，`{{COGNITIVE}}` 会被替换成
「（本条 Prompt 的认知指令段尚未提供）」，并且 `cognitiveSource` 记成
`empty`。这句话会跟着 Run 记录一起落盘，所以「这次跑的时候还没有认知段」
在事后是查得出来的。

## 怎么加

按 prompt key 建文件，正文就是要塞进第 ③ 段的那段话，不要写标题：

```
prompts/cognitive/a1a.triage.md
prompts/cognitive/a1a.issue.new.md
prompts/cognitive/a1a.issue.update.md
prompts/cognitive/a1a.issue.external.md
```

改完重启 dev server 生效（`prompts.ts` 首次用到时读盘并缓存）。

运行时也能传：`assemble(key, { cognitive })` 传进来的优先，用于一次性试不同
写法而不改文件。
```

- [ ] **Step 8: 写 `src/lib/agent/prompts.ts`**

```ts
/**
 * 五段 prompt 装配。对齐自 `tkos-lab/src/tkos_lab/prompt/assembler.py`。
 *
 * ① 输入契约 ② 上下文注入 ③ 认知指令 ④ 输出格式 ⑤ 硬约束。
 *
 * ①②④⑤ 在 `prompts/engineering/<key>.md` 里，是工程的事；③ 由运行时传进来，
 * 缺省回落到 `prompts/cognitive/<key>.md`，是方法部门的事。两边分开放，是为了
 * 让改 prompt 的人不用碰代码，也不会顺手把输出格式改坏 —— 输出格式一改，下游
 * 按字段取值的每一处都会静默拿到 undefined。
 *
 * 用 `.md` 文件而不是 TS 模板字符串：prompt 要能改完就生效、不用重新构建。
 * 代价是它不进 webpack 产物，所以 `next.config.ts` 里要显式追踪（见 Step 9）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const ENG = path.join(process.cwd(), "prompts", "engineering");
const COG = path.join(process.cwd(), "prompts", "cognitive");

/**
 * 工程段模板不存在。
 *
 * **不回落到空模板。** 回落的话模型拿到的是一份没有输出格式约束的自由作文题，
 * 而它照样会返回一段 JSON —— 于是「prompt 根本没装上」这件事在结果页上完全
 * 看不出来，只表现为「这个 prompt 效果不好」。
 */
export class PromptKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptKeyError";
  }
}

export const PROMPT_SYSTEM =
  "你是使用 GraphKnowledge 公司上下文的 TKOS 专用 Agent。" +
  "严格按给定的输出格式作答，只输出 JSON，不要任何解释性文字、不要 Markdown 代码围栏。" +
  "上下文里没有的事实一律不要写。";

/** runtime = 这次跑传进来的；default = 用了 `prompts/cognitive/<key>.md`；empty = 两者都没有。 */
export type CognitiveSource = "runtime" | "default" | "empty";

export type AssembledPrompt = {
  key: string;
  system: string;
  user: string;
  cognitiveUsed: string;
  cognitiveSource: CognitiveSource;
  chars: number;
};

// 读盘之后缓存。一次 A4 有十几次模型调用，每次都读盘等于十几次同步 IO，而
// prompt 在一次运行里是不变的。改了 md 重启 dev server 生效。
const cache = new Map<string, string | null>();

async function readOnce(file: string): Promise<string | null> {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  let text: string | null = null;
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = null;
  }
  cache.set(file, text);
  return text;
}

export async function engineeringFrame(key: string): Promise<string> {
  const text = await readOnce(path.join(ENG, `${key}.md`));
  if (text === null) {
    throw new PromptKeyError(`没有工程段模板: ${key}（找的是 prompts/engineering/${key}.md）`);
  }
  return text;
}

export async function defaultCognitive(key: string): Promise<string> {
  return (await readOnce(path.join(COG, `${key}.md`))) ?? "";
}

const FILL = {
  input: "（无）",
  context: "（本次未取到公司上下文）",
  evidence: "（本次无外部材料）",
  challenges: "（本次无红队挑战）",
  cognitive: "（本条 Prompt 的认知指令段尚未提供）",
} as const;

/*
 * 替换一律用**函数形式**的 replacer。
 *
 * `String.replace(re, str)` 会把替换串里的 `$&` / `$'` / `$1` 当成引用展开 ——
 * 图谱正文里真出现一次 `$&`，那一处就会被换回 `{{CONTEXT}}` 这五个字符，
 * 而 prompt 看起来只是「有一处怪字符」，没人会往替换语义上想。
 */
function fill(frame: string, token: string, value: string): string {
  return frame.replace(new RegExp(`\\{\\{${token}\\}\\}`, "g"), () => value);
}

export async function assemble(
  key: string,
  parts: {
    input?: string;
    context?: string;
    evidence?: string;
    challenges?: string;
    cognitive?: string;
  }
): Promise<AssembledPrompt> {
  const frame = await engineeringFrame(key);
  const runtime = (parts.cognitive ?? "").trim();
  const fallback = runtime ? "" : (await defaultCognitive(key)).trim();
  const cognitiveUsed = runtime || fallback;
  const cognitiveSource: CognitiveSource = runtime ? "runtime" : fallback ? "default" : "empty";

  let user = frame;
  user = fill(user, "INPUT", (parts.input ?? "").trim() || FILL.input);
  user = fill(user, "CONTEXT", (parts.context ?? "").trim() || FILL.context);
  user = fill(user, "EVIDENCE", (parts.evidence ?? "").trim() || FILL.evidence);
  user = fill(user, "CHALLENGES", (parts.challenges ?? "").trim() || FILL.challenges);
  user = fill(user, "COGNITIVE", cognitiveUsed || FILL.cognitive);

  return {
    key,
    system: PROMPT_SYSTEM,
    user,
    cognitiveUsed,
    cognitiveSource,
    chars: PROMPT_SYSTEM.length + user.length,
  };
}
```

- [ ] **Step 9: 让 `prompts/` 进 standalone 产物**

`next.config.ts`，在 `output: "standalone"` 下面加：

```ts
  /*
   * `prompts/` 是运行时读盘的，没有任何 import 指向它，所以文件追踪看不见它 ——
   * 不加这一条，容器里跑起来每次都是「没有工程段模板」，而本地 dev 一切正常。
   * 键是路由 glob，值是从项目根解析的文件 glob（见
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md）。
   */
  outputFileTracingIncludes: {
    "/*": ["./prompts/**/*.md"],
  },
```

- [ ] **Step 10: 跑测试确认全过**

Run: `npx vitest run src/lib/agent/prompts.test.ts`
Expected: PASS，7 个用例

- [ ] **Step 11: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/prompts.ts src/lib/agent/prompts.test.ts next.config.ts
```

- [ ] **Step 12: 提交**

```bash
git add src/lib/agent/prompts.ts src/lib/agent/prompts.test.ts prompts next.config.ts
git commit -m "feat(prompts): 五段 prompt 装配与 A1a 四个工程 prompt"
```

---

### Task 2: 机器自检

**Files:**
- Create: `src/lib/agent/checks.ts`
- Test: `src/lib/agent/checks.test.ts`

**Interfaces:**
- Consumes: 上半的 `OpenedContext` / `AnchorPick`（`@/lib/graphknowledge`）
- Produces:
  - `type Check = { name: string; ok: boolean; detail: string }`
  - `type CheckSummary = { passed: number; total: number; allPassed: boolean; failed: string[] }`
  - `function summarize(checks: Check[]): CheckSummary`
  - `function a1aIsIgnore(out: Out): boolean`
  - `function a1aTriage(out: Out, memberIds: Set<string>, raw: string): Check[]`
  - `function a1aIgnore(out: Out): Check[]`
  - `function a1aNew(out: Out, memberIds: Set<string>): Check[]`
  - `function a1aUpdate(out: Out, memberIds: Set<string>): Check[]`
  - `function a1aExternal(out: Out): Check[]`
  - `function anchorChecks(opened: OpenedContext): Check[]`
  - `type Out = Record<string, unknown>`
  - `const IGNORE_VERDICT: string` / `const NO_ISSUE_VERDICT: string`

- [ ] **Step 1: 写失败测试**

`src/lib/agent/checks.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  a1aExternal,
  a1aIgnore,
  a1aIsIgnore,
  a1aNew,
  a1aTriage,
  a1aUpdate,
  anchorChecks,
  IGNORE_VERDICT,
  NO_ISSUE_VERDICT,
  summarize,
} from "./checks";

const failed = (cs: { name: string; ok: boolean }[]) => cs.filter((c) => !c.ok).map((c) => c.name);

describe("summarize", () => {
  it("数出过了几条、哪几条没过", () => {
    const s = summarize([
      { name: "甲", ok: true, detail: "" },
      { name: "乙", ok: false, detail: "" },
    ]);
    expect(s).toEqual({ passed: 1, total: 2, allPassed: false, failed: ["乙"] });
  });
});

describe("a1aIsIgnore", () => {
  it("decision、判词、旧的 relevant 三种都认", () => {
    expect(a1aIsIgnore({ decision: "ignore" })).toBe(true);
    expect(a1aIsIgnore({ verdict: IGNORE_VERDICT })).toBe(true);
    expect(a1aIsIgnore({ verdict: NO_ISSUE_VERDICT })).toBe(true);
    expect(a1aIsIgnore({ relevant: false })).toBe(true);
    expect(a1aIsIgnore({ decision: "new_issue" })).toBe(false);
  });
});

describe("a1aTriage", () => {
  it("路由被归一化过要标出来", () => {
    const cs = a1aTriage(
      { decision: "update_issue", signal_reading: "甲", rationale: "一二三四五六七八九十" },
      new Set(["ISS-01"]),
      "修改"
    );
    expect(failed(cs)).toContain("路由取值原样合法");
    // 归一化过仍然往下走 —— 认得出对应关系就不该拦，只是要在结果页上留痕。
    expect(cs.find((c) => c.name === "路由取值原样合法")?.detail).toContain("修改");
  });

  it("update_issue 指的议题不在上下文里就是编的", () => {
    const cs = a1aTriage(
      {
        decision: "update_issue",
        signal_reading: "甲",
        rationale: "一二三四五六七八九十",
        target_issue_code: "ISS-99",
      },
      new Set(["ISS-01"]),
      "update_issue"
    );
    expect(failed(cs)).toEqual(["要取代的议题在上下文里存在"]);
  });

  it("new_issue 不查议题编号", () => {
    const cs = a1aTriage(
      { decision: "new_issue", signal_reading: "甲", rationale: "一二三四五六七八九十" },
      new Set(),
      "new_issue"
    );
    expect(failed(cs)).toEqual([]);
    expect(cs.map((c) => c.name)).not.toContain("指名了要取代的既有议题");
  });
});

describe("a1aIgnore", () => {
  it("说不出什么情况下会重新值得处理的，是搁置不是判断", () => {
    const cs = a1aIgnore({ verdict: IGNORE_VERDICT, reason: "只有一个来源", what_would_change_it: "无" });
    expect(failed(cs)).toEqual(["说得出什么情况下它会重新值得处理"]);
  });

  it("判词改写过就不算原样给出", () => {
    const cs = a1aIgnore({
      verdict: "此信号应被忽略。",
      reason: "只有一个来源",
      what_would_change_it: "出现第二个独立来源",
    });
    expect(failed(cs)).toEqual(["判词原样给出"]);
  });
});

describe("a1aUpdate", () => {
  it("新说法等于旧说法（只差标点）不是取代", () => {
    const cs = a1aUpdate(
      {
        target_issue_code: "ISS-01",
        replaces: { code: "ISS-01", statement_before: "我们赌模型能力带动交付。" },
        issue_statement: "我们赌模型能力带动交付",
        what_changed: "范围从三个行业收到一个",
        why_replace_not_new: "说的是同一件事",
        cited_member_ids: ["ISS-01"],
      },
      new Set(["ISS-01"])
    );
    expect(failed(cs)).toEqual(["新议题不是旧议题的原地重复"]);
  });

  it("编造的引用 ID 要点名报出来", () => {
    const cs = a1aUpdate(
      {
        target_issue_code: "ISS-01",
        replaces: { code: "ISS-01", statement_before: "旧的说法在这里。" },
        issue_statement: "新的说法把范围收窄到一个行业。",
        what_changed: "范围从三个行业收到一个",
        why_replace_not_new: "说的是同一件事",
        cited_member_ids: ["ISS-01", "JDG-编"],
      },
      new Set(["ISS-01"])
    );
    expect(failed(cs)).toEqual(["引用 ID 真实"]);
    expect(cs.find((c) => c.name === "引用 ID 真实")?.detail).toContain("JDG-编");
  });
});

describe("a1aNew", () => {
  it("四段缺哪几段要点名", () => {
    const cs = a1aNew(
      { issue_statement: "我们靠模型能力建立的差异还剩多少？", why_now: "招标季在三个月内" },
      new Set()
    );
    expect(cs.find((c) => c.name === "四段齐全")?.detail).toContain("what_happened");
    expect(cs.find((c) => c.name === "四段齐全")?.detail).toContain("suggested_handling");
  });
});

describe("a1aExternal", () => {
  it("纯外部路上编造公司上下文要被抓出来", () => {
    const cs = a1aExternal({
      decision: "new_issue",
      issue_statement: "这条变化一旦成立，谁必须重新考虑自己在做什么？",
      why_it_qualifies: "公司现有战略假设是靠模型能力带动交付，这条正好压在它上面，二十字以上。",
      cited_member_ids: [],
    });
    expect(failed(cs)).toEqual(["没有编造公司上下文"]);
  });

  it("纯外部路上引用非空一定是编的", () => {
    const cs = a1aExternal({
      decision: "new_issue",
      issue_statement: "这条变化一旦成立，谁必须重新考虑自己在做什么？",
      why_it_qualifies: "它指向的是交付侧入口的转移，一旦成立，靠模型能力定位的公司都要重新算账。",
      cited_member_ids: ["ISS-01"],
    });
    expect(failed(cs)).toEqual(["引用为空"]);
  });
});

describe("anchorChecks", () => {
  it("图谱里没锚点判**通过** —— 那是分支，不是故障", () => {
    const cs = anchorChecks({
      mode: "external_only",
      bundle: null,
      anchor: null,
      noAnchorReason: "这一池分不出高低",
      snapshotId: null,
      trace: [],
      warnings: [],
    });
    expect(cs[0].ok).toBe(true);
    expect(cs[0].detail).toContain("纯外部");
  });

  it("首名次名咬得紧要标红，但只提示不拦截", () => {
    const cs = anchorChecks({
      mode: "anchored",
      bundle: null,
      anchor: {
        origin: "auto",
        anchorCode: "ISS-01",
        score: 0.81,
        label: "交付侧入口",
        state: "open",
        channel: "A3",
        prefix: "ISS-",
        rank: 1,
        rankOverall: 1,
        k: 8,
        ambiguous: true,
        pool: { n: 6, topScore: 0.81, bottomScore: 0.6, topCode: "ISS-01", flatness: 0.74 },
        querySent: "交付侧入口",
        runnersUp: [{ code: "ISS-02", score: 0.79, label: "模型能力对比" }],
        warnings: [],
      },
      noAnchorReason: null,
      snapshotId: "ctx-x",
      trace: [],
      warnings: [],
    });
    expect(cs[0].ok).toBe(false);
    expect(cs[0].detail).toContain("ISS-02");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/checks.test.ts`
Expected: FAIL，`Failed to resolve import "./checks"`

- [ ] **Step 3: 写 `src/lib/agent/checks.ts`**

```ts
/**
 * 机器自检。对齐自 `tkos-lab/src/tkos_lab/checks/machine.py`。
 *
 * 只做**规则可判定**的那部分——字段齐全、数量区间、引用 ID 是否真实存在、
 * 是否踩了明令禁止的写法。「判断抽得准不准」「反证质量高不高」只能人评，
 * 不在这里。
 *
 * 与 `src/lib/agent/rules.ts`（A3/A4 的质量门）分工不同：那一套判「这份报告
 * 写得合不合规」并且不过就打回重生成；这一套判「这次运行有没有踩硬线」，
 * **只记不拦**，落进 Run 记录供评分的人看。
 */
import type { OpenedContext } from "@/lib/graphknowledge";

export type Out = Record<string, unknown>;

export type Check = { name: string; ok: boolean; detail: string };

export type CheckSummary = {
  passed: number;
  total: number;
  allPassed: boolean;
  failed: string[];
};

const c = (name: string, ok: boolean, detail = ""): Check => ({ name, ok: Boolean(ok), detail });

/** 取字符串字段。不是字符串就当没给 —— 下游一律按 `""` 处理，不抛。 */
const t = (o: Out, key: string): string => {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
};

const list = (o: Out, key: string): string[] => {
  const v = o[key];
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
};

const nested = (o: Out, key: string): Out => {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Out) : {};
};

/** 句数。中英文句末标点都算，连续标点算一句。 */
const sentences = (text: string): number =>
  text.split(/[。！？!?.;；\n]+/).filter((s) => s.trim()).length;

/** 去掉空白和标点，用来判两段话是不是同一句。改一个逗号不算改。 */
const squash = (text: string): string =>
  text.replace(/[\s，,。.、；;：:！!？?「」“”"'（）()]+/g, "");

function citedOk(cited: string[], memberIds: Set<string>): [boolean, string] {
  if (cited.length === 0) return [true, "未引用任何 member"];
  const bad = cited.filter((id) => !memberIds.has(id));
  return [
    bad.length === 0,
    bad.length ? `编造的 ID: ${bad.slice(0, 5).join(", ")}` : `${cited.length} 个引用全部真实`,
  ];
}

/*
 * A1a 两条「不产出议题」的路各有自己的判词，**不能共用一句**：
 * 前者是「公司里已经有议题在管这件事的位置，而这条信号不该动它们」，
 * 后者是「图谱里根本没有相关位置，光凭这条信号也不够分量」。
 * 两句话原样进 checks，是下游和评分人识别分支的唯一凭据。
 */
export const IGNORE_VERDICT = "此信号应被忽略，不改动也不新增议题";
export const NO_ISSUE_VERDICT = "此信号不值得转化为潜在议题";

export function a1aIsIgnore(out: Out): boolean {
  if (out.decision === "ignore") return true;
  if (out.relevant === false) return true;
  return [IGNORE_VERDICT, NO_ISSUE_VERDICT].includes(t(out, "verdict"));
}

/** 选路那一步的自检。只判「选得清不清楚」，不判「选得对不对」——后者要人看。 */
export function a1aTriage(out: Out, memberIds: Set<string>, raw: string): Check[] {
  const dec = t(out, "decision");
  const reading = t(out, "signal_reading");
  const why = t(out, "rationale") || t(out, "reason");
  const normalized = Boolean(raw) && raw !== dec;
  const cs: Check[] = [
    c(
      "路由取值原样合法",
      !normalized,
      normalized
        ? `收到「${raw}」，已按 ${dec} 处理；下游按这三个值分支，请在 Prompt 里把取值定死`
        : ""
    ),
    c("一句话说清了信号在说什么", Boolean(reading)),
    c("说清了为什么走这条路", why.length >= 10, `${why.length} 字`),
  ];
  if (dec === "update_issue") {
    const code = t(out, "target_issue_code");
    cs.push(c("指名了要取代的既有议题", Boolean(code)));
    cs.push(
      c(
        "要取代的议题在上下文里存在",
        Boolean(code) && memberIds.has(code),
        code && !memberIds.has(code) ? `${code} 不在本次上下文里，是编的` : ""
      )
    );
  }
  return cs;
}

/**
 * 判噪音那条路的自检。
 *
 * 这条路的产出是「什么都不做」，所以要盯的就是它有没有资格什么都不做。
 * 说不出「什么情况下它会重新值得处理」的，是搁置不是判断 —— 下次同一条信号
 * 再来，还是一样卡着。
 */
export function a1aIgnore(out: Out): Check[] {
  const verdict = t(out, "verdict");
  const later = t(out, "what_would_change_it");
  return [
    c(
      "判词原样给出",
      verdict === IGNORE_VERDICT,
      verdict === IGNORE_VERDICT ? "" : `实际是「${verdict}」，应为「${IGNORE_VERDICT}」`
    ),
    c("说清了为什么是噪音", Boolean(t(out, "reason"))),
    c(
      "说得出什么情况下它会重新值得处理",
      later.length >= 6,
      later.length < 6 ? "说不出这一条的是搁置，不是判断" : ""
    ),
  ];
}

export function a1aNew(out: Out, memberIds: Set<string>): Check[] {
  const issue = t(out, "issue_statement");
  const fields = ["what_happened", "why_now", "shakes_assumption", "suggested_handling"];
  const missing = fields.filter((f) => !t(out, f));
  const [ok, detail] = citedOk(list(out, "cited_member_ids"), memberIds);
  return [
    c("给出了议题正文", Boolean(issue), `${issue.length} 字`),
    c("议题正文不超过三句", sentences(issue) <= 3, `${sentences(issue)} 句`),
    c("四段齐全", missing.length === 0, missing.length ? `缺: ${missing.join(", ")}` : ""),
    c("引用 ID 真实", ok, detail),
    c("第三段指向具体战略", t(out, "shakes_assumption").length >= 8),
  ];
}

/**
 * 取代既有议题那条路的自检。比新建多盯三件事，都是「取代」这个动作特有的：
 * 被取代的那条得是真的、旧说法得照录下来（否则事后对不出改了哪里）、
 * 新说法不能等于旧说法（那不是取代，是把同一句话再抄一遍）。
 */
export function a1aUpdate(out: Out, memberIds: Set<string>): Check[] {
  const rep = nested(out, "replaces");
  const code = t(out, "target_issue_code") || t(rep, "code");
  const before = t(rep, "statement_before") || t(out, "statement_before");
  const after = t(out, "issue_statement");
  const changed = t(out, "what_changed");
  const same = Boolean(after) && squash(after) === squash(before);
  const [ok, detail] = citedOk(list(out, "cited_member_ids"), memberIds);
  return [
    c("指名了被取代的议题", Boolean(code)),
    c(
      "被取代的议题在上下文里存在",
      Boolean(code) && memberIds.has(code),
      code && !memberIds.has(code) ? `${code} 不在本次上下文里，是编的` : ""
    ),
    c(
      "照录了旧议题的说法",
      Boolean(before),
      before ? `${before.length} 字` : "没有旧说法，事后对不出改了哪一处"
    ),
    c("给出了新议题正文", Boolean(after), `${after.length} 字`),
    c("新议题不是旧议题的原地重复", !same, same ? "新旧两条几乎一样——那不是取代" : ""),
    c("说清了变的是哪一处", changed.length >= 8, `${changed.length} 字`),
    c("说清了为什么是取代而不是另开一条", Boolean(t(out, "why_replace_not_new"))),
    c("引用 ID 真实", ok, detail),
  ];
}

/** 纯外部那条路上不该出现的措辞：没有公司上下文时说这些，只能是编的。 */
const PHANTOM_CONTEXT = [
  "公司现有战略假设",
  "公司此前认为",
  "公司战略假设是",
  "根据公司上下文",
  "公司内部数据显示",
];

/**
 * A1a 纯外部分支的自检。
 *
 * 与 `a1aNew` / `a1aUpdate` 分开，因为标准不同：这条路上没有公司上下文，
 * 四段式的「动摇哪条战略假设」根本无从判断，拿那把尺子来量会把对的产出量成
 * 错的。这里盯的是另外两件事——判词有没有原样给出，以及有没有凭空造出公司
 * 内部材料。
 */
export function a1aExternal(out: Out): Check[] {
  if (a1aIsIgnore(out)) {
    const verdict = t(out, "verdict");
    const later = t(out, "what_would_change_it");
    return [
      c(
        "判词原样给出",
        verdict === NO_ISSUE_VERDICT,
        verdict === NO_ISSUE_VERDICT ? "" : `实际是「${verdict}」，应为「${NO_ISSUE_VERDICT}」`
      ),
      c("不值得必须给理由", Boolean(t(out, "reason"))),
      c(
        "说得出什么情况下它会重新值得处理",
        later.length >= 6,
        later.length < 6 ? "说不出这一条的是搁置，不是判断" : ""
      ),
    ];
  }
  const issue = t(out, "issue_statement");
  const why = t(out, "why_it_qualifies");
  const blob = issue + why;
  const phantom = PHANTOM_CONTEXT.filter((w) => blob.includes(w));
  const cited = list(out, "cited_member_ids");
  return [
    c("给出了议题正文", Boolean(issue), `${issue.length} 字`),
    c("给出了值得成为议题的解释", why.length >= 20, `${why.length} 字`),
    // 议题正文最多三句。超了通常是把信号原文摘要照抄进来了 —— 「议题」是一个要
    // 想清楚的问题，一句话说不完就说明还没想清楚。
    c("议题正文不超过三句", sentences(issue) <= 3, `${sentences(issue)} 句`),
    c(
      "没有编造公司上下文",
      phantom.length === 0,
      phantom.length ? `出现了: ${phantom.join("、")}` : "本次无公司上下文，产出也没假装有"
    ),
    c(
      "引用为空",
      cited.length === 0,
      cited.length
        ? `引了 ${cited.length} 个 member，但本次没有任何 member 可引`
        : "本次无公司上下文，引用为空是对的"
    ),
  ];
}

/**
 * 锚点与问题是否对得上。**不拦截，只把判断依据摆出来。**
 *
 * 最坏的失败是「问题问 A、锚点指向 B」——产出看着完全合理，但用的是另一条
 * 议题的上下文。那种偏差会被归到 Prompt 头上，然后往错误的方向改。
 */
export function anchorChecks(opened: OpenedContext): Check[] {
  if (opened.mode === "external_only") {
    /*
     * 这条**判通过**。没有锚点不是错——它是一条正常分支，说明这条输入对公司
     * 现有的战略方向来说还太新，图谱里还没有它的位置。但它必须写清楚，否则
     * 评分的人会拿「有公司上下文」的标准去评一份根本没有公司上下文的产出：
     * 「没引用任何战略假设」在这条路上是对的，在那条路上才是错的。
     */
    return [
      c(
        "本次无公司上下文（纯外部）",
        true,
        `${opened.noAnchorReason ?? "图谱里没有对应锚点"}。` +
          "评这份产出时按纯外部标准：引用应为空，不该出现公司内部材料"
      ),
    ];
  }
  const a = opened.anchor;
  if (!a) {
    // 显式钉了锚点（复现旧运行）。这时候没有分数可比，只报事实。
    return [c("锚点与问题相关", true, "锚点由调用方钉住，本次不做相关度核验")];
  }
  const label = a.label.length > 24 ? `（${a.label.slice(0, 24)}…）` : a.label ? `（${a.label}）` : "";
  if (a.ambiguous && a.runnersUp.length) {
    const u = a.runnersUp[0];
    return [
      c(
        "锚点与问题相关",
        false,
        `${a.anchorCode}(${a.score}) 与 ${u.code}(${u.score}) 分数接近，` +
          `这句问题同时像两条议题；上下文只装了 ${a.anchorCode}${label}`
      ),
    ];
  }
  const alt = a.runnersUp.length
    ? `；次名 ${a.runnersUp.slice(0, 2).map((u) => `${u.code}(${u.score})`).join("、")}`
    : "";
  return [
    c("锚点与问题相关", true, `自动选定 ${a.anchorCode}${label}，P3 首名（相似度 ${a.score}）${alt}`),
  ];
}

export function summarize(checks: Check[]): CheckSummary {
  const passed = checks.filter((x) => x.ok).length;
  return {
    passed,
    total: checks.length,
    allPassed: passed === checks.length,
    failed: checks.filter((x) => !x.ok).map((x) => x.name),
  };
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `npx vitest run src/lib/agent/checks.test.ts`
Expected: PASS，12 个用例

- [ ] **Step 5: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/checks.ts src/lib/agent/checks.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/checks.ts src/lib/agent/checks.test.ts
git commit -m "feat(checks): A1a 机器自检与锚点相关度自检"
```

---

### Task 3: Run 记录类型与数据层写入原语

**Files:**
- Modify: `src/lib/data/types.ts`（在 `Card` 接口末尾加一个字段；文件末尾加四个类型）
- Modify: `src/lib/data/store.ts`（`store` 里加一个集合；加三个导出函数；`api` 里加两个读方法）
- Test: `src/lib/data/agent-runs.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type AgentUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number }`
  - `type AgentTraceNode = { at: string; label: string; kind: string; detail: Record<string, unknown>; ms?: number; usage?: AgentUsage; error?: string }`
  - `type AgentCheck = { name: string; ok: boolean; detail: string }`
  - `interface AgentRunRecord`（字段见 Step 3）
  - `type CardAgentVerdict = { route: "ignore"; verdict: string; reason: string; reasonToRevisit: string; runId: string; at: string }`
  - `Card.agentVerdict?: CardAgentVerdict`
  - `export const MAX_AGENT_RUNS = 200`
  - `export function agentRunPut(rec: AgentRunRecord): void`
  - `export function markCardAgentVerdict(cardId: string, verdict: CardAgentVerdict): boolean`
  - `export function agentSignalInput(cardId: string): { card: Card; issue: Issue } | null`
  - `api.listAgentRuns(agent?: string): Promise<AgentRunRecord[]>`
  - `api.getAgentRun(id: string): Promise<AgentRunRecord | null>`

- [ ] **Step 1: 写失败测试**

`src/lib/data/agent-runs.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { agentRunPut, api, MAX_AGENT_RUNS, markCardAgentVerdict } from "./store";
import type { AgentRunRecord } from "./types";

const rec = (id: string, agent: AgentRunRecord["agent"] = "A1a"): AgentRunRecord => ({
  id,
  agent,
  status: "ok",
  input: "X",
  output: {},
  contextMode: "anchored",
  trace: [],
  checks: [],
  checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
  usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 },
  slot: "pro",
  modelAlias: "deepseek-pro",
  providerModelId: "ep-x",
  depth: "high",
  snapshotId: "ctx-x",
  contextRecipe: "S01",
  contextAnchor: "CARD-01",
  contextViewer: "PSN-01",
  contextAsOf: "2026-08-18",
  graphknowledgeBaseUrl: "https://example/graph",
  warnings: [],
  createdAt: "2026-08-18T00:00:00.000Z",
  finishedAt: "2026-08-18T00:00:01.000Z",
  latencyMs: 1000,
});

describe("agentRuns", () => {
  it("最新的排在最前，按 agent 过滤", async () => {
    agentRunPut(rec("RUN-a", "A3"));
    agentRunPut(rec("RUN-b", "A1a"));
    const all = await api.listAgentRuns();
    expect(all[0].id).toBe("RUN-b");
    expect((await api.listAgentRuns("A3")).map((r) => r.id)).toEqual(["RUN-a"]);
    expect((await api.getAgentRun("RUN-a"))?.agent).toBe("A3");
    expect(await api.getAgentRun("RUN-nope")).toBeNull();
  });

  it("超过上限就丢最老的 —— store.json 是整份重写的，不设上限它会一直长", async () => {
    for (let i = 0; i < MAX_AGENT_RUNS + 5; i += 1) agentRunPut(rec(`RUN-${i}`));
    const all = await api.listAgentRuns();
    expect(all.length).toBe(MAX_AGENT_RUNS);
    expect(all.some((r) => r.id === "RUN-0")).toBe(false);
  });

  it("标注一条信号：卡照旧留在列表里，只是多了个标注", async () => {
    const pending = await api.listPending();
    const card = pending[0];
    expect(
      markCardAgentVerdict(card.id, {
        route: "ignore",
        verdict: "此信号应被忽略，不改动也不新增议题",
        reason: "只有一个来源",
        reasonToRevisit: "出现第二个独立来源",
        runId: "RUN-b",
        at: "2026-08-18T00:00:01.000Z",
      })
    ).toBe(true);
    const after = (await api.listPending()).find((x) => x.id === card.id);
    expect(after?.agentVerdict?.route).toBe("ignore");
    // 关键：**没有**被处置掉。CEO 递上来的信号哪怕判为无价值也不能自动消失，
    // 删除或归档是他自己的动作。
    expect(after?.disposedAs).toBeUndefined();
  });

  it("卡不存在时返回 false，不抛", () => {
    expect(
      markCardAgentVerdict("CARD-不存在", {
        route: "ignore",
        verdict: "x",
        reason: "x",
        reasonToRevisit: "x",
        runId: "RUN-b",
        at: "2026-08-18T00:00:01.000Z",
      })
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/data/agent-runs.test.ts`
Expected: FAIL，`agentRunPut is not exported`

- [ ] **Step 3: 在 `src/lib/data/types.ts` 末尾加四个类型**

```ts
/**
 * 一次 agent 运行的可复现记录。
 *
 * 这里的 trace / usage / check 三个类型**故意写成结构类型**，不从
 * `@/lib/graphknowledge` 或 `@/lib/models` import：数据层不认识那两层，
 * 反过来 import 会让「route 与 UI 不许直连 graphknowledge」这条边界从
 * types.ts 上被绕开。上层的具体类型（`TraceNode` / `Usage` / `Check`）
 * 结构上与这里一致，赋值不需要转换。
 */
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export type AgentTraceNode = {
  at: string;
  label: string;
  /** graph | anchor | context | model | local */
  kind: string;
  detail: Record<string, unknown>;
  ms?: number;
  usage?: AgentUsage;
  error?: string;
};

export type AgentCheck = { name: string; ok: boolean; detail: string };

export interface AgentRunRecord {
  id: string;
  agent: "A1a" | "A3" | "A4";
  /**
   * `ignored` 是 A1a 判「不改也不新增」那条路：**产出为空是正确结果**，
   * 和 `failed` 完全两回事。混成一个值之后，「这条信号被判为噪音」和
   * 「这次跑挂了」在屏幕上长一个样。
   */
  status: "ok" | "ignored" | "failed";
  input: string;
  output: Record<string, unknown> | null;
  route?: "update_issue" | "new_issue" | "ignore";
  /** 空 = 连装上下文这一步都没走到（例如第一步就挂了）。 */
  contextMode: "anchored" | "external_only" | "";
  noAnchorReason?: string;
  trace: AgentTraceNode[];
  checks: AgentCheck[];
  checkSummary: { passed: number; total: number; allPassed: boolean; failed: string[] };
  usage: AgentUsage;
  /** A3/A4 的质量门违规原文，超了重修上限时和 `degraded` 一起落。 */
  violations?: string[];
  degraded?: boolean;
  // ---- 复现坐标：照这几个值能把同一次运行再跑一遍 ----
  slot: string;
  modelAlias: string;
  providerModelId: string;
  depth: string;
  snapshotId: string;
  contextRecipe: string;
  contextAnchor: string;
  contextViewer: string;
  contextAsOf: string;
  graphknowledgeBaseUrl: string;
  /** q 被裁、语义段降级、TLS 未校验…… */
  warnings: string[];
  error?: string;
  createdAt: string;
  finishedAt: string;
  latencyMs: number;
}

/**
 * A1a 调研之后判为噪音时留在信号卡上的标注。
 *
 * **卡不因此消失。** 被 CEO 递上来的信号哪怕被判定为没价值也要留在信号列表里，
 * 只是标注出来 —— 删除或归档是他自己的动作。自动收走的话，他会以为系统漏了
 * 这条，而系统其实是判过的。
 */
export type CardAgentVerdict = {
  route: "ignore";
  /** 模型原样给的判词，照录。下游按这句话识别分支。 */
  verdict: string;
  reason: string;
  /** 什么情况下它会重新值得处理。说不出这一条的是搁置，不是判断。 */
  reasonToRevisit: string;
  runId: string;
  at: string;
};
```

- [ ] **Step 4: 在 `src/lib/data/types.ts` 的 `Card` 接口里加字段**

紧接现有的 `dismissReason?: string;` 之后（`Card` 接口的最后一行之前）加：

```ts
  /** A1a 调研之后判为噪音的标注。见 `CardAgentVerdict`——它不会把卡收走。 */
  agentVerdict?: CardAgentVerdict;
```

- [ ] **Step 5: 在 `src/lib/data/store.ts` 里加集合与三个写入原语**

`store` 对象里，紧跟 `probeEdges` 那一行之后加：

```ts
  /*
   * agent 运行记录。每次 A1a/A3/A4 跑完落一条，供评分与复现。
   *
   * 有上限：`persistSoon()` 是把整个 store 序列化重写一遍，Run 记录里带
   * trace 和整段输出，不封顶的话每存一次盘都会重写一份越来越大的 JSON。
   */
  agentRuns: [] as AgentRunRecord[],
```

`persistSoon()` 的定义之后加：

```ts
/** 留多少条 Run 记录。见 `store.agentRuns` 上的注释。 */
export const MAX_AGENT_RUNS = 200;

/*
 * Run 记录的写入口**不进 `api` 对象**。
 *
 * `api` 上的每个方法都在 `POST /api/data` 的白名单里，浏览器能直接打。
 * 读记录没问题，写记录不该对浏览器开放 —— 那等于允许前端往评分队列里塞任意
 * 内容。和上半的 `contextSnapshotPut` 同一处理。
 */
export function agentRunPut(rec: AgentRunRecord): void {
  store.agentRuns.push(clone(rec));
  while (store.agentRuns.length > MAX_AGENT_RUNS) store.agentRuns.shift();
  persistSoon();
}

/** 给信号卡挂上「调研后判为噪音」的标注。卡不因此消失。找不到卡返回 false。 */
export function markCardAgentVerdict(cardId: string, verdict: CardAgentVerdict): boolean {
  const card = store.cards.find((x) => x.id === cardId);
  if (!card) return false;
  card.agentVerdict = { ...verdict };
  persistSoon();
  return true;
}

/**
 * A1a 的输入。返回活对象的**副本** —— agent 那一侧只读，不该拿到能改 store
 * 的引用（那种改动绕过 `persistSoon()`，重启之后凭空消失）。
 */
export function agentSignalInput(cardId: string): { card: Card; issue: Issue } | null {
  const card = store.cards.find((x) => x.id === cardId);
  if (!card) return null;
  const issue = store.issues.find((i) => i.id === card.issueId);
  if (!issue) return null;
  return { card: clone(card), issue: clone(issue) };
}
```

`import type` 那一段补上 `AgentRunRecord` 与 `CardAgentVerdict`（`SignalLogEntry` 附近，保持字母序）。

- [ ] **Step 6: 在 `api` 对象里加两个读方法**

放在 `listSignalLog` 之后：

```ts
  /** agent 运行记录。最新在上。 */
  async listAgentRuns(agent?: string): Promise<AgentRunRecord[]> {
    await sleep(120, 260);
    return store.agentRuns
      .filter((r) => !agent || r.agent === agent)
      .map((r) => clone(r))
      .reverse();
  },

  async getAgentRun(id: string): Promise<AgentRunRecord | null> {
    await sleep(80, 160);
    const hit = store.agentRuns.find((r) => r.id === id);
    return hit ? clone(hit) : null;
  },
```

- [ ] **Step 7: 跑测试确认全过**

Run: `npx vitest run src/lib/data/agent-runs.test.ts`
Expected: PASS，4 个用例

排查提示：`listPending()` 依赖种子里的 digest，如果第一个用例拿不到卡，先确认 `store.digests` 非空（`api.today` 有值即为正常）。

- [ ] **Step 8: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/data/types.ts src/lib/data/store.ts src/lib/data/agent-runs.test.ts
```

- [ ] **Step 9: 提交**

```bash
git add src/lib/data/types.ts src/lib/data/store.ts src/lib/data/agent-runs.test.ts
git commit -m "feat(data): agentRuns 集合、信号标注字段与三个写入原语"
```

---

### Task 4: harness 基类

**Files:**
- Create: `src/lib/agent/harness.ts`
- Modify: `src/lib/graphknowledge/index.ts`（再导出一个 `PREFIX`）
- Test: `src/lib/agent/harness.test.ts`

**Interfaces:**
- Consumes:
  - Task 1：`assemble` / `AssembledPrompt`
  - Task 2：`Check` / `summarize` / `anchorChecks`
  - Task 3：`AgentRunRecord` / `AgentTraceNode` / `AgentUsage`
  - 上半：`openContext` / `OpenedContext` / `ContextBundle` / `Recipe` / `PREFIX` / `TraceNode`；`callModelJson` / `CallResult` / `Effort` / `Usage` / `emptyUsage` / `addUsage`；`parseJson`
- Produces:
  - `const DEPTH: Record<Effort, { searchK: number; maxProps: number; maxRounds: number }>`
  - `const DEFAULT_DEPTH: Effort`
  - `function normalizeDepth(value: string | undefined): Effort`
  - `const NO_COMPANY_CONTEXT: string`
  - `type HarnessInit = { agent: "A1a" | "A3" | "A4"; slot?: Slot; temperature?: number; depth?: string; viewer?: string; asOf?: string; maxTokens?: number; cognitive?: Record<string, string> }`
  - `class Harness`，方法：`note` / `openContext` / `callPrompt` / `callMessages` / `finish`，取值器 `externalOnly` / `contextBlock` / `memberIds` / `bundle` / `budget` / `usage`
  - `function newRunId(agent: string): string`

- [ ] **Step 1: 让上半的门再导出 `PREFIX`**

`src/lib/graphknowledge/index.ts`，把 lookup 的再导出那一行改成：

```ts
export { findAnchors, PREFIX, type AnchorPick, type AnchorPrefix, type Channel } from "./lookup";
```

理由：harness 要按 `agent` 推出前缀。在 harness 里另写一份两条的映射表，就等于把
`CARD-` / `ISS-` 这个约定放在两个地方 —— 将来加频道时一定有一处漏掉。

- [ ] **Step 2: 写失败测试**

`src/lib/agent/harness.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_DEPTH, DEPTH, Harness, NO_COMPANY_CONTEXT, newRunId, normalizeDepth } from "./harness";

describe("思考深度", () => {
  it("五档取值原样是官方 effort 词表", () => {
    expect(Object.keys(DEPTH)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_DEPTH).toBe("high");
  });

  it("档位越高，研究规模越大（同一个旋钮）", () => {
    expect(DEPTH.low.searchK).toBe(3);
    expect(DEPTH.high).toEqual({ searchK: 5, maxProps: 4, maxRounds: 2 });
    expect(DEPTH.max).toEqual({ searchK: 8, maxProps: 6, maxRounds: 3 });
  });

  it("旧的中文档位折成新档位，不静默降级", () => {
    // 交给 DEPTH[v] ?? 兜底的话，旧的「最重」会悄悄变成 high。
    expect(normalizeDepth("最重")).toBe("max");
    expect(normalizeDepth("轻")).toBe("low");
    expect(normalizeDepth("标准")).toBe("high");
    expect(normalizeDepth("xhigh")).toBe("xhigh");
    expect(normalizeDepth("")).toBe(DEFAULT_DEPTH);
    expect(normalizeDepth(undefined)).toBe(DEFAULT_DEPTH);
    expect(normalizeDepth("特别用力")).toBe(DEFAULT_DEPTH);
  });
});

describe("上下文段", () => {
  it("没开过上下文时，contextBlock 也不是空串", () => {
    // 空串会让模型把「这里应该有东西」当成缺口去填 —— 它会编一套公司战略假设
    // 出来，然后正常引用。那种产出格式全对、引用看着也有，只是全是假的。
    const h = new Harness({ agent: "A1a" });
    expect(h.contextBlock).toBe(NO_COMPANY_CONTEXT);
    expect(h.contextBlock.length).toBeGreaterThan(100);
    expect(h.externalOnly).toBe(true);
  });

  it("NO_COMPANY_CONTEXT 把「引用必须为空」写成硬约束", () => {
    expect(NO_COMPANY_CONTEXT).toContain("cited_member_ids");
    expect(NO_COMPANY_CONTEXT).toContain("[]");
  });
});

describe("finish", () => {
  it("没跑过任何一步也能落一条 failed 记录，复现坐标为空但字段齐全", () => {
    const h = new Harness({ agent: "A3", slot: "pro", depth: "低" });
    const rec = h.finish({ status: "failed", error: "GraphKnowledge 不可达" });
    expect(rec.agent).toBe("A3");
    expect(rec.status).toBe("failed");
    expect(rec.contextMode).toBe("");
    expect(rec.depth).toBe(DEFAULT_DEPTH);
    expect(rec.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(rec.checkSummary.total).toBe(0);
    expect(rec.id.startsWith("RUN-A3-")).toBe(true);
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("note 落进 trace，顺序保留", () => {
    const h = new Harness({ agent: "A1a" });
    h.note("甲", { x: 1 });
    h.note("乙");
    const rec = h.finish({ status: "ignored", output: {} });
    expect(rec.trace.map((n) => n.label)).toEqual(["甲", "乙"]);
    expect(rec.trace[0].detail).toEqual({ x: 1 });
    expect(rec.status).toBe("ignored");
  });
});

describe("newRunId", () => {
  it("带上 agent 名，两次不撞", () => {
    const a = newRunId("A1a");
    const b = newRunId("A1a");
    expect(a).toContain("A1a");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/harness.test.ts`
Expected: FAIL，`Failed to resolve import "./harness"`

- [ ] **Step 4: 写 `src/lib/agent/harness.ts`**

```ts
/**
 * Harness 基类。对齐自 `tkos-lab/src/tkos_lab/agents/base.py`。
 *
 * 每一步都进 trace，每一次模型调用都累计 token —— 这两件事在这里做掉，
 * 三条链路不需要也不应该自己记。
 *
 * ## 为什么是「被组合」而不是「被继承」
 *
 * 实验台的基类是模板方法：`STEPS` + `advance()` + 从 state 还原现场，为的是把
 * 一次运行拆成若干次独立函数调用（Vercel 的函数一返回就被回收）。正式版有
 * `tasks.ts` 在后台整体跑，不需要单步重放（见 spec §8①）。砍掉步进机制之后
 * 模板方法就只剩「谁先谁后」这一点约束，而三条链路的步序本来就不一样。
 * 所以这里是一个具体类，各链路 `new Harness({agent})` 自己按顺序调。
 */
import {
  openContext as openGraphContext,
  PREFIX,
  type ContextBundle,
  type OpenedContext,
  type Recipe,
} from "@/lib/graphknowledge";
import { callModelJson, parseJson, type CallOpts, type Msg } from "@/lib/agent/json";
import { addUsage, emptyUsage, type CallResult, type Effort, type Usage } from "@/lib/models/complete";
import type { Slot } from "@/lib/models/slots";
import { anchorChecks, summarize, type Check } from "@/lib/agent/checks";
import { assemble } from "@/lib/agent/prompts";
import type { AgentRunRecord, AgentTraceNode } from "@/lib/data/types";

/*
 * 图谱里没有对应锚点时，塞进 Prompt 第 ② 段（上下文注入）的东西。
 *
 * 这一段不能留空。留空的话模型面对的是一个「上下文位置有个空洞」的 Prompt，
 * 它会去填这个洞——凭常识编出几条听着像公司战略假设的东西，然后正常引用。
 * 那种产出最难发现：格式全对，引用看着也有，只是全是假的。所以这里明确写出
 * 「没有」，并且把「不许编」和「引用必须为空」写成硬约束。
 */
export const NO_COMPANY_CONTEXT = `（本次没有公司上下文）

GraphKnowledge 里没有与这条输入对应的锚点，因此这次运行**拿不到任何公司内部
信息**：没有战略假设、没有判断链、没有共识记录，也没有任何可引用的 member。

这不代表这条输入与战略无关，而是说明它对公司现有的战略方向来说还太新——
图谱里还没有它的位置。所以你要做的是**纯外部推理**：

- 只依据上面那条输入本身，以及公开可查的通行事实来推理。
- 不要假设公司内部存在任何相关材料，不要写「公司现有战略假设是……」这类句子。
  没有材料就说没有材料，宁可结论更弱，也不许把推测写成公司现状。
- cited_member_ids 必须是空数组 \`[]\`。这次没有任何 member 可引，写进去的一定是
  编的。
`;

/*
 * 思考深度。档位名直接用官方的 effort 词表（low / medium / high / xhigh / max），
 * 不另起中文名 —— 多一层翻译只会让「界面上选的」和「实际发出去的」对不上。
 *
 * 同一个档位也决定 harness 自己的研究规模：一次运行只有一个「用多大力」的旋钮，
 * 模型想得更久时材料也该更厚。M7 P3 的 k/budget **不在这里**，由配方固定。
 *
 * 火山三个模型 `acceptsEffort` 都是 false，所以在正式版这个值只驱动下面这张表，
 * 从不发给模型（发过去是 400，不是被忽略）。
 */
export const DEPTH: Record<Effort, { searchK: number; maxProps: number; maxRounds: number }> = {
  low: { searchK: 3, maxProps: 3, maxRounds: 1 },
  medium: { searchK: 4, maxProps: 3, maxRounds: 1 },
  high: { searchK: 5, maxProps: 4, maxRounds: 2 },
  xhigh: { searchK: 6, maxProps: 5, maxRounds: 2 },
  max: { searchK: 8, maxProps: 6, maxRounds: 3 },
};

export const DEFAULT_DEPTH: Effort = "high";

/** 历史上存过中文档位。折成新档位，**不交给 `DEPTH[v] ?? 兜底`** —— 兜底会把
 *  旧的「最重」悄悄降成 high，而产出看不出任何异常。 */
const LEGACY_DEPTH: Record<string, Effort> = { 轻: "low", 标准: "high", 最重: "max" };

export function normalizeDepth(value: string | undefined): Effort {
  const v = (value ?? "").trim();
  if (v in DEPTH) return v as Effort;
  return LEGACY_DEPTH[v] ?? DEFAULT_DEPTH;
}

export type HarnessAgent = "A1a" | "A3" | "A4";

export type HarnessInit = {
  agent: HarnessAgent;
  slot?: Slot;
  temperature?: number;
  depth?: string;
  viewer?: string;
  /** 复现旧运行时钉回去。**没有环境变量** —— 给它一个变量意味着有人会设成某个
   *  日期然后忘掉，之后每次运行都在读一份过期视图，而产出看不出任何异常。 */
  asOf?: string;
  maxTokens?: number;
  /** prompt key → 第 ③ 段。本轮为空，见 `prompts/cognitive/README.md`。 */
  cognitive?: Record<string, string>;
};

let seq = 0;

export function newRunId(agent: string): string {
  seq += 1;
  return `RUN-${agent}-${Date.now().toString(36)}-${seq}`;
}

export class Harness {
  readonly agent: HarnessAgent;
  readonly slot: Slot;
  readonly temperature: number;
  readonly depth: Effort;
  readonly cognitive: Record<string, string>;
  private readonly viewer?: string;
  private readonly asOf?: string;
  private readonly maxTokens: number;
  private readonly startedAt = new Date().toISOString();
  private readonly t0 = Date.now();
  private readonly trace: AgentTraceNode[] = [];
  private acc: Usage = emptyUsage();
  private opened: OpenedContext | null = null;
  private lastCall: CallResult | null = null;

  constructor(init: HarnessInit) {
    this.agent = init.agent;
    this.slot = init.slot ?? "pro";
    this.temperature = init.temperature ?? 0.3;
    this.depth = normalizeDepth(init.depth);
    this.cognitive = init.cognitive ?? {};
    this.viewer = init.viewer;
    this.asOf = init.asOf;
    this.maxTokens = init.maxTokens ?? 8192;
  }

  get budget(): { searchK: number; maxProps: number; maxRounds: number } {
    return DEPTH[this.depth];
  }

  get usage(): Usage {
    return this.acc;
  }

  get bundle(): ContextBundle | null {
    return this.opened?.bundle ?? null;
  }

  /** 这次是不是纯外部。**没开过上下文也算** —— 那时候手上确实没有公司材料。 */
  get externalOnly(): boolean {
    return this.opened?.mode !== "anchored";
  }

  get memberIds(): Set<string> {
    return new Set(this.bundle?.memberIds ?? []);
  }

  /**
   * 该往 Prompt 第 ② 段填的东西。装 prompt 一律用这个，不要直接用
   * `bundle.renderedMarkdown` —— 纯外部时那是 undefined，落进 prompt 是空洞。
   */
  get contextBlock(): string {
    return this.externalOnly ? NO_COMPANY_CONTEXT : (this.bundle?.renderedMarkdown ?? NO_COMPANY_CONTEXT);
  }

  note(label: string, detail: Record<string, unknown> = {}, kind = "local"): void {
    this.trace.push({ at: new Date().toISOString(), label, kind, detail });
  }

  /**
   * 选锚点 + 装上下文。返回**这次有没有公司上下文**。
   *
   * 三条链路的第一步都是这一句。三态在上半的 `openContext()` 里就分开了：
   * 命中 → 装配并冻结；`AnchorNotFound` → 那扇门自己吃掉，这里拿到
   * `mode:"external_only"`；`GraphKnowledgeUnavailable` → 原样抛出，就地失败。
   *
   * 所以这里**不写 try/catch**：能接住的异常只有「连不上」，而接住它就等于让
   * 图服务一停机所有运行都自动降级成纯外部，还照样产出一份格式完整的报告。
   */
  async openContext(recipe: Recipe, q: string, anchorCode?: string): Promise<boolean> {
    const opened = await openGraphContext({
      recipe,
      prefix: PREFIX[this.agent],
      channel: this.agent,
      q,
      anchorCode,
      viewer: this.viewer,
      asOf: this.asOf,
    });
    this.opened = opened;
    for (const n of opened.trace) this.trace.push({ ...n });
    if (opened.mode === "external_only") {
      this.note("转纯外部", {
        why: opened.noAnchorReason,
        note: "这不是故障。没有公司上下文，本次全程只用输入原文与外部材料；引用必须为空",
      });
    }
    return opened.mode === "anchored";
  }

  /**
   * 调一次模型，prompt 由 `prompts/engineering/<key>.md` 五段装配。
   *
   * 返回的是**对象**：下游（自检、路由、写卡）全都按对象取字段，光检查「能不能
   * parse」放它过去，就会在几帧之外炸成 `undefined is not an object` —— 堆栈指向
   * 自检代码，真正的原因（模型输出的形状不对）反而看不见。所以在边界上判形状。
   */
  async callPrompt(
    key: string,
    parts: { input?: string; context?: string; evidence?: string; challenges?: string },
    opts: { slot?: Slot; maxTokens?: number; temperature?: number } = {}
  ): Promise<Record<string, unknown>> {
    const p = await assemble(key, { ...parts, cognitive: this.cognitive[key] });
    const r = await this.callMessages(
      `模型调用 · ${key}`,
      [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
      opts,
      { promptKey: key, cognitiveSource: p.cognitiveSource, promptChars: p.chars },
      key
    );
    const node = this.trace[this.trace.length - 1];
    let parsed: unknown;
    try {
      parsed = parseJson<unknown>(r.text);
    } catch (e) {
      node.error = `输出不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`;
      throw e;
    }
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
      // 单元素数组是同一个对象套了层壳，拆开就是要的东西。拆了要留痕：不然
      // 「这个模型需要更强的格式约束」这件事在结果页上无从得知。
      node.detail.shapeFixed = "模型把对象包在单元素数组里返回，已拆开";
      return parsed[0] as Record<string, unknown>;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const got = Array.isArray(parsed) ? `数组（${parsed.length} 个元素）` : typeof parsed;
      node.error = `输出不是 JSON 对象，是 ${got}`;
      throw new Error(node.error);
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * 调一次模型，messages 由调用方自己拼。A3/A4 走这条 —— 它们的 prompt 是 TS
   * builder，本轮不搬成 md（spec §3 决策 4：输出形状与 validate 循环不动）。
   */
  async callMessages(
    label: string,
    messages: Msg[],
    opts: { slot?: Slot; maxTokens?: number; temperature?: number } = {},
    extraDetail: Record<string, unknown> = {},
    hint?: string
  ): Promise<CallResult> {
    const at = new Date().toISOString();
    const t = Date.now();
    const callOpts: CallOpts = {
      slot: opts.slot ?? this.slot,
      maxTokens: opts.maxTokens ?? this.maxTokens,
      temperature: opts.temperature ?? this.temperature,
      // 只有认这个字段的模型会收到它（`complete.ts` 判 `acceptsEffort`）。
      effort: this.depth,
      hint,
    };
    let r: CallResult;
    try {
      r = await callModelJson(messages, callOpts);
    } catch (e) {
      this.trace.push({
        at,
        label,
        kind: "model",
        ms: Date.now() - t,
        detail: { ...extraDetail, slot: callOpts.slot },
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    this.acc = addUsage(this.acc, r.usage);
    this.lastCall = r;
    this.trace.push({
      at,
      label,
      kind: "model",
      ms: r.ms,
      detail: {
        ...extraDetail,
        slot: r.slot,
        alias: r.alias,
        providerModelId: r.providerModelId,
        // 实际发出去的推理档。**空 = 这个模型不吃这个字段，不是「没选」。**
        effortSent: r.effortSent,
        stopReason: r.stopReason,
      },
      usage: r.usage,
    });
    return r;
  }

  /** 收尾：拼出可复现的 Run 记录。锚点自检在这里自动补上（和实验台一致）。 */
  finish(res: {
    status: AgentRunRecord["status"];
    input?: string;
    output?: Record<string, unknown> | null;
    route?: AgentRunRecord["route"];
    checks?: Check[];
    violations?: string[];
    degraded?: boolean;
    error?: string;
  }): AgentRunRecord {
    const checks = [...(res.checks ?? []), ...(this.opened ? anchorChecks(this.opened) : [])];
    const b = this.bundle;
    return {
      id: newRunId(this.agent),
      agent: this.agent,
      status: res.status,
      input: res.input ?? "",
      output: res.output ?? null,
      ...(res.route ? { route: res.route } : {}),
      contextMode: this.opened ? this.opened.mode : "",
      ...(this.opened?.noAnchorReason ? { noAnchorReason: this.opened.noAnchorReason } : {}),
      trace: this.trace.map((n) => ({ ...n })),
      checks,
      checkSummary: summarize(checks),
      usage: this.acc,
      ...(res.violations?.length ? { violations: res.violations } : {}),
      ...(res.degraded ? { degraded: true } : {}),
      slot: this.slot,
      modelAlias: this.lastCall?.alias ?? "",
      providerModelId: this.lastCall?.providerModelId ?? "",
      depth: this.depth,
      snapshotId: this.opened?.snapshotId ?? "",
      contextRecipe: b?.recipe ?? "",
      contextAnchor: b?.anchorCode ?? "",
      contextViewer: b?.viewer ?? "",
      contextAsOf: b?.asOf ?? "",
      graphknowledgeBaseUrl: b?.sourceBaseUrl ?? "",
      warnings: this.opened?.warnings ?? [],
      ...(res.error ? { error: res.error } : {}),
      createdAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - this.t0,
    };
  }
}
```

- [ ] **Step 5: 给 `CallOpts` 加 `hint`**

`src/lib/agent/json.ts` 的 `CallOpts` 里加一行（`json?: boolean` 之后）：

```ts
  /** 这次调用是给哪个 prompt 用的。只进日志与假模型分派，不发给模型。 */
  hint?: string;
```

并在 `callModelJson` 里把它透传给 `callModel`：`hint: opts.hint,`。

- [ ] **Step 6: 跑测试确认全过**

Run: `npx vitest run src/lib/agent/harness.test.ts`
Expected: PASS，7 个用例。全部不联网、不调模型。

- [ ] **Step 7: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/harness.ts src/lib/agent/harness.test.ts src/lib/agent/json.ts src/lib/graphknowledge/index.ts
```

- [ ] **Step 8: 提交**

```bash
git add src/lib/agent/harness.ts src/lib/agent/harness.test.ts src/lib/agent/json.ts src/lib/graphknowledge/index.ts
git commit -m "feat(harness): harness 基类、思考深度表与纯外部上下文段"
```

---

### Task 5: 假模型（`TKOS_MODEL_MOCK=1`）

**Files:**
- Create: `src/lib/models/mock.ts`
- Modify: `src/lib/models/complete.ts`（加 `hint` 入参与 mock 分支）
- Test: `src/lib/models/mock.test.ts`

**Interfaces:**
- Consumes: 上半的 `CallResult` / `Usage`
- Produces:
  - `function modelMockOn(): boolean`
  - `function mockText(hint: string | undefined): string`
  - `callModel(opts)` 新增可选入参 `hint?: string`

对应实验台的 `verify_graphknowledge.py`：三条链路整跑一遍，证明五段装配、快照冻结、Run 落库、写回都对，**一个 token 不烧**。

- [ ] **Step 1: 写失败测试**

`src/lib/models/mock.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { mockText } from "./mock";

const parse = (hint: string) => JSON.parse(mockText(hint)) as Record<string, unknown>;

describe("假模型", () => {
  it("四个 A1a prompt 各有自己的罐头，路由值合法", () => {
    expect(parse("a1a.triage").decision).toBe("new_issue");
    expect(parse("a1a.issue.new").decision).toBe("new_issue");
    expect(parse("a1a.issue.update").decision).toBe("update_issue");
    expect(parse("a1a.issue.external").decision).toBe("new_issue");
  });

  it("A3 的罐头带齐 PreResearchDoc 的五个字段", () => {
    const o = parse("a3.pre-research");
    expect(Object.keys(o).sort()).toEqual(
      ["finding", "openQuestion", "question", "soWhat", "take"].sort()
    );
    expect(String(o.question).endsWith("？")).toBe(true);
    expect((o.finding as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("A4 的罐头带齐五节，反证那条单独一个 key", () => {
    const o = parse("a4.research");
    expect(Object.keys(o).sort()).toEqual(
      ["counters", "judgment", "keyEvidence", "routeSuggestion", "unknowns"].sort()
    );
    expect(Object.keys(parse("a4.challenge"))).toEqual(["counters"]);
  });

  it("认不出 hint 时给一个能 parse 的兜底，并说明它是兜底", () => {
    // 抛异常的话，一条没登记的链路在 mock 下表现为「模型挂了」，
    // 而真正的问题是罐头没写 —— 两件事要分得开。
    const o = parse("a9.something");
    expect(o.note).toContain("没有为 a9.something 准备罐头");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/models/mock.test.ts`
Expected: FAIL，`Failed to resolve import "./mock"`

- [ ] **Step 3: 写 `src/lib/models/mock.ts`**

```ts
/**
 * 假模型。对齐自 `tkos-lab/scripts/verify_graphknowledge.py` 的用法。
 *
 * `TKOS_MODEL_MOCK=1` 时 `callModel()` 不出网，直接返回这里的罐头。为的是把
 * 「五段装配 → 快照冻结 → 自检 → Run 落库 → 写回」这一整条路跑通而**不烧
 * token**：这条路上的 bug（字段名写错、写回写到别的卡上）跟模型质量无关，
 * 却只有整跑一遍才暴露。
 *
 * 罐头内容按真 prompt 的输出格式写，尽量让质量门过 —— 过不了就调这里的文案，
 * **不要动 `validate` 规则**。
 */
const CANNED: Record<string, unknown> = {
  "a1a.triage": {
    decision: "new_issue",
    signal_reading: "大厂把 To B 的入口从模型能力挪到了行业交付。",
    target_issue_code: "",
    rationale: "现有议题里最接近的那条讲的是模型能力对比，说的不是入口在谁手上这件事。",
  },
  "a1a.issue.new": {
    decision: "new_issue",
    issue_statement: "如果入口移到行业交付，我们靠模型能力建立的差异还剩多少？",
    what_happened: "大厂把 To B 的销售与交付合并成行业线。",
    why_now: "招标季在三个月内开始，入口一旦被占，明年再谈就是替换成本。",
    shakes_assumption: "我们赌的是模型能力足以带动交付。",
    suggested_handling: "先查两个已投标客户的决策链此刻在谁手里。",
    cited_member_ids: [],
  },
  /*
   * 取代那条路的罐头用的是一个假编号，所以「被取代的议题在上下文里存在」和
   * 「引用 ID 真实」这两条自检在 mock 下**会红**。这是预期结果，不是缺陷：
   * mock 验的是这条路走不走得通，不是模型选得对不对。
   */
  "a1a.issue.update": {
    decision: "update_issue",
    target_issue_code: "ISS-MOCK-01",
    replaces: { code: "ISS-MOCK-01", statement_before: "（mock）旧议题的说法。" },
    issue_statement: "（mock）新议题把范围从三个行业收窄到一个。",
    what_changed: "范围从三个行业收窄到一个",
    why_replace_not_new: "说的仍是同一件事，只是边界变了。",
    shakes_assumption: "（mock）动摇的是覆盖面那条假设。",
    suggested_handling: "（mock）先确认那一个行业的决策链。",
    cited_member_ids: [],
  },
  "a1a.issue.external": {
    decision: "new_issue",
    issue_statement: "入口从能力侧移到交付侧之后，谁必须重新考虑自己在做什么？",
    why_it_qualifies:
      "它指向的是采购决策权的转移，一旦成立，靠单点能力定位的公司都要重新算自己的位置，" +
      "而这件事不是一次性事件，也不是执行层面的操作问题。",
    cited_member_ids: [],
  },
  "a3.pre-research": {
    question: "入口移到交付侧之后，我们的模型能力还能不能带动成单？",
    take:
      "采购决策权正在从技术评估侧移到行业交付侧。这让「能力更强所以会被选中」这条链断了一环。" +
      "在两个已投标客户身上，决策人已经换成了业务线负责人。",
    finding: [
      {
        text: "两个已投标客户的决策人在近一个季度换成了业务线负责人。",
        traces: [{ kind: "int", source: "投标记录" }],
      },
      {
        text: "同期公开招标文件里，技术评分权重从四成降到两成五。",
        traces: [{ kind: "ext", source: "公开招标文件" }],
      },
    ],
    openQuestion: [
      {
        text: "这个权重变化是这一个行业的事，还是三个行业都在发生？",
        traces: [{ kind: "agent", source: "本轮预研" }],
      },
    ],
    soWhat: "值得继续想：它压在我们最主要的那条获客假设上。",
  },
  "a4.research": {
    judgment: [
      {
        text: "采购决策权已经移到业务线，技术评分不再是主要门槛。",
        traces: [{ kind: "int", source: "投标记录" }],
      },
    ],
    keyEvidence: [
      {
        text: "两个已投标客户的决策人换成业务线负责人，技术评分权重同期下降。",
        traces: [{ kind: "ext", source: "公开招标文件" }],
      },
    ],
    counters: [
      {
        text: "样本只有两个客户，可能是这一个行业的局部现象。",
        traces: [{ kind: "agent", source: "本轮深研" }],
      },
    ],
    unknowns: [
      { text: "另外两个行业的权重有没有同样在降。", traces: [{ kind: "agent", source: "本轮深研" }] },
    ],
    routeSuggestion: "值得升级成一次正式讨论：它动的是获客路径本身。",
  },
  "a4.challenge": {
    counters: [
      {
        text: "权重下降也可能是这一年招标模板的统一改版，与决策权归属无关。",
        traces: [{ kind: "ext", source: "招标模板改版说明" }],
      },
    ],
  },
};

export const modelMockOn = (): boolean => process.env.TKOS_MODEL_MOCK === "1";

export function mockText(hint: string | undefined): string {
  const hit = hint ? CANNED[hint] : undefined;
  if (hit) return JSON.stringify(hit);
  /*
   * 认不出就给一个能 parse 的兜底，**不抛**。抛的话，一条还没登记罐头的链路
   * 在 mock 下表现成「模型挂了」，而真正的问题是罐头没写 —— 两件事要分得开。
   */
  return JSON.stringify({
    note: `（假模型）没有为 ${hint ?? "（未给 hint）"} 准备罐头，返回的是兜底对象。`,
  });
}
```

- [ ] **Step 4: 在 `src/lib/models/complete.ts` 里接上 mock**

`callModel` 的入参对象里加一行：

```ts
  /** 这次调用是给哪个 prompt 用的。只进日志与假模型分派。 */
  hint?: string;
```

函数体开头（`const cfg = configFor(opts);` **之前**）加：

```ts
  /*
   * 假模型先判，在解析槽位之前 —— mock 的用途之一就是在一把 key 都没配的机器上
   * 把三条链路走通。放到 configFor 之后会先抛「没有可用的槽位」。
   */
  if (modelMockOn()) {
    return {
      text: mockText(opts.hint),
      usage: emptyUsage(),
      ms: 0,
      slot: opts.slot ?? null,
      alias: "mock",
      providerModelId: "mock",
      effortSent: null,
      stopReason: "stop",
    };
  }
```

并在文件头部 import：

```ts
import { mockText, modelMockOn } from "./mock";
```

- [ ] **Step 5: 跑测试确认全过**

Run: `npx vitest run src/lib/models/mock.test.ts`
Expected: PASS，5 个用例

- [ ] **Step 6: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/models/mock.ts src/lib/models/mock.test.ts src/lib/models/complete.ts
```

- [ ] **Step 7: 提交**

```bash
git add src/lib/models/mock.ts src/lib/models/mock.test.ts src/lib/models/complete.ts
git commit -m "feat(models): TKOS_MODEL_MOCK 假模型，三条链路可零成本整跑"
```

---

### Task 6: A1a —— 信号 → 议题，三条路

**Files:**
- Create: `src/lib/agent/a1a/run.ts`
- Test: `src/lib/agent/a1a/run.test.ts`

**Interfaces:**
- Consumes: Task 2 的自检、Task 4 的 `Harness`、Task 3 的 `AgentRunRecord`
- Produces:
  - `const DECISIONS: readonly ["update_issue", "new_issue", "ignore"]`
  - `type Decision = (typeof DECISIONS)[number]`
  - `function normalizeDecision(out: Record<string, unknown>): { decision: Decision | null; raw: string }`
  - `type A1aInput = { cardId: string; headline: string; source: string; body?: string }`
  - `async function runA1a(input: A1aInput, init?: { depth?: string; cognitive?: Record<string, string> }): Promise<AgentRunRecord>`

- [ ] **Step 1: 写失败测试**

`src/lib/agent/a1a/run.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { DECISIONS, normalizeDecision } from "./run";

describe("路由归一化", () => {
  it("三个正式取值原样通过", () => {
    for (const d of DECISIONS) {
      expect(normalizeDecision({ decision: d })).toEqual({ decision: d, raw: d });
    }
  });

  it("认得出的近义词归一化，并把原值带出来供自检标注", () => {
    expect(normalizeDecision({ decision: "修改已存的issue" }).decision).toBe("update_issue");
    expect(normalizeDecision({ decision: "Update-Existing" }).decision).toBe("update_issue");
    expect(normalizeDecision({ decision: "创建新议题" }).decision).toBe("new_issue");
    expect(normalizeDecision({ decision: "potential_issue" }).decision).toBe("new_issue");
    expect(normalizeDecision({ decision: " NOISE " }).decision).toBe("ignore");
    expect(normalizeDecision({ decision: "噪音" }).raw).toBe("噪音");
  });

  it("认不出就是 null —— 不猜", () => {
    // 随便挑一条会产出一份格式完整、却走错了路的议题，而且毫无迹象。
    expect(normalizeDecision({ decision: "也许吧" }).decision).toBeNull();
    expect(normalizeDecision({}).decision).toBeNull();
    expect(normalizeDecision({}).raw).toBe("");
    expect(normalizeDecision({ decision: 3 }).decision).toBeNull();
    expect(normalizeDecision({ decision: 3 }).raw).toBe("3");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/a1a/run.test.ts`
Expected: FAIL，`Failed to resolve import "./run"`

- [ ] **Step 3: 写 `src/lib/agent/a1a/run.ts`**

```ts
/**
 * A1a 信号 → 议题，用 GraphKnowledge M7 S01 上下文。
 * 对齐自 `tkos-lab/src/tkos_lab/agents/a1a_signal.py`。
 *
 * 一条信号进来有**三条**出路，第一步先定往哪条走：
 *
 * | 路由 | 含义 | 产出 |
 * |---|---|---|
 * | `update_issue` | 已有一条议题在说同一件事，但说法被这条信号改变了 | 一条**取代**它的新议题 |
 * | `new_issue`    | 公司还没有承接它的议题 | 一条新的潜在议题 |
 * | `ignore`       | 看着量很大、甚至是 CEO 给的，但分析完是噪音 | 不改也不新增，只留判断 |
 *
 * 选路和写正文分成两次模型调用，是为了让「路由选错」和「正文写得不好」在评分
 * 时分得开。合成一次的话，模型走错了路只会看到一份怪产出，看不出该改哪一段。
 *
 * `ignore` 这条路在选路那一步就结束，不再调第二次模型：这次运行的产出**就是**
 * 那个判断。空产出在这里是正确结果（`status:"ignored"`），不是没跑完。
 *
 * 图谱里找不到 `CARD-*` 锚点时**不停**，转纯外部：那条路上看不到任何既有议题，
 * 「取代」根本不成立，所以只剩两条分支，由 `a1a.issue.external` 一次判完，
 * 并且**不做外部检索** —— 考的就是从这段原文本身能推出什么。
 */
import {
  a1aExternal,
  a1aIgnore,
  a1aIsIgnore,
  a1aNew,
  a1aTriage,
  a1aUpdate,
  type Check,
} from "@/lib/agent/checks";
import { Harness } from "@/lib/agent/harness";
import type { AgentRunRecord } from "@/lib/data/types";

export const DECISIONS = ["update_issue", "new_issue", "ignore"] as const;
export type Decision = (typeof DECISIONS)[number];

/*
 * 模型偶尔会把路由值写成中文或近义词。能确定对应关系的就归一化，但**不猜**：
 * 归一化过的会在自检里标出来（下游按这三个值分支，正文里就该定死），对不上的
 * 直接失败 —— 随便挑一条会产出一份格式完整、却走错了路的议题，而且毫无迹象。
 */
const ALIASES: Record<string, Decision> = {
  update: "update_issue",
  modify: "update_issue",
  replace: "update_issue",
  update_existing: "update_issue",
  修改: "update_issue",
  取代: "update_issue",
  更新: "update_issue",
  修改已存的issue: "update_issue",
  new: "new_issue",
  create: "new_issue",
  create_issue: "new_issue",
  potential_issue: "new_issue",
  新增: "new_issue",
  新建: "new_issue",
  创建: "new_issue",
  创建新议题: "new_issue",
  noise: "ignore",
  skip: "ignore",
  noop: "ignore",
  none: "ignore",
  no_action: "ignore",
  忽略: "ignore",
  噪音: "ignore",
};

export function normalizeDecision(out: Record<string, unknown>): {
  decision: Decision | null;
  raw: string;
} {
  const v = out.decision;
  const raw = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
  if ((DECISIONS as readonly string[]).includes(raw)) return { decision: raw as Decision, raw };
  const key = raw.toLowerCase().replace(/ /g, "").replace(/-/g, "_");
  return { decision: ALIASES[key] ?? null, raw };
}

export type A1aInput = {
  cardId: string;
  /** 锚点检索用的那一句。**不含任何指令样板。** */
  headline: string;
  source: string;
  /** 信号正文（`Card.what` 拼出来的）。没有就只用 headline。 */
  body?: string;
};

const signalBlock = (input: A1aInput): string =>
  `信号原文：\n${input.body?.trim() || input.headline}\n\n来源：${input.source || "（未提供）"}`;

function routedBlock(input: A1aInput, tri: Record<string, unknown>): string {
  const s = (k: string) => {
    const v = tri[k];
    return typeof v === "string" && v.trim() ? v.trim() : "（未给出）";
  };
  const bits = [
    signalBlock(input),
    "",
    "【上一步的定性结论】",
    `路由：${s("decision")}`,
    `这条信号在说的事：${s("signal_reading")}`,
    `理由：${s("rationale")}`,
  ];
  const code = typeof tri.target_issue_code === "string" ? tri.target_issue_code.trim() : "";
  if (code) bits.push(`要被取代的既有议题：${code}`);
  return bits.join("\n");
}

/**
 * 跑一次 A1a。返回一条 Run 记录 —— 写回由 `apply.ts` 决定，这里只判断和产出。
 *
 * `GraphKnowledgeUnavailable` **原样抛出**：图服务挂了要是被当成「图谱里没有
 * 这条信号」，每一次运行都会悄悄降级成纯外部，还照样产出一份格式漂亮的议题。
 */
export async function runA1a(
  input: A1aInput,
  init: { depth?: string; cognitive?: Record<string, string> } = {}
): Promise<AgentRunRecord> {
  const h = new Harness({ agent: "A1a", slot: "pro", depth: init.depth, cognitive: init.cognitive });
  const inp = signalBlock(input);

  await h.openContext("S01", input.headline);

  // ---- 纯外部：三条路只剩两条，一次调用判完 ----
  if (h.externalOnly) {
    h.note("纯外部 · 跳过选路", {
      why: "图谱里没有锚点，看不到任何既有议题，无从取代",
    });
    const out = await h.callPrompt("a1a.issue.external", { input: inp, context: h.contextBlock });
    const ignored = a1aIsIgnore(out);
    out.decision = ignored ? "ignore" : "new_issue";
    return h.finish({
      status: ignored ? "ignored" : "ok",
      input: inp,
      output: out,
      route: ignored ? "ignore" : "new_issue",
      checks: a1aExternal(out),
    });
  }

  // ---- 第一次调用：选路 ----
  const tri = await h.callPrompt("a1a.triage", { input: inp, context: h.contextBlock });
  const { decision, raw } = normalizeDecision(tri);
  if (decision === null) {
    // 路由是后面每一步的开关，看不懂它选了什么就不能往下走。
    return h.finish({
      status: "failed",
      input: inp,
      output: tri,
      error: `路由取值不合法：收到 ${raw ? `「${raw}」` : "（空）"}；只能是 ${DECISIONS.join(" / ")}`,
    });
  }
  tri.decision = decision;
  const triChecks: Check[] = a1aTriage(tri, h.memberIds, raw);

  if (decision === "ignore") {
    // 到此为止，不调第二次模型。这一步的输出就是这次运行的产出。
    return h.finish({
      status: "ignored",
      input: inp,
      output: tri,
      route: "ignore",
      checks: [...triChecks, ...a1aIgnore(tri)],
    });
  }

  // ---- 第二次调用：写正文 ----
  const routed = routedBlock(input, tri);
  let out: Record<string, unknown>;
  let checks: Check[];
  if (decision === "update_issue") {
    out = await h.callPrompt("a1a.issue.update", { input: routed, context: h.contextBlock });
    if (out.decision === undefined) out.decision = "update_issue";
    const code = typeof out.target_issue_code === "string" ? out.target_issue_code.trim() : "";
    // 选路那一步已经指名了要取代哪一条；第二次调用漏了就补回去，不要让它变成空。
    if (!code) out.target_issue_code = tri.target_issue_code ?? "";
    checks = a1aUpdate(out, h.memberIds);
  } else {
    out = await h.callPrompt("a1a.issue.new", { input: routed, context: h.contextBlock });
    if (out.decision === undefined) out.decision = "new_issue";
    checks = a1aNew(out, h.memberIds);
  }
  // 选路的结论跟着产出一起交出去：评这份议题写得对不对，前提是先看到它为什么
  // 走了这条路。
  out.triage = tri;
  return h.finish({
    status: "ok",
    input: inp,
    output: out,
    route: decision,
    checks: [...triChecks, ...checks],
  });
}
```

- [ ] **Step 4: 跑测试确认全过**

Run: `npx vitest run src/lib/agent/a1a/run.test.ts`
Expected: PASS，3 个用例

- [ ] **Step 5: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/a1a/run.ts src/lib/agent/a1a/run.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/a1a
git commit -m "feat(a1a): 信号→议题三条路，选路与写正文分两次调用"
```

---

### Task 7: A1a 的写回与触发

**Files:**
- Create: `src/lib/agent/a1a/apply.ts`
- Create: `src/app/api/agent/a1a/route.ts`
- Test: `src/lib/agent/a1a/apply.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `markCardAgentVerdict` / `agentRunPut` / `agentSignalInput`；Task 6 的 `runA1a`；现有的 `runTask` / `taskState`
- Produces:
  - `class NotWiredYet extends Error`
  - `function applyA1aResult(run: AgentRunRecord, cardId: string): { applied: string }`
  - `POST /api/agent/a1a` body `{ cardId: string; depth?: string }` → `TaskState`
  - `GET /api/agent/a1a?cardId=…` → `TaskState`

- [ ] **Step 1: 写失败测试**

`src/lib/agent/a1a/apply.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { api } from "@/lib/data/store";
import type { AgentRunRecord } from "@/lib/data/types";

import { applyA1aResult, NotWiredYet } from "./apply";

const base = (over: Partial<AgentRunRecord>): AgentRunRecord =>
  ({
    id: "RUN-A1a-x",
    agent: "A1a",
    status: "ignored",
    input: "信号原文：X",
    output: {
      decision: "ignore",
      verdict: "此信号应被忽略，不改动也不新增议题",
      reason: "只有一个来源",
      what_would_change_it: "出现第二个独立来源",
    },
    route: "ignore",
    contextMode: "anchored",
    trace: [],
    checks: [],
    checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
    slot: "pro",
    modelAlias: "deepseek-pro",
    providerModelId: "ep-x",
    depth: "high",
    snapshotId: "ctx-x",
    contextRecipe: "S01",
    contextAnchor: "CARD-01",
    contextViewer: "PSN-01",
    contextAsOf: "2026-08-18",
    graphknowledgeBaseUrl: "https://example/graph",
    warnings: [],
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:01.000Z",
    latencyMs: 1,
    ...over,
  }) as AgentRunRecord;

describe("applyA1aResult", () => {
  it("ignore：信号留在列表里并被标注，没有被处置掉", async () => {
    const card = (await api.listPending())[0];
    const r = applyA1aResult(base({ input: card.id }), card.id);
    expect(r.applied).toContain("标注");
    const after = (await api.listPending()).find((x) => x.id === card.id);
    expect(after?.agentVerdict?.reasonToRevisit).toBe("出现第二个独立来源");
    expect(after?.disposedAs).toBeUndefined();
  });

  it("update_issue / new_issue 显式抛错，不静默 no-op", () => {
    // 静默 no-op 的话，屏幕上看不出「这条议题其实没进池子」——
    // Run 记录里躺着一份漂亮的产出，而议题列表一动不动。
    for (const route of ["update_issue", "new_issue"] as const) {
      expect(() => applyA1aResult(base({ status: "ok", route }), "CARD-01")).toThrow(NotWiredYet);
    }
  });

  it("failed 不写回任何东西", () => {
    const r = applyA1aResult(base({ status: "failed", route: undefined }), "CARD-01");
    expect(r.applied).toContain("未写回");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/a1a/apply.test.ts`
Expected: FAIL，`Failed to resolve import "./apply"`

- [ ] **Step 3: 写 `src/lib/agent/a1a/apply.ts`**

```ts
/**
 * A1a 的写回。**唯一决定「这次运行要改数据层里的什么」的文件。**
 *
 * 本轮只实现 `ignore` 那一条（spec §11）。另外两条留接口并**显式抛错**：
 * 静默 no-op 的话，Run 记录里躺着一份漂亮的产出，而议题列表一动不动 ——
 * 屏幕上看不出「这条议题其实没进池子」，等到有人发现时已经过了很久。
 */
import { markCardAgentVerdict } from "@/lib/data/store";
import type { AgentRunRecord, CardAgentVerdict } from "@/lib/data/types";

/** 接口留了、写回还没接。等 Sean 提供测试后的 prompt（spec §11）。 */
export class NotWiredYet extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotWiredYet";
  }
}

const s = (o: Record<string, unknown> | null, k: string): string => {
  const v = o?.[k];
  return typeof v === "string" ? v.trim() : "";
};

export function applyA1aResult(run: AgentRunRecord, cardId: string): { applied: string } {
  if (run.status === "failed") {
    return { applied: "本次运行失败，未写回任何内容。" };
  }
  if (run.route === "ignore") {
    /*
     * 判为噪音**不等于**把这条信号收走。
     *
     * 被 CEO 递上来的信号哪怕调研后判定为没价值，也要留在信号列表里、只是
     * 标注出来 —— 删除或归档是他自己的动作。自动收走的话，他会以为系统漏了
     * 这条，而系统其实是判过的；而且他再也没法反过来质疑这次判断。
     */
    const verdict: CardAgentVerdict = {
      route: "ignore",
      verdict: s(run.output, "verdict"),
      reason: s(run.output, "reason"),
      reasonToRevisit: s(run.output, "what_would_change_it"),
      runId: run.id,
      at: run.finishedAt,
    };
    const ok = markCardAgentVerdict(cardId, verdict);
    return {
      applied: ok
        ? `已在信号 ${cardId} 上标注「调研后判为噪音」，卡仍留在列表里。`
        : `找不到信号 ${cardId}，未写回。`,
    };
  }
  throw new NotWiredYet(
    `A1a 的 ${run.route} 写回尚未接通（Run ${run.id} 已落库，产出可见可评分）。` +
      "等测试后的 prompt 定稿再接 —— 见 docs/superpowers/specs/2026-08-18-harness-sync-design.md §11。"
  );
}
```

- [ ] **Step 4: 写 `src/app/api/agent/a1a/route.ts`**

```ts
/**
 * A1a 的触发与轮询。
 *
 * 为什么是独立 route 而不是 `api` 上的一个方法：`store.ts` 已经 import 了
 * `a3/run` 和 `a4/run`；A1a 的写回要碰数据层，如果触发也放进 `api`，就成了
 * `store → a1a/run → a1a/apply → store` 的循环 import。
 *
 * **立刻返回状态，不等它跑完** —— 一次带上下文的 A1a 要两次模型调用，把请求挂
 * 在那里等于让屏幕卡死。同一张卡正在跑就直接返回 running，不排队：前端是轮询
 * 的，排队会把一次误触变成十次真实的模型调用。
 */
import { runA1a } from "@/lib/agent/a1a/run";
import { applyA1aResult } from "@/lib/agent/a1a/apply";
import { agentRunPut, agentSignalInput } from "@/lib/data/store";
import { runTask, taskState } from "@/lib/agent/tasks";

export const dynamic = "force-dynamic";

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是 JSON。");
  }
  const cardId = (body as { cardId?: unknown })?.cardId;
  const depth = (body as { depth?: unknown })?.depth;
  if (typeof cardId !== "string" || !cardId) return fail(400, "要给 cardId。");

  const found = agentSignalInput(cardId);
  if (!found) return fail(404, `没有这条信号：${cardId}`);
  const { card } = found;

  // `runTask` 是**同步**的：它立刻返回 running，后台自己跑（别加 await，
  // 那会让 eslint 的 await-thenable 报错，而且读起来像在等它跑完）。
  // 回调必须返回 `{ attempts?: number }` —— `runTask` 用它填 TaskState.attempts。
  const state = runTask("a1a", cardId, async () => {
    const run = await runA1a(
      {
        cardId,
        headline: card.headline,
        source: sourceLabel(card.source),
        body: card.what.map((x) => x.text).join("\n"),
        // `Card.source.kind === "ceo"` 不改变判断，只改变写回：判为噪音时卡仍留在
        // 列表里（见 apply.ts）。所以这里不需要往 prompt 里塞「这是 CEO 给的」——
        // 那会变成一个诱导模型别判噪音的暗示，而三条路里恰好有一条就是为这种
        // 「声量很大甚至来自 CEO」的信号准备的。
      },
      { depth: typeof depth === "string" ? depth : undefined }
    );
    agentRunPut(run);
    // 写回失败不该把 Run 记录也一起吞掉 —— 记录已经落了，产出可见可评分。
    try {
      const applied = applyA1aResult(run, cardId);
      console.log(`[tkos:a1a] ${run.id} ${run.status} → ${applied.applied}`);
    } catch (e) {
      console.warn(`[tkos:a1a] ${run.id} 已落库，但写回未接通：${e instanceof Error ? e.message : e}`);
    }
    if (run.status === "failed") throw new Error(run.error ?? "A1a 失败");
    return { attempts: 1 };
  });

  return Response.json(state);
}

export async function GET(req: Request) {
  const cardId = new URL(req.url).searchParams.get("cardId");
  if (!cardId) return fail(400, "要给 cardId。");
  return Response.json(taskState("a1a", cardId));
}

function sourceLabel(source: { kind: string; by?: string; title?: string }): string {
  if (source.kind === "dri") return `DRI ${source.by ?? ""}`.trim();
  if (source.kind === "ceo") return "一号位自己递上来的";
  if (source.kind === "probe") return `研讨衍生 · ${source.title ?? ""}`.trim();
  return "雷达";
}
```

- [ ] **Step 5: 跑测试确认全过**

Run: `npx vitest run src/lib/agent/a1a/apply.test.ts`
Expected: PASS，3 个用例

- [ ] **Step 6: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/a1a/apply.ts src/lib/agent/a1a/apply.test.ts src/app/api/agent/a1a/route.ts
```

- [ ] **Step 7: mock 下整跑一次 A1a（三条路里的两条）**

```bash
TKOS_MODEL_MOCK=1 npx next dev -p 3000
```

另开一个终端（`CARD-*` 编号从 `/api/data` 的 `listPending` 里取一个）：

```bash
curl -s -X POST localhost:3000/api/agent/a1a -H 'content-type: application/json' -d '{"cardId":"CARD-01"}'
```

Expected：立刻返回 `{"status":"running"}`；隔一两秒 `curl -s 'localhost:3000/api/agent/a1a?cardId=CARD-01'` 变成 `done`。

然后确认三件事：
1. dev server 日志里有 `[tkos:a1a] RUN-A1a-… ok → …`（mock 的 triage 罐头走的是 `new_issue`，所以这里会看到 `NotWiredYet` 的那句 warn —— **这是对的**）。
2. `curl -s -X POST localhost:3000/api/data -H 'content-type: application/json' -d '{"method":"listAgentRuns","args":["A1a"]}'` 能取到刚落的那条记录，且 `contextMode` / `snapshotId` / `contextAnchor` 都有值。
3. 把 `TKOS_GRAPHKNOWLEDGE_BASE_URL` 临时改成一个打不通的地址再跑一次：状态必须是 `failed`，**且 `listAgentRuns` 里那条记录的 `status` 是 `failed`、`output` 为 null** —— 绝不产出议题。这是 spec §10⑤ 三态里的第三条。

排查提示：
- 报「没有工程段模板」→ `prompts/engineering/` 四个文件的名字要和 key 一字不差（`a1a.issue.update.md`，不是 `a1a.update.md`）。
- 报「路由取值不合法」→ mock 罐头被改过了；`a1a.triage` 的 `decision` 必须是三个正式值之一。
- 状态一直 `running` → `runTask` 是同一 key 不排队，先确认上一次跑完了（重启 dev server 会清掉内存里的 task map）。

- [ ] **Step 8: 提交**

```bash
git add src/lib/agent/a1a/apply.ts src/lib/agent/a1a/apply.test.ts src/app/api/agent/a1a
git commit -m "feat(a1a): ignore 写回与触发 route，另两条路显式抛 NotWiredYet"
```

---

### Task 8: A3 换上下文源

**Files:**
- Modify: `src/lib/agent/a3/prompt.ts`（`A3Input` 去掉 `ontologyContext`，加 `companyContext`；注入段不再是可选）
- Modify: `src/lib/agent/a3/run.ts`（换 M7，套 harness，返回 Run 记录）
- Modify: `src/lib/data/store.ts`（`startPreResearch` 里去掉那行占位，落 Run 记录）

**Interfaces:**
- Consumes: Task 4 的 `Harness`、Task 3 的 `agentRunPut`
- Produces:
  - `type A3Input`（去掉 `ontologyContext`）
  - `function buildA3User(input: A3Input & { companyContext: string }): string`
  - `type A3Result = { doc: PreResearchDoc; violations: Violation[]; attempts: number; degraded: boolean; run: AgentRunRecord }`

- [ ] **Step 1: 改 `src/lib/agent/a3/prompt.ts`**

把 `A3Input` 里的

```ts
  ontologyContext: string | null;
```

**删掉**（它现在由 `run.ts` 单独传），并把注入那一段（第 113–114 行附近）从

```ts
  if (input.ontologyContext) {
    parts.push(`## 企业本体返回的决策上下文\n\n${input.ontologyContext}`);
  }
```

改成

```ts
  // 这一段**永远存在**。纯外部时它是 NO_COMPANY_CONTEXT，明确写着「没有」并
  // 把「引用必须为空」写成硬约束 —— 留个空洞的话模型会自己编一套公司战略假设
  // 出来然后正常引用它，那种产出格式全对、引用看着也有，只是全是假的。
  parts.push(`## 公司决策上下文（GraphKnowledge S02）\n\n${input.companyContext}`);
```

同时把 `buildA3User` 的签名改成：

```ts
export function buildA3User(input: A3Input & { companyContext: string }): string {
```

- [ ] **Step 2: 改 `src/lib/agent/a3/run.ts`**

头部 import 里删掉

```ts
import { fetchIssueContext, ontologyEnabled } from "@/lib/ontology/client";
```

换成

```ts
import { Harness, NO_COMPANY_CONTEXT } from "@/lib/agent/harness";
import type { AgentRunRecord } from "@/lib/data/types";
```

并把第一行的 `callJson` 摘掉（三处调用都换成 harness 了，留着会 lint 报未使用）：

```ts
import { parseJson, str, toStatements } from "@/lib/agent/json";
```

`A3Result` 加一个字段：

```ts
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
```

`runPreResearch` 的函数体，把「装配」那一段（第 37–54 行）换成：

```ts
  /*
   * 上下文源换成 M7 的 S02 配方。锚点由 harness 按 `issue.title` 自动选 ——
   * `q` 里**不含任何指令样板**：P3 的 q 上限是 100 字符（服务端约束），
   * 前 100 字全是「以下内容来自…请执行…」的话，拿去检索的等于模板文字。
   *
   * `GraphKnowledgeUnavailable` 不接：图服务挂了要是被当成「图谱里没有这条
   * 议题」，每一次预研都会悄悄降级成纯外部，还照样产出一份格式漂亮的报告。
   */
  const h = new Harness({ agent: "A3", slot: "pro" });
  await h.openContext("S02", input.title);
  const companyContext = h.externalOnly ? NO_COMPANY_CONTEXT : h.contextBlock;

  const assembled: ManifestItem[] = [];
  if (h.externalOnly) {
    assembled.push({ label: "本次无公司上下文（图谱里没有这条议题）", kind: "agent" });
  } else {
    const b = h.bundle!;
    assembled.push({
      label: `GraphKnowledge S02 · ${b.anchorCode} · ${b.memberIds.length} 个对象`,
      kind: "int",
    });
  }
  for (const d of input.docs) assembled.push({ label: d.title, href: `/docs/${d.id}`, kind: "int" });
  for (const j of input.judgments) assembled.push({ label: `${j.id} · 在版判断`, href: `/judgments/${j.id}`, kind: "judgment" });

  const messages = [
    { role: "system", content: A3_SYSTEM },
    { role: "user", content: buildA3User({ ...input, companyContext }) },
  ];
```

模型调用那三处从 `callJson(messages, { slot: "pro", maxTokens: 4000 })` 换成走 harness（token 才记得进 Run）：

```ts
  let raw = (await h.callMessages("模型调用 · a3.pre-research", messages, { maxTokens: 4000 }, {}, "a3.pre-research")).text;
```

重修循环里那一句同样换（label 带上轮次，便于在 trace 上数）：

```ts
    raw = (
      await h.callMessages(
        `模型调用 · a3.pre-research 重修第 ${attempts} 轮`,
        messages,
        { maxTokens: 4000 },
        { repairOf: summarize(blocking(violations)) },
        "a3.pre-research"
      )
    ).text;
```

`return` 改成：

```ts
  const degraded = blocking(violations).length > 0;
  return {
    doc,
    violations,
    attempts,
    degraded,
    run: h.finish({
      status: "ok",
      input: input.title,
      output: doc as unknown as Record<string, unknown>,
      violations: violations.map((v) => `${v.rule} ${v.severity} ${v.message}`),
      degraded,
    }),
  };
```

- [ ] **Step 3: 改 `src/lib/data/store.ts` 的 `startPreResearch`**

`runPreResearch({...})` 的入参里删掉这一行：

```ts
        ontologyContext: null, // run.ts 自己去取；这里传 null 只是占位
```

`store.preResearch[issueId] = r.doc;` 之后加一行：

```ts
      agentRunPut(r.run);
```

并把那条时间线事件的 `detail` 里「装配本体上下文后」这句改成按上下文模式说话：

```ts
        detail: p0
          ? `走完 ${r.attempts} 轮仍有 ${p0} 条质量门没过 —— 内容照常给您，问题记在运营台。`
          : r.run.contextMode === "external_only"
            ? `图谱里还没有这条议题，本轮只用了外部材料，${r.attempts} 轮成文，质量门全过。`
            : `装配公司上下文后 ${r.attempts} 轮成文，质量门全过。`,
```

理由：`external_only` 那条路上「没引用公司材料」是**对的**，但如果屏幕上不说，
读报告的人会以为本体挂了或者报告偷工减料。

- [ ] **Step 4: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/a3/prompt.ts src/lib/agent/a3/run.ts src/lib/data/store.ts
```

Expected: 干净。若 `tsc` 报 `ontologyContext` 还有引用，那是 `a4/` 里的（Task 9 处理），确认报错文件是 `a4/*` 再往下走。

- [ ] **Step 5: mock 下跑一次预研，确认渲染没变**

```bash
TKOS_MODEL_MOCK=1 npx next dev -p 3000
```

```bash
curl -s -X POST localhost:3000/api/data -H 'content-type: application/json' -d '{"method":"startPreResearch","args":["ISS-01"]}'
```

隔几秒取报告：

```bash
curl -s -X POST localhost:3000/api/data -H 'content-type: application/json' -d '{"method":"getSignal","args":["ISS-01"]}'
```

Expected：`pre` 里五个字段齐全，`assembledFrom` 第一条是 `GraphKnowledge S02 · ISS-… · N 个对象`（或纯外部那句）。再 `listAgentRuns` 确认 A3 的记录 `usage` 四项都在（mock 下全是 0，字段必须存在）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/a3 src/lib/data/store.ts
git commit -m "feat(a3): 上下文源换 M7 S02，套 harness 并落 Run 记录"
```

---

### Task 9: A4 换上下文源

**Files:**
- Modify: `src/lib/agent/a4/prompt.ts`（同 A3；`buildA4ChallengeUser` 的 `context` 变成必给的 string）
- Modify: `src/lib/agent/a4/run.ts`
- Modify: `src/lib/data/store.ts`（深研那一处）

**Interfaces:**
- Consumes: Task 4 的 `Harness`、Task 3 的 `agentRunPut`
- Produces: `type A4Result` 加 `run: AgentRunRecord`

- [ ] **Step 1: 改 `src/lib/agent/a4/prompt.ts`**

`A4Input` 里删 `ontologyContext: string | null;`；第 157–159 行附近的可选注入改成必给：

```ts
  // 见 a3/prompt.ts 上同一处的注释：这一段永远存在，纯外部时是 NO_COMPANY_CONTEXT。
  parts.push(`## 公司决策上下文（GraphKnowledge S03）\n\n${input.companyContext}`);
```

`buildA4User` 签名改成 `buildA4User(input: A4Input & { companyContext: string })`。

`buildA4ChallengeUser` 的入参里 `context: string | null;` 改成 `context: string;`，第 230 行的 `if (o.context) parts.push(...)` 改成：

```ts
  parts.push(`## 你能看到的企业上下文\n\n${o.context}`);
```

- [ ] **Step 2: 改 `src/lib/agent/a4/run.ts`**

删掉

```ts
import { fetchIssueContext, ontologyEnabled } from "@/lib/ontology/client";
```

并把 slots 的 import 从兼容 shim 改成直接指过去（`a4` 在本轮范围内，没必要再经一层）：

```ts
import { areIndependent, resolveModel } from "@/lib/models/slots";
import { Harness, NO_COMPANY_CONTEXT } from "@/lib/agent/harness";
import type { AgentRunRecord } from "@/lib/data/types";
```

第一行同样把 `callJson` 摘掉（三处调用都换成 harness 了）：

```ts
import { parseJson, str, toStatements } from "@/lib/agent/json";
```

`A4Result` 加 `run: AgentRunRecord;`。

「装配」那一段（第 58–76 行）换成：

```ts
  /*
   * S03 配方：core question 一路 `k=10 / budget=6000`，Issue 标题一路
   * `k=5 / budget=3000`。深研的材料本来就该比预研厚一档 —— 它要在四节里做取舍，
   * 材料薄了取舍就无从谈起。这两组参数由配方固定，**不随思考深度变**。
   */
  const h = new Harness({ agent: "A4", slot: "pro" });
  await h.openContext("S03", input.title);
  const companyContext = h.externalOnly ? NO_COMPANY_CONTEXT : h.contextBlock;

  const assembled: ManifestItem[] = [];
  if (h.externalOnly) {
    assembled.push({ label: "本次无公司上下文（图谱里没有这条议题）", kind: "agent" });
  } else {
    const b = h.bundle!;
    assembled.push({
      label: `GraphKnowledge S03 · ${b.anchorCode} · ${b.memberIds.length} 个对象`,
      kind: "int",
    });
  }
  for (const d of input.docs) assembled.push({ label: d.title, href: `/docs/${d.id}`, kind: "int" });
  for (const j of input.judgments) {
    assembled.push({ label: `${j.id} · 在版判断`, href: `/judgments/${j.id}`, kind: "judgment" });
  }
  if (input.preTake) assembled.push({ label: "本议题的预研结论", kind: "agent" });
```

`buildA4User({ ...input, ontologyContext })` 改成 `buildA4User({ ...input, companyContext })`。

三处 `callJson` 换成 harness：

```ts
  let raw = (await h.callMessages("模型调用 · a4.research", messages, { maxTokens: 12000 }, {}, "a4.research")).text;
```

```ts
    raw = (
      await h.callMessages(
        `模型调用 · a4.research 重修第 ${attempts} 轮`,
        messages,
        { maxTokens: 12000 },
        { repairOf: summarize(blocking(violations)) },
        "a4.research"
      )
    ).text;
```

反证那一次（**槽位是 `alt`，这是它独立的全部意义**）：

```ts
      const cText = (
        await h.callMessages(
          `模型调用 · a4.challenge（独立第二源 ${alt.model}）`,
          [
            { role: "system", content: A4_CHALLENGE_SYSTEM },
            {
              role: "user",
              content: buildA4ChallengeUser({
                title: input.title,
                judgment: doc.judgment.map((s) => s.text),
                keyEvidence: doc.keyEvidence.map((s) => s.text),
                context: companyContext,
              }),
            },
          ],
          { slot: "alt", maxTokens: 2500 },
          {},
          "a4.challenge"
        )
      ).text;
```

`return` 改成：

```ts
  const degraded = blocking(violations).length > 0;
  return {
    doc,
    violations,
    attempts,
    degraded,
    challengeCount,
    challenged,
    run: h.finish({
      status: "ok",
      input: input.title,
      output: doc as unknown as Record<string, unknown>,
      violations: violations.map((v) => `${v.rule} ${v.severity} ${v.message}`),
      degraded,
    }),
  };
```

**不动**的三样（spec §8③，正式版独有，必须保住）：`dedupe` 按前 24 字去空白、
`tagIndependent` 标 `独立第二源 · ${model}`、`assembled` 里那条带条数的 label。
它们让「跑了但没找到」和「没跑」分得开。

- [ ] **Step 3: 改 `src/lib/data/store.ts` 的深研那一处**

`runDeepResearch({...})` 入参里删掉 `ontologyContext: null, // run.ts 自己去取`；
`store.researchDocs[issueId] = r.doc;` 之后加 `agentRunPut(r.run);`。

- [ ] **Step 4: 类型检查与 lint**

```bash
npx tsc --noEmit && npx eslint src/lib/agent/a4/prompt.ts src/lib/agent/a4/run.ts src/lib/data/store.ts
```

- [ ] **Step 5: mock 下跑一次深研**

```bash
TKOS_MODEL_MOCK=1 npx next dev -p 3000
```

```bash
curl -s -X POST localhost:3000/api/data -H 'content-type: application/json' -d '{"method":"startDeepResearch","args":["ISS-01"]}'
```

Expected：`researchDocs` 出四节；日志里能看到第二源那句
`[tkos:a4] 第二源 … 返回 1 条，去重后新增 1 条`（mock 下 pro/alt 都返回罐头，
`areIndependent` 仍按注册表的 family 判 —— 家族不同就会真走这一步）。
`listAgentRuns("A4")` 里 `contextRecipe` 应为 `S03`。

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/a4 src/lib/data/store.ts
git commit -m "feat(a4): 上下文源换 M7 S03，套 harness，保住 ALT 独立反证"
```

---

### Task 10: 删 `src/lib/ontology/`，收掉最后一处调用点

**Files:**
- Create: `src/lib/agent/company-context.ts`
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/health/route.ts`
- Delete: `src/lib/ontology/client.ts`、`src/lib/ontology/compile.ts`
- Test: `src/lib/agent/company-context.test.ts`

**Interfaces:**
- Consumes: 上半的 `openContext` / `GraphKnowledgeUnavailable`；Task 4 的 `NO_COMPANY_CONTEXT`
- Produces:
  - `function wrapCompanyContext(text: string): string`
  - `async function companyContextForChat(issueTitle: string): Promise<{ block: string | null; note: string }>`

- [ ] **Step 1: 写失败测试**

`src/lib/agent/company-context.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { wrapCompanyContext } from "./company-context";

describe("wrapCompanyContext", () => {
  it("说清 [member:x] 这类锚点不要写进回复", () => {
    // 屏幕认不出、点不开的编号写进回复，一号位点一次发现是死链，
    // 之后整份回复的可信度都要打折。
    const w = wrapCompanyContext("毛利率下滑 [member:abc][partition:p][source:s]");
    expect(w).toContain("[member:");
    expect(w).toContain("不要把它写进回复");
    expect(w).toContain("毛利率下滑");
  });

  it("正文照原样带进去，不做任何改写", () => {
    expect(wrapCompanyContext("原样 $& 文本")).toContain("原样 $& 文本");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/agent/company-context.test.ts`
Expected: FAIL，`Failed to resolve import "./company-context"`

- [ ] **Step 3: 写 `src/lib/agent/company-context.ts`**

```ts
/**
 * 给 route 层用的一扇门。
 *
 * `route` 与 UI **不许直接 import `@/lib/graphknowledge`**（spec §5.5）——
 * 那一层的三态语义（命中 / 转纯外部 / 就地失败）只有懂它的调用方才接得对，
 * 而 route 里最容易写出的就是「catch 住一切，少一段上下文而已」。
 * 所以对话路径要用公司上下文，从这里拿。
 */
import { GraphKnowledgeUnavailable, openContext } from "@/lib/graphknowledge";

/** 注入 prompt 时的包裹。 */
export const wrapCompanyContext = (text: string): string =>
  `以下是公司决策上下文，来自 GraphKnowledge。每行末尾方括号里是该条的锚点。\n\n` +
  `锚点有两种，区别很重要：像 ISS-D6、JDG-01、DOC-05 这样的**短码**可以照原样引用，` +
  `屏幕会把它变成可点开的；而 [member:x][partition:y][source:z] 是图谱内部编号，` +
  `屏幕认不出、点不开 —— 不要把它写进回复，要引用那一条就改写成它对应的那句话。\n\n${text}`;

/**
 * 对话路径的公司上下文。取不到就返回 `null`，**由调用方决定要不要继续**。
 *
 * 这里与 A1a/A3/A4 有一处**有意分歧**：图服务连不上时这个函数不抛，只记一句。
 * 理由是产物性质不同 —— 一份少了公司上下文的研究报告看起来和完整的一样，那种
 * 坏产出没人查得出来，所以必须就地失败；而一次对话少一段上下文，一号位当场就
 * 感觉到答得虚，而且让他因为后台某个服务不在而完全对不了话，比少一段糟得多。
 */
export async function companyContextForChat(
  issueTitle: string
): Promise<{ block: string | null; note: string }> {
  try {
    const opened = await openContext({
      recipe: "S02",
      prefix: "ISS-",
      channel: "A3",
      q: issueTitle,
    });
    if (opened.mode === "external_only") {
      return { block: null, note: `图谱里没有这条议题的锚点：${opened.noAnchorReason ?? ""}` };
    }
    const b = opened.bundle!;
    return {
      block: wrapCompanyContext(b.renderedMarkdown),
      note:
        `命中 ${b.anchorCode}，${b.memberIds.length} 个对象、${b.renderedMarkdown.length} 字符` +
        (opened.warnings.length ? `（告警 ${opened.warnings.length} 条）` : ""),
    };
  } catch (e) {
    const why = e instanceof GraphKnowledgeUnavailable ? "图服务不可达" : "取上下文出错";
    return { block: null, note: `${why}：${e instanceof Error ? e.message : String(e)}` };
  }
}
```

- [ ] **Step 4: 改 `src/app/api/chat/route.ts`**

第 8–11 行那个 import 换成：

```ts
import { companyContextForChat } from "@/lib/agent/company-context";
```

（`OntologyResult` 这个类型也一起去掉。）

第 123–145 行那一段换成：

```ts
  /*
   * 公司上下文是**追加**的，不替换浏览器算好的那份。
   *
   * 两者来源不同：浏览器那份是 TKOS 自己对象库里的议题、报告和链路图；这一份
   * 是图谱里的公司经营状态与判断链。合并不是重复 —— 前者是「这次讨论到哪了」，
   * 后者是「公司现在是什么状况」。
   *
   * 任何失败都只记日志、不影响回复。让一号位因为后台某个服务不在而对不了话，
   * 比少一段上下文糟得多（这条与 A3/A4 的「就地失败」是有意分歧，理由写在
   * company-context.ts 上）。
   */
  let companyBlock: string | null = null;
  if (!oral && parsed.issueId) {
    // 锚点检索按自然语言问题走，不按 id。标题在服务端查，前端不用多存一份会漂移的副本。
    const title = await api.getIssue(parsed.issueId).then((i) => i.title).catch(() => null);
    if (title) {
      const r = await companyContextForChat(title);
      companyBlock = r.block;
      console.log(`[tkos:graphknowledge] ${r.block ? "注入" : "未注入"} —— ${r.note}`);
    }
  }
```

`history` 里那一行改成：

```ts
    ...(companyBlock ? [{ role: "system" as const, content: companyBlock }] : []),
```

- [ ] **Step 5: 改 `/api/health` 的 `upstream`**

`ontology` 那一项去掉（`src/lib/ontology/` 一起下线）。上半已经把 `graphknowledge`
那一项加进去了，本步只做删除，删完 `upstream` 应该是：

```ts
    // 下游配置是否就位——不暴露值，只报是否配置
    upstream: {
      model: Boolean(process.env.ARK_API_KEY || process.env.ARK_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY),
      /*
       * verifyTls:false 要在这里露出来。图服务现在是 IP + 自签证书，关校验的代价
       * 是这条链路不防中间人 —— 不报出来它就会变成一个没人记得的开关。
       */
      graphknowledge: {
        configured: Boolean(process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL),
        verifyTls: (process.env.TKOS_GRAPHKNOWLEDGE_VERIFY_TLS ?? "1").trim() !== "0",
      },
    },
```

（唯一的改动就是删掉 `ontology: Boolean(process.env.TKOS_ONTOLOGY_BASE_URL),` 那一行；
其余照上半写好的样子留着，别顺手改表达式。）

- [ ] **Step 6: 删掉 `src/lib/ontology/`**

```bash
git rm -r src/lib/ontology
```

`ONTOLOGY_CODE_OF`（`src/lib/data/store.ts:320`）**留着**：它是短码 ↔ member 的
反向表，`seed-tokenking.ts` 的注释也指着它，和 `render` 那条链路无关。先跑
`grep -rn "ONTOLOGY_CODE_OF" src` 确认它没有别的引用之后**不要删**——删掉属于与
本轮无关的行为变更。

- [ ] **Step 7: 确认没有残留引用**

```bash
grep -rn "lib/ontology\|ontologyEnabled\|ontologyContext\|fetchIssueContext\|wrapOntologyContext\|TKOS_ONTOLOGY" src
```

Expected：**零命中**。（`.env.local` 里那两个变量留着不管，下线的是代码。）

- [ ] **Step 8: 类型检查、lint、全量单测**

```bash
npx tsc --noEmit && npx eslint src/app/api/chat/route.ts src/app/api/health/route.ts src/lib/agent/company-context.ts src/lib/agent/company-context.test.ts && npx vitest run
```

Expected：`tsc` 干净；vitest 全绿（上半 21 个 + 本半份 41 个用例）。

- [ ] **Step 9: 真跑一遍验收（spec §10⑤ + §10⑥）**

先起 dev server（**不设** `TKOS_MODEL_MOCK`，用真模型）：

```bash
npx next dev -p 3000
```

按 spec §10⑤ 三态各跑一次，三种输入必须得到三种**不同**结果：

| 输入 | 必须得到 |
|---|---|
| 图谱里有的议题 | 报告有引用，`listAgentRuns` 里 `contextMode:"anchored"`、`contextAnchor` 有值 |
| 图谱里没有的议题（临时把 `Issue.title` 改成一句无关的话） | **跑完出报告**，`contextMode:"external_only"`，`assembledFrom` 第一条是「本次无公司上下文」 |
| 把 `TKOS_GRAPHKNOWLEDGE_BASE_URL` 临时改错 | **就地失败**，`store.preResearch` 里没有新报告 |

这条不过，三态等于白做。

然后 §10⑥ UI 回归：`preview_start { name: "clark" }`，走一遍参谋室，确认
`PreResearchDoc` / `ResearchDoc` 渲染**一个字没变**。输出形状不动就是为了这一步
能空手过。

最后 §10④：`listAgentRuns()` 抽一条真模型的记录，确认
`usage` 四项有值、`trace` 上 `effortSent` 是 `null`（火山三个都不吃这个字段，
**null 是对的，不是漏了**）、复现坐标八项齐全。

排查提示：
- 报告出来了但 `contextMode` 是空 → `openContext` 没被调到，检查 `runPreResearch` 里 harness 那几行有没有被重修循环跳过。
- `effortSent` 有值 → `registry.ts` 里某个模型的 `acceptsEffort` 被写成了 true。三个火山模型都该是 false。
- 第三态没有失败反而出了报告 → `run.ts` 里有人给 `openContext` 套了 try/catch。摘掉。

- [ ] **Step 10: 提交**

```bash
git add -A src/app/api/chat/route.ts src/app/api/health/route.ts src/lib/agent/company-context.ts src/lib/agent/company-context.test.ts src/lib/ontology
git commit -m "refactor: 删 src/lib/ontology/，对话路径改走 GraphKnowledge"
```

---

## 这一半交付了什么

- **五段 prompt 装配落地**：A1a 四个工程 prompt 进 `prompts/engineering/`，改完重启即生效；认知段留空且「这次跑的时候还没有认知段」在 Run 记录里查得出来。
- **A1a 三条路都跑、都落 Run**：`ignore` 真写回（信号留在列表里并标注，CEO 自己决定删不删），另两条 `throw NotWiredYet` 而不是静默 no-op。
- **A3/A4 的上下文源换成 M7**，套上 harness 的 trace 与四项 token 计量，输出形状与 validate→repair 循环一个字没动，UI 空手过。
- **`src/lib/ontology/` 下线**，三处调用点收干净，`route` 不再直连图谱层。
- **`TKOS_MODEL_MOCK=1`** 能一个 token 不烧地把三条链路整跑一遍。
- 本半份新增 41 个单测用例（prompt 7 / checks 12 / agentRuns 4 / harness 7 / mock 5 / a1a 路由 3 / apply 3），全部不联网、不调模型。

## 留给下一轮的（用户已明确本轮不做）

| 留口 | 现在的行为 | 等什么 |
|---|---|---|
| `applyA1aResult()` 的 `update_issue` / `new_issue` | Run 已落、产出可见可评分，写回处 `throw NotWiredYet` | Sean 提供测试后的 prompt |
| `prompts/cognitive/*.md` | 目录里只有 README，`{{COGNITIVE}}` 是占位说明，`cognitiveSource: "empty"` 进 Run 记录 | 同上 |
| 会前 / 会后两条 agent 链路 | 不存在 | 之后的测试任务 |
| 信号卡上那条标注的**渲染** | 已写进 `Card.agentVerdict`、`getSignal` / `listPending` 都带出来，但屏幕上还没画 | 交互与 UI 调整那一轮（本轮 spec §2 明确排除 UI） |
