# 02 · signal → 潜在议题（A1a）

> 快照 2026-08-21。对应五段流程里的第 ② 段。这条链路是**唯一**走「五段装配」机制的（见 `00` 第一节）。

## 一、这条链路做什么

收进来一条信号，A1a 判断三件事之一，然后写出议题正文：

| 路由 | 什么情况 | 用哪个 prompt key |
| --- | --- | --- |
| `ignore` | 这条信号不值得转化成潜在议题 | 到 `a1a.triage` 就结束（Run 记 `status: "ignored"`） |
| `update_issue` | 公司已经有一条议题在承接它，但那条的说法被这条信号改了 | `a1a.issue.update` |
| `new_issue` | 公司还没有承接它的议题 | `a1a.issue.new` |

**两次调用，不是一次。** 先选路（`a1a.triage`），再写正文（`a1a.issue.*`）。拆开的理由是选路的判据和
写正文的判据不是一回事，合成一次会让模型一边写正文一边给自己找路 —— 于是正文写得越顺，路走得越不用心。
所以 triage 那一份里有一句硬约束：**「不要在这一步写议题正文。」**

**还有第四个 key：`a1a.issue.external`。** 图谱里没有锚点（拿不到任何既有议题）时走它，**跳过选路那一步** ——
无从取代，只剩「忽略」或「新建」两条路，选路那一次调用就没有意义了。

## 二、四个 prompt key 与它们的两个文件

每个 key 有两份文件，运行时按五段拼起来（① 输入契约 ② 上下文注入 ③ 认知指令 ④ 输出格式 ⑤ 硬约束）：

| prompt key | 工程段 | 认知段 |
| --- | --- | --- |
| `a1a.triage` | `prompts/engineering/a1a.triage.md` | `prompts/cognitive/a1a.triage.md` |
| `a1a.issue.new` | `prompts/engineering/a1a.issue.new.md` | `prompts/cognitive/a1a.issue.new.md` |
| `a1a.issue.update` | `prompts/engineering/a1a.issue.update.md` | `prompts/cognitive/a1a.issue.update.md` |
| `a1a.issue.external` | `prompts/engineering/a1a.issue.external.md` | `prompts/cognitive/a1a.issue.external.md` |

四份认知段引的都是同一份技能 `{{SKILL:m1a-s01-issue-framing}}`（全文在 `skills/` 目录），
各自只写「这一次走技能里的哪几步、字段怎么对应、这条路上最容易犯的错是哪几种」。

## 三、System 段（四个 key 共用一句）

装配器给的 system 是同一句，写在 `src/lib/agent/prompts.ts`：

```text
你是使用 GraphKnowledge 公司上下文的 TKOS 专用 Agent。严格按给定的输出格式作答，只输出 JSON，不要任何解释性文字、不要 Markdown 代码围栏。上下文里没有的事实一律不要写。
```

## 四、① 输入契约那一段实际填进去的东西

`{{INPUT}}` 由 `src/lib/agent/a1a/run.ts` 拼出来。选路那一次只有信号本身：

```ts
const signalBlock = (input: A1aInput): string =>
  `信号原文：\n${input.body?.trim() || input.headline}\n\n来源：${input.source || "（未提供）"}`;
```

写正文那一次会把上一步的定性结论一起递下去 —— 写正文的时候要知道自己是被判成哪条路的、为什么：

```ts
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
```

## 五、这条链路的代码原文

`{{CONTEXT}}` 来自 `Harness.contextBlock`（三档，见 `00` 第三节）。整条链路：

```ts
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
    // 改写之前把原值取下来：这条路只有两个合法取值，改写必须留痕，否则模型违反
    // 硬约束（比如给了 update_issue）时，产出照样是一条格式完整的 new_issue。
    // 不是字符串也照原样带出来（`JSON.stringify` 一下）：塌成空串的话自检会报「没给
    // decision」，而下一行就把原值盖掉了 —— 「给了个数字」和「一个字都没给」这两件事
    // 从此没人能分。
    const raw =
      out.decision == null
        ? ""
        : typeof out.decision === "string"
          ? out.decision.trim()
          : JSON.stringify(out.decision);
    out.decision = ignored ? "ignore" : "new_issue";
    return h.finish({
      status: ignored ? "ignored" : "ok",
      input: inp,
      output: out,
      route: ignored ? "ignore" : "new_issue",
      checks: a1aExternal(out, raw),
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

模型偶尔会把路由值写成中文或近义词。能确定对应关系的归一化，但**不猜** —— 归一化过的会在自检里标出来，
对不上的直接失败：随便挑一条会产出一份格式完整、却走错了路的议题，而且毫无迹象。

```ts
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
```

---

# Prompt 原文

下面八份是逐字导出，路径就是仓库里的路径。`{{INPUT}}`、`{{CONTEXT}}`、`{{COGNITIVE}}`、
`{{SKILL:…}}` 是装配时被替换掉的标记。

## 六、`a1a.triage` —— 选路

### 6.1 工程段 · `prompts/engineering/a1a.triage.md`

```markdown
<!-- 对齐自 tkos-lab/prompts/engineering/a1a.triage.md -->
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

### 6.2 认知段 · `prompts/cognitive/a1a.triage.md`

```markdown
{{SKILL:m1a-s01-issue-framing}}

---

## 这一次只走技能里的前三步

上面那份技能覆盖 S01 全流程。这一次调用**只做定性和选路**，正文留给下一次调用：

- **Step 1 Understand Signal & Find Real Tension** —— 去掉表层 framing，找到真正
  被挑战的那条假设或经营逻辑。这一步的结论写进 `signal_reading`：写的是「这条
  信号在说的事」，不是复述原文，也不是它的标题。
- **Step 2 Real Issue Qualification** —— real / material / decision-oriented 三条
  任一不成立，就是技能里的 **No Issue**，在这里对应 `ignore`。「量很大」「CEO 亲自
  给的」都不构成 material；`ignore` 是一个判断，所以必须说得出
  `what_would_change_it` —— 说不出的，说明还没判完。
- **Step 3 Match Issue History** —— 只分两种：同一个 underlying tension 已经有议题
  在承接（Existing → `update_issue`），还是没有（New → `new_issue`）。相邻、相关、
  可以放在一起讨论，都算 New。判 `update_issue` 时 `target_issue_code` 必须是上面
  公司决策上下文里真实出现过的编号。

Step 4 到 Step 6（形成候选、Valid Framing Check、Final Quality Gate）**这一次不做**。
选路和写正文分成两次调用，是为了让「路走错了」和「正文写得不好」在事后分得开。

`rationale` 写的是选路依据：Step 2 的哪一条成立、Step 3 为什么落在这一边。技能里
`Sharp Title` / `What Happened` / `Implication` 那套结构属于下一次调用，这一次一个
字都不要写。
```

## 七、`a1a.issue.new` —— 新建一条潜在议题

### 7.1 工程段 · `prompts/engineering/a1a.issue.new.md`

```markdown
<!-- 对齐自 tkos-lab/prompts/engineering/a1a.issue.new.md -->
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
 "sharp_title": "一个短问句：最值得判断的那一个张力",
 "issue_statement": "新潜在议题的正文，一到三句",
 "what_happened": "一个 decisive observation",
 "evidence_boundary": "这次的证据到哪儿为止",
 "business_consequence": "这条张力一旦成立，哪一个当前重要判断需要重新审视",
 "real_question": "当前真正需要进一步回答的那一个核心问题",
 "source_line": "最小来源信息",
 "shakes_assumption": "动摇哪条战略假设",
 "suggested_handling": "建议怎么处理",
 "cited_member_ids": ["你引用到的 member id"]}

**一段一件事，不要互相重复。** 这七段是七个不同的问题，同一句话出现在两段里，
说明其中一段你没答。

## 硬约束

### 关于形状
- 每段一句到三句，不要展开成段落。**不写小标题、不写 markdown**（星号井号会
  原样显示在屏幕上）—— 段名、加粗、顺序、「证据边界：」那类前缀全由屏幕负责，
  你只填内容。
- 引号一律用「」。中英文与数字之间加空格：写「产品 1.0」「AI Agent 入职」。

### 关于每一段
- `sharp_title`：**短问句**，一行以内。它是一号位在清单上扫到的那一行。
  - 不用「是否应该 / 要不要做 X」这种句式 —— 那是在问某个方案要不要做，而这一步
    要问的是使那个方案成为问题的更前置的张力；
  - 不停留在功能、界面或一次具体操作上；
  - 不把一个还没验证的解释写成题设（「因为 A 导致 B，我们该怎么办？」——
    A 导致 B 本身就是这次要判的东西）。
- `issue_statement`：议题正文，不是信号摘要。写成一个公司需要想清楚的问题或取舍，
  不要复述发生了什么（那是 `what_happened` 的事）。**只承载一个核心不确定性** ——
  出现第二个问号，通常就是把两条议题塞进了一条。它和 `sharp_title` 必须是同一个问题。
- `what_happened`：**一个**核心观察，不是把信号逐条复述一遍。判据是「哪一件事使
  原有判断值得重新审视」。多个独立来源同时指向同一件事时，那个「同时」本身就是
  那一个观察。
- `evidence_boundary`：这次的证据到哪儿为止。**这一段不许空着，也不许写成
  「信息有限」这种废话**，要具体说出是哪一种不足：数据是企业自披露还是第三方核实、
  有没有失败案例与成本、样本是一个还是多个、时间窗有多长、哪一句是媒体叙事而不是
  事实。这一段的存在就是为了否掉读完上一段最自然的那个假设 ——「这些都已经核实过了」。
- `business_consequence`：**一个**当前重要判断可能需要重新审视。写成双向的：
  张力成立会怎样，不成立而我们提前动了又会怎样。两边都写才是取舍。
- `real_question`：一个问句。它是 `sharp_title` 的完整版，不是它的第二个版本。
- `source_line`：极简，一行。二手汇编、转引、未独立核实的，**必须写出来**。
  它不承担正文论证。
- `shakes_assumption` 必须指向上面上下文里具体的某一条，不能泛泛而谈。
- `cited_member_ids` 里的每一个 ID 都必须出现在上面的上下文里。编造 ID 视为失败。

### 关于强度
- 上下文和信号原文里没有的事实不要写进来，一个数字都不要编。
- **结论强度不许超过证据强度。** 确定性、重要性、范围、机制四项各自成立才写得那么硬。
  证据只支持「多家企业在同一时间窗口做了同一件事」时，不要写成「行业拐点已至」；
  只有任务级的自披露数据时，不要写成「效率提升已被验证」。
- 到 Implication 就停。不要展开论证、不要给研究计划、不要列三种情形 ——
  那是下一步预研的活，在这里做完等于替它把结论先下了。
```

### 7.2 认知段 · `prompts/cognitive/a1a.issue.new.md`

```markdown
{{SKILL:m1a-s01-issue-framing}}

---

## 这一次走技能里的后三步：New Issue

前三步（找 real tension、Real Issue Qualification、Match Issue History）上一次调用
已经做完，结论就在输入里的【上一步的定性结论】那一段：这条信号背后是一个真实、
material、decision-relevant 的问题，而公司现在还没有议题在承接它。**不要重做那三步**，
也不要推翻它 —— 这一次做的是：

- **Step 4 Form Candidate Potential Issue** —— 基于 real tension 首次形成议题正文；
- **Step 5 Valid Framing Check** —— 对象、分类轴 / 因果前提、层级、core uncertainty、
  是否把答案偷塞进了问题。不过就在心里改完再写，不要把检查过程写出来；
- **Step 6 Final Quality Gate** —— claim strength 不超过 Evidence，标题与正文回答
  同一个 underlying issue。

## 技能里那四块，对应下面 JSON 的哪个字段

**§5.1 那四块是一块一块交的，不是一段字。** 技能里写成

    Sharp Title：…
    What Happened：…

是为了让人读懂结构；这里每一块单独占一个字段，段名、加粗、顺序、「证据边界：」那类
前缀全部由屏幕负责。所以 `Sharp Title：` / `What Happened：` 这种写法**不要出现在
输出里**，一个星号一个井号都不要 —— 屏幕按纯文本渲染，写了就原样显示出来。

| 技能里的块 | 这里的字段 |
|---|---|
| Sharp Title | `sharp_title` —— 短问句，一行 |
| §5.2 Potential Issue Statement | `issue_statement` —— 交给下一步预研的就是它 |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，不要并进上一格** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Relevant Company Context 里被动摇的那一条 | `shakes_assumption` |
| Issue-origin Evidence | `cited_member_ids` |

拆成两格是有原因的。Evidence boundary 和 real question 是这四块里最容易被吞掉的
两句 —— 并进正文时它们变成长段落的最后一个从句，而 boundary 要否掉的恰恰是读完
观察最自然的那个假设（「这些都已经核实过了」），real question 是下一步预研照着跑的
那一句。单独一格意味着**空着就是空着**，看得见。

## 这一步最容易出的四种错

技能 §6 十三条里，落到这个字段表上最常犯的是这四条：

- **Signal Restatement** —— `what_happened` 把信号逐条复述一遍，`issue_statement` 只是
  给它换了个标题。判据：`issue_statement` 里如果没有一处「不确定」，它就不是议题；
- **Hypothesis as Premise** —— `sharp_title` 写成「因为 A 导致 B，我们该怎么办？」，
  而 A 导致 B 本身就是这次要判的东西；
- **Wrong Level** —— `shakes_assumption` 指不到上面上下文里具体的某一条，只能写
  「影响公司战略方向」。指不到就回去把对象问准；
- **Mini Pre-research** —— 在 `business_consequence` 里展开论证、列情形、给研究计划。
  到 Implication 停。下一步预研会做，在这里做完等于替它把结论先下了。

还有一条 **Multi-question Handoff**：`issue_statement` 里出现第二个问号，通常就是把
两条议题塞进了一条。技能要求一个 Statement 只承载一个核心 uncertainty。
```

## 八、`a1a.issue.update` —— 取代一条既有议题

**这一步产出的是取代，不是补充。** 既有议题不改字 —— 它已经被引用过、被讨论过，改掉它等于改掉一段历史。

### 8.1 工程段 · `prompts/engineering/a1a.issue.update.md`

```markdown
<!-- 对齐自 tkos-lab/prompts/engineering/a1a.issue.update.md -->
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
 "sharp_title": "一个短问句：取代之后最值得判断的那一个张力",
 "issue_statement": "新议题正文，取代旧那条",
 "what_happened": "一个 decisive observation：这条信号里哪一件事使旧说法不再准确",
 "evidence_boundary": "这次的证据到哪儿为止",
 "business_consequence": "换成新说法之后，哪一个当前重要判断需要重新审视",
 "real_question": "当前真正需要进一步回答的那一个核心问题",
 "source_line": "最小来源信息",
 "what_changed": "相对旧议题，变的是哪一处",
 "why_replace_not_new": "为什么是取代，而不是另开一条新议题",
 "shakes_assumption": "动摇哪条战略假设",
 "suggested_handling": "建议怎么处理",
 "cited_member_ids": ["你引用到的 member id"]}

**一段一件事，不要互相重复。** 这些段是不同的问题，同一句话出现在两段里，说明其中
一段你没答。特别是 `what_changed`（新旧差在哪一处）和 `what_happened`（信号里发生了
什么）不是同一件事：前者对着旧说法说，后者对着世界说。

## 硬约束

### 关于取代
- `target_issue_code` 必须是上面上下文里真实出现过的 `ISS-*` 编号。
- `statement_before` 从上下文**照录**，不要改写——事后要靠它对出新旧两条差在
  哪里。
- `issue_statement` 不能和 `statement_before` 相同，也不能只差标点：那不是取代。
- `what_changed` 要指到具体一处（范围 / 前提 / 时点 / 取舍的方向），不要写
  「更全面了」「更清晰了」这类。

### 关于形状
- 每段一句到三句，不要展开成段落。**不写小标题、不写 markdown**（星号井号会原样
  显示在屏幕上）—— 段名、加粗、顺序、「证据边界：」那类前缀全由屏幕负责，你只填内容。
- 引号一律用「」。中英文与数字之间加空格。

### 关于每一段
- `sharp_title`：**短问句**，一行以内。不用「是否应该 / 要不要做 X」这种句式 ——
  那是在问某个方案要不要做，而这一步要问的是使那个方案成为问题的更前置的张力。
  它和 `issue_statement` 必须是同一个问题。
- `issue_statement`：**只承载一个核心不确定性**。出现第二个问号，通常就是把两条
  议题塞进了一条 —— 而这一步尤其容易：旧说法加上新证据，最省事的写法就是把两者
  并列成两问，那不是 reframe，是拼接。
- `what_happened`：**一个**核心观察，不是把信号逐条复述一遍。判据是「哪一件事使
  旧说法不再准确」。
- `evidence_boundary`：这次的证据到哪儿为止。**不许空着，也不许写成「信息有限」
  这种废话**，要具体：数据是自披露还是第三方核实、样本是一个还是多个、时间窗多长、
  哪一句是媒体叙事而不是事实。它要否掉的是读完上一段最自然的那个假设 ——
  「新说法已经被证实了」。
- `business_consequence`：**一个**当前重要判断可能需要重新审视。写成双向的：
  新说法成立会怎样，不成立而我们已经按它动了又会怎样。
- `real_question`：一个问句，是 `sharp_title` 的完整版，不是它的第二个版本。
- `source_line`：极简，一行。二手汇编、转引、未独立核实的必须写出来。
- `cited_member_ids` 里的每一个 ID 都必须出现在上面的上下文里。编造 ID 视为失败。

### 关于强度
- 上下文和信号原文里没有的事实不要写进来，一个数字都不要编。
- **结论强度不许超过证据强度。** 一条信号能支持「旧说法的某一处需要修」，不等于
  能支持「旧判断已经被推翻」。
- 到 Implication 就停。不要展开论证、不要给研究计划 —— 那是下一步预研的活。
```

### 8.2 认知段 · `prompts/cognitive/a1a.issue.update.md`

```markdown
{{SKILL:m1a-s01-issue-framing}}

---

## 这一次走技能里的后三步：Existing Issue 的 Reframing

前三步上一次调用已经做完，结论在输入里的【上一步的定性结论】那一段：这是一个
**Existing Issue** —— underlying tension 和公司最终要判断的对象没变，变的是现有说法
已经不能准确描述它了。所以这一次做的是技能里的 **Reframing**：

- **Step 4** —— 先读上面上下文里那条议题的现说法，再看这条信号新增了什么。现说法
  仍然准确的，原则上不动；不能描述 real tension 了，才改；
- **Step 5 Valid Framing Check** —— 改完的那条，对象、分类轴 / 因果前提、层级、core
  uncertainty 逐项要站得住；
- **Step 6 Final Quality Gate** —— claim strength 不超过 Evidence。

技能里那条边界在这一步最要紧：**同一个 underlying tension 只是说法要修** → 就是这一
条路；**新增 Evidence 暴露了另一个 tension 或另一个决策对象** → 那是一条新议题，不是
取代。说不出「为什么是取代而不是另开一条」的，通常就是后者。

## 「取代」怎么对上技能里的版本历史

技能要求 Reframe 时保留 Issue identity 和必要的版本历史，交给下游的是新的 Current
Statement。这里的做法是**旧那条一个字都不改**（它已经被引用过、被讨论过），另写一条
新的去取代它：

| 技能里的概念 | 这里的字段 |
|---|---|
| Current Statement（Reframe 之后的当前问题） | `issue_statement` |
| Previous Statement（版本历史） | `replaces.statement_before` —— 从上下文**照录**，不要改写 |
| Issue identity | `target_issue_code` / `replaces.code` |
| Reframing reason | `what_changed` 与 `why_replace_not_new` |
| Sharp Title | `sharp_title` —— 短问句，一行 |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，不要并进上一格** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Relevant Company Context 里被动摇的那一条 | `shakes_assumption` |

`what_changed` 要指到具体一处（范围 / 前提 / 时点 / 取舍的方向）。写「更全面了」
「更清晰了」的，是技能里的 **Silent Reframing** —— 改了题却说不清改的是哪一处，
事后没人能对出新旧两条差在哪里。

**§5.1 那四块是一块一块交的，不是一段字。** 技能里 `Sharp Title：` / `What Happened：`
那种写法**不要出现在输出里**，一个星号一个井号都不要 —— 段名、加粗、顺序、
「证据边界：」那类前缀由屏幕负责，屏幕按纯文本渲染，写了就原样显示出来。

## 这条路上最容易出的三种错

- **Multi-question Handoff** —— 这一步最容易犯：旧说法加上新证据，最省事的写法就是
  把两者并列成两问。那不是 reframe，是拼接。`issue_statement` 里出现第二个问号，
  回去挑出真正变了的那一个；
- **Overclaiming** —— 一条信号能支持「旧说法的某一处需要修」，不等于能支持
  「旧判断已经被推翻」。`evidence_boundary` 就是拦这个的：新说法这次到底被证到
  哪一步，写出来；
- **Mini Pre-research** —— 在 `business_consequence` 里展开论证、列情形。到 Implication
  停，下一步预研会做。

`what_changed` 对着旧说法说，`what_happened` 对着世界说 —— 两格写成同一句话，
说明其中一格你没答。
```

## 九、`a1a.issue.external` —— 没有公司上下文时那条路

### 9.1 工程段 · `prompts/engineering/a1a.issue.external.md`

```markdown
<!-- 对齐自 tkos-lab/prompts/engineering/a1a.issue.external.md -->
## 输入
你会收到一条信号（外部靶点或内部经营 Evidence）的原文与来源。

{{INPUT}}

## 公司决策上下文
{{CONTEXT}}

## 你要想清楚什么
{{COGNITIVE}}

## 这一次的特殊之处
公司战略数据库里没有与这条信号对应的锚点：**没有可引用的 member，也看不到任何
既有议题**——所以这次不存在「取代某条既有议题」这个选项，只有两条路：新建，
或者忽略。上面那一段公司决策上下文里到底有没有公司材料、有的是哪一层，那一段
自己写明白了，按它写的来；它没给的，就是这次你不知道的。

这不是让你停下来。这条信号仍然可能值得变成一个潜在议题——只是这次判断的依据
主要是信号本身和公开可查的通行事实。所以要回答的是一个更基本的问题：

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
 "sharp_title": "一个短问句：最值得判断的那一个张力",
 "issue_statement": "潜在议题的正文，一到三句",
 "what_happened": "一个 decisive observation",
 "evidence_boundary": "这次的证据到哪儿为止",
 "business_consequence": "这条张力一旦成立，哪一类当前重要判断需要重新审视",
 "real_question": "当前真正需要进一步回答的那一个核心问题",
 "source_line": "最小来源信息",
 "why_it_qualifies": "值得成为议题的解释",
 "cited_member_ids": []}

**一段一件事，不要互相重复。** 这几段是几个不同的问题，同一句话出现在两段里，
说明其中一段你没答。

## 硬约束

### 关于分支
- `decision` 只能是 `ignore` 或 `new_issue`，原样小写英文。这条路上没有既有议题，
  `update_issue` 不成立。
- 判定不值得时，`verdict` 必须**原样**是「此信号不值得转化为潜在议题」，不要
  改写、不要加标点。下游按这句话识别这个分支。
- 判不值得也是一个判断，不是搁置：必须说得出什么情况下它会重新变得值得处理。
- `cited_member_ids` 必须是空数组 `[]`。这次没有任何 member 可引，写进去的一定
  是编的。

### 关于形状
- 每段一句到三句，不要展开成段落。**不写小标题、不写 markdown**（星号井号会原样
  显示在屏幕上）—— 段名、加粗、顺序、「证据边界：」那类前缀全由屏幕负责，你只填内容。
- 引号一律用「」。中英文与数字之间加空格。

### 关于每一段
- `sharp_title`：**短问句**，一行以内。不用「是否应该 / 要不要做 X」这种句式 ——
  那是在问某个方案要不要做，而这一步要问的是使那个方案成为问题的更前置的张力。
  也不要停留在某个功能或一次具体操作上，也不要把一个还没验证的解释写成题设。
  它和 `issue_statement` 必须是同一个问题。
- `issue_statement` 是议题正文，不是信号摘要：写成一个公司需要去想清楚的问题或
  取舍，不要复述新闻发生了什么。**只承载一个核心不确定性**。
- `what_happened`：**一个**核心观察，不是把新闻逐条复述一遍。判据是「哪一件事使
  原有判断值得重新审视」。多个独立来源同时指向同一件事时，那个「同时」本身就是
  那一个观察。
- `evidence_boundary`：这次的证据到哪儿为止。**这一段在这条路上最要紧，不许空着，
  也不许写成「信息有限」这种废话** —— 没有内部材料兜底，唯一的一手材料就是信号
  原文。要具体说出是哪一种不足：数据是企业自披露还是第三方核实、有没有失败案例
  与成本、样本是一个还是多个、时间窗有多长、哪一句是媒体叙事而不是事实。
- `business_consequence`：**一个**当前重要判断可能需要重新审视。这次说不出「公司的
  哪一条」（没有锚点），就说清「做这门生意的人的哪一条」。写成双向的：张力成立
  会怎样，不成立而提前动了又会怎样。
- `real_question`：一个问句，是 `sharp_title` 的完整版，不是它的第二个版本。
- `source_line`：极简，一行。二手汇编、转引、未独立核实的**必须写出来** ——
  这条路上它是读者判断可信度的唯一凭据。它不承担正文论证。
- `why_it_qualifies` 要说清「一旦成立，什么会不得不变」。两到四句。它回答的是
  「够不够分量进议题队列」，不是把 `business_consequence` 再说一遍。

### 关于强度
- 不要就**这条信号**写「公司现有战略假设是……」「公司此前认为……」这类句子。图谱里
  没有这条信号的锚点，所以公司对它的既有看法这次一定没有材料告诉你，那种句子是推想。
- 上下文和信号原文里都没有的事实不要写，一个数字都不要编。
- **结论强度不许超过证据强度。** 确定性、重要性、范围、机制四项各自成立才写得那么硬。
  证据只支持「多家企业在同一时间窗口做了同一件事」时，不要写成「行业拐点已至」；
  只有任务级的自披露数据时，不要写成「效率提升已被验证」。
- 到 Implication 就停。不要展开论证、不要给研究计划、不要列三种情形 ——
  那是下一步预研的活，在这里做完等于替它把结论先下了。
```

### 9.2 认知段 · `prompts/cognitive/a1a.issue.external.md`

```markdown
{{SKILL:m1a-s01-issue-framing}}

---

## 这一次没有 Company Context，所以技能里两条规矩变成主约束

上面那份技能把 **Relevant Company Context** 列为 Must-have，而这一次它不存在：公司
战略数据库里没有与这条信号对应的锚点。技能对这种情况已经给了答案，就在 §3
「Context 不足时」那一段，这次要严格照它办：

- **不得只凭「行业重要」升级为公司级 Issue。** 热度、声量、别人都在讨论，都不是
  material；
- **不得把二手描述写成已确认 Fact。** 这次唯一的一手材料就是信号原文本身；
- **Company Context 用于判断 relevance 与 consequence，不用于反向制造 underlying
  issue** —— 反过来说，没有 Company Context 时更不许凭空造一个出来。所以不要写
  「公司现有战略假设是……」「公司此前认为……」：你不知道，这次没有材料告诉你。

## 走技能里的哪几步

这一次把前后两半合成一次调用，但顺序不变：

- **Step 1 Find Real Tension** —— 去掉表层 framing，找到真正被挑战的假设或约束；
- **Step 2 Real Issue Qualification** —— 三条里 material 那一条这次最吃紧：判断依据只有
  信号本身和公开可查的通行事实。不合格就是技能里的 **No Issue**，在这里对应
  `ignore`；
- **Step 3 Match Issue History** —— 这次跳过。看不到任何既有议题，Existing 无从判断，
  所以「取代」这条路不成立，只剩新建或忽略；
- **Step 4–6** —— 判值得时，形成议题正文并过一遍 Valid Framing Check 与 Final Quality
  Gate。

## 字段对应

**§5.1 那四块是一块一块交的，不是一段字。** 技能里 `Sharp Title：` / `What Happened：`
那种写法**不要出现在输出里**，一个星号一个井号都不要 —— 段名、加粗、顺序、
「证据边界：」那类前缀由屏幕负责，屏幕按纯文本渲染，写了就原样显示出来。

| 技能里的块 | 这里的字段 |
|---|---|
| Sharp Title | `sharp_title` —— 短问句，一行 |
| §5.2 Potential Issue Statement | `issue_statement` |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，这条路上它最要紧** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Real Issue Qualification 的结论 | `why_it_qualifies` —— 说清「一旦成立，什么会不得不变」 |
| No Issue 的 Reason | `reason` |
| 什么情况下它会重新值得处理 | `what_would_change_it` |

`business_consequence` 和 `why_it_qualifies` 不是同一件事：前者说哪一个当前重要判断
需要重新审视，后者说这件事够不够分量进议题队列。两格写成同一句话，说明其中一格
你没答。这次说不出「公司的哪一条」（没有锚点），就说清「做这门生意的人的哪一条」。

## 这条路上最容易出的三种错

- **Overclaiming** —— 技能 §6 里的这一条在这条路上最容易犯：没有内部材料兜底，
  certainty / materiality / scope / mechanism 四项里任意一项超出信号本身能支持的
  强度，就是编。`evidence_boundary` 是专门拦它的那一格：**这一格是这条路上最贵的
  一句**，唯一的一手材料就是信号原文，所以「哪一句是媒体叙事而不是事实」必须
  由你写出来，没有第二个人会补；
- **Over-strategizing** —— 一次性事件、执行层面的操作问题、只是热度高的话题被拔高成
  公司级议题。宁可判不值得：把不够分量的信号放进议题队列，后面每一步都会照着它跑；
- **Mini Pre-research** —— 在 `business_consequence` 或 `why_it_qualifies` 里展开论证、
  列三种情形、给研究计划。到 Implication 停，下一步预研会做。
```
