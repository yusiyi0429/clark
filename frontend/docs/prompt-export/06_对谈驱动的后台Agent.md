# 06 · 对谈驱动的四个后台调用（A2 / A6 / A10 / 起标题）

> 快照 2026-08-21。这一份是 `05` 的续篇：对谈过程中和对谈结束时，后台还有几次模型调用在跑，
> 它们各有自己的 system prompt。四个都是**代码内常量，故意没有认知段**（不归方法部门管）。

| Agent | 什么时候跑 | 干什么 | 槽位 |
| --- | --- | --- | --- |
| **A6** | **每一轮对话之后**都跑 | 判断这一轮之后判断板该不该动 | `flash` |
| **A2** | 他按「收敛成一句题」时 | 把一场探讨收敛成一句需要公司决定的题 | `pro` |
| **A10** | 议题讨论完、要写回时 | 收成一份写回提案（七要素） | `pro` |
| **起标题** | 他贴进来一份材料时 | 给材料起一行标题 | `flash` |

---

## 一、A6 · 从一轮对话里提判断（`src/lib/agent/a6/extract.ts`）

**这是唯一每轮都跑的后台调用。** 它只做一件事：看这一轮之后，判断板该不该动。

三件事各自独立，而且**绝大多数轮次三件都是空的**：

1. `formed` —— 这一轮形成了新的候选判断（最多 2 条）。system 里先列了六条**不算**的，再列三条算的。
2. `confirms` —— 他确认了板上某一条（最多 3 条）。只有明确指着某一条说他认才算；
   **「他没给理由就不算确认。」**
3. `aside` —— 岔出去的那件事，必须写得出 `why`，否则给 null。

工程细节：`temperature: 0.2`、maxTokens 2000、**不开公司上下文**（`contextMode` 是空串 ——
这一步只读这一轮对话和板上现有的几条，公司材料对它没用）。`formed`/`confirms` 都空时
Run 记 `status: "ignored"`，不是 `ok`。

编号解析（`resolveRef`）认 `R1` / `1` / 「第 1 条」三种写法，但**只在唯一命中时**才认 ——
含糊的一律不动板。

### 1.1 System 段原文

```text
你在看一号位和他的参谋就某个议题的一轮对话。屏幕左栏是这个议题的**判断板**：上半层是还没经过他的候选判断，下半层是他已经确认成公司口径的。你只做一件事：判断这一轮之后，那块板该不该动。

三件事各自独立，绝大多数轮次三件都是空的：

## 一、这一轮有没有长出一条判断（formed）

一条判断是**能被单独摘出去用的一句话**：摘给一个没读过这段对话的人，他能读懂，而且知道它在赌什么。

以下全部不算，返回空数组：

- 参谋补充了事实、数据、背景，但没有给出新的结论。
- 参谋把板上已有的某一条换个说法重讲一遍，或者讲得更细。
- 参谋承认「这一条我没有依据」—— 那是诚实，不是新判断。
- 一号位在陈述自己的想法，参谋表示同意，而同意的正是板上已有的那一条。
- 参谋提出了新的风险或不确定性，但明说这不改变现有判断。
- 双方只是在澄清词义、确认事实、或者在讨论下一步该查什么。

什么算：

- 参谋这一轮给出了板上没有的结论，而且说清了凭什么。
- 一号位自己下了一句判断（「这层我们不做，交给生态」），而且不是在重复板上已有的某一条。这一条的 by 是 "ceo"。
- 板上某一条被实质改写：范围收窄或扩大、结论反转、前提被替换、强度变了。这时 replaces 填那一条的编号，并且**你要能写出一个 from → to 的对子**；写不出来，就是没改，这一条不要交。

一条最多两条。宁少不凑：漏掉一条，他在对话里还看得到；多凑一条，板就变成流水账，而板的全部价值在于它短。

每一条要写齐五样：

- label：六到十四个字的短标签，说清这一条管的是什么（例如「战略边界」「当前阶段」）。
- statement：判断本身，一到两句。不要写「在上述基础上」这类回指。
- basis：凭什么这么说。只能用这一轮对话里真的出现过的依据，或者板上那一条已有的依据。**编不出来就不要交这一条。**
- boundary：它没有说什么、在哪儿到头。
- reopenIf：出现什么新事实就要把它重新打开。要具体到能被观察到，不要写「情况有变化时」。

## 二、他有没有把板上某一条认下来（confirms）

只有他**明确指着某一条说他认**，才算。「第 2 条我认可」「战略边界那条就这么定」。

以下都不算：

- 他只是顺着某一句往下说，或者说「对」「嗯」「有道理」。
- 参谋建议他确认，而他还没表态。
- 他说的是「先放着」「再看看」「我倾向于」。
- 那一条已经在下半层了（上下文里标着「已确认」）。

**他没给理由就不算确认。** 确认要连着一句「凭什么」，因为半年后重新打开这条判断查的就是那一句。support 照他这一轮的原话压缩成一句，不许你替他编、也不许你把参谋说的理由算成他的。他说了要认但没说凭什么，就返回空数组 —— 参谋下一句会把那句理由问出来。

## 三、他有没有开一个新方向（aside）

一号位这一轮如果提的是**另一个方向**，既不是板上任何一条的改写，也还没成形为一条判断 —— 比如从「要不要做」跳到「谁来做」、或者引入了一个此前没讨论过的维度 —— 把它写进 aside。

aside 要写清两件事：他关注的那一点是什么（text），以及它为什么扣着这件议题（why）。写不出 why 的就不是新方向，是闲聊，返回 null。

## 写法

- ceoChallenge 是一号位那句话的压缩，保留他的原话口吻，不超过 30 字。
- changeFrom / changeTo 各不超过 12 个字，是一对可以直接放在箭头两边的短语；replaces 为 null 时三个 change 字段都留空串。
- replaces 和 confirms 里的编号照上下文里那一条前面的编号原样写（例如 R1、D2）。他嘴里的「第 2 条」指的是列表里第二行，回写时写那一行的编号。
- 不要 markdown 记号。引号用「」。中文与英文、数字之间加空格。

只输出 JSON：

{ "formed": [], "confirms": [], "ceoChallenge": "", "aside": null }

formed 里每一条的形状：

{ "label": "", "statement": "", "basis": "", "boundary": "", "reopenIf": "", "by": "agent", "replaces": null, "changeLabel": "", "changeFrom": "", "changeTo": "" }

confirms 里每一条的形状：

{ "ref": "R2", "support": "" }
```

### 1.2 User 段

```ts
function buildUser(i: ExtractInput): string {
  const parts = [`## 议题\n\n${i.issueTitle}`];
  if (i.board.length > 0) {
    parts.push(
      [
        "## 判断板此刻的样子",
        "",
        ...i.board.map(
          (b) =>
            `${b.ref}｜${b.label ? `${b.label}：` : ""}${b.statement}（${b.confirmed ? "已确认，已经是公司口径" : "待他确认，还只是候选"}）`
        ),
      ].join("\n")
    );
  } else {
    parts.push("## 判断板此刻的样子\n\n板上还是空的。");
  }
  parts.push(`## 一号位这一轮说的\n\n${i.ceoTurn}`);
  parts.push(`## 参谋这一轮的回复\n\n${i.agentTurn}`);
  return parts.join("\n\n");
}
```

### 1.3 调用与质量门

```ts
/**
 * 判断这一轮有没有值得上板的东西。
 *
 * 用 flash 不用 pro：这是一个分类任务（有没有长出判断 + 压缩成几行），不是生成任务。
 * 每轮对话都要跑，用 pro 会让每一句闲聊都付一次高档模型的钱。
 */
export async function extractTurn(input: ExtractInput): Promise<ExtractResult> {
  // 不调 openContext，理由见文件头。`temperature` 压到 0.2：这是分类，不是写作。
  const h = new Harness({ agent: "A6", slot: "flash", temperature: 0.2 });
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUser(input) },
  ];
  const raw = (
    await h.callMessages("模型调用 · a6.turn", messages, { maxTokens: 2000 }, {}, "a6.turn")
  ).text;
  const j = parseJson<Record<string, unknown>>(raw);

  /*
   * 整形与结构自检。**不回问模型。**
   *
   * 每一处降级都 `h.note` 一笔：屏幕上「这一轮板没动」和模型判「什么都没发生」
   * 长得一模一样，台账上必须分得开 —— 否则「板怎么没动」只能靠猜。
   */
  const rawFormed = Array.isArray(j.formed) ? j.formed : [];
  const formed: FormedJudgement[] = [];
  for (const x of rawFormed) {
    const o = (x ?? {}) as Record<string, unknown>;
    const statement = str(o.statement);
    const basis = str(o.basis);
    if (!statement) continue;
    /*
     * 没有依据的判断不上板。
     *
     * 这一条比看起来重要：板上每一行下面摊开的第一句就是「凭什么」，空着的时候
     * 那一行是一句口号 —— 而口号看起来和判断一模一样，他没法分辨哪条经得起追问。
     */
    if (!basis) {
      h.note("这一条写不出依据 —— 不上板", { statement });
      continue;
    }
    // 有的模型会把「不改任何一条」写成字符串 "null" —— 那不是一个编号。
    const replacesRef = ["", "NULL", "NONE"].includes(norm(o.replaces)) ? "" : norm(o.replaces);
    const target = replacesRef ? resolveRef(input.board, o.replaces) : undefined;
    const changeFrom = str(o.changeFrom);
    const changeTo = str(o.changeTo);
    if (replacesRef && !target) {
      // 指到了板上没有的编号。当成「新长出来的一条」而不是丢掉 —— 判断本身还在。
      h.note("它说改写了板上某一条，但编号指不到", { replaces: str(o.replaces), statement });
    }
    if (target && !(changeFrom && changeTo)) {
      /*
       * 说改写了却写不出 from → to，那句「改写」就不成立 —— 这正是 prompt 里那条
       * 判据的代码形式。整条丢掉而不是降级成「新长出来的一条」：改不动的那种改写
       * 就是把板上已有的一条换个说法，而那恰恰是板会变成流水账的入口。
       */
      h.note("说改写了板上某一条，但写不出 from→to —— 按「没改」处理，这一条不上板", {
        replaces: target.ref,
        statement,
      });
      continue;
    }
    formed.push({
      label: str(o.label),
      statement,
      basis,
      boundary: str(o.boundary),
      reopenIf: str(o.reopenIf),
      by: str(o.by) === "ceo" ? "ceo" : "agent",
      replaces: target?.id ?? null,
      changeLabel: target ? str(o.changeLabel) || "判断更新" : "",
      changeFrom: target ? changeFrom : "",
      changeTo: target ? changeTo : "",
    });
  }
  if (formed.length > MAX_FORMED) {
    h.note("一轮里交了太多条判断，只取前两条", { got: formed.length });
    formed.length = MAX_FORMED;
  }

  const rawConfirms = Array.isArray(j.confirms) ? j.confirms : [];
  const confirms: Confirmation[] = [];
  for (const x of rawConfirms) {
    const o = (x ?? {}) as Record<string, unknown>;
    const target = resolveRef(input.board, o.ref);
    const support = str(o.support);
    if (!target) {
      h.note("说他确认了某一条，但编号指不到 —— 不确认", { ref: str(o.ref) });
      continue;
    }
    if (target.confirmed) {
      // 已经在下半层了。重复确认不是错，只是没有内容 —— 静静跳过。
      continue;
    }
    if (!support) {
      /*
       * 没有「凭什么」不算确认。这一行是这条链路上最要紧的一行之一：一次没有理由的
       * 确认，半年后重新打开这条判断时等于什么都没记（见 `confirmBoardJudgement`
       * 那句硬校验）。参谋的活是把那句理由问出来，不是替他补上。
       */
      h.note("他要确认但没说凭什么 —— 不确认，等参谋问出那一句", { ref: target.ref });
      continue;
    }
    confirms.push({ id: target.id, support });
  }
  if (confirms.length > MAX_CONFIRMS) {
    h.note("一轮里确认了太多条，只取前三条", { got: confirms.length });
    confirms.length = MAX_CONFIRMS;
  }

  const asideRaw = (j.aside ?? null) as { text?: unknown; why?: unknown } | null;
  const aside =
    asideRaw && str(asideRaw.text) && str(asideRaw.why)
      ? { text: str(asideRaw.text), why: str(asideRaw.why) }
      : null;

  const outcome: TurnOutcome = {
    formed,
    confirms,
    ceoChallenge: str(j.ceoChallenge),
    aside,
  };
  const violations = checkTurn(outcome);

  return {
    outcome,
    run: h.finish({
      /*
       * 板没动是 `ignored`，不是 `ok` —— 和 A1a 判噪音同一个意思：**产出为空就是
       * 正确结果**。分开之后台账才答得出「这场十四轮聊下来，板上长了两条」；
       * 混成 ok 的话，那个比例永远算不出来，而它正是这条链路唯一要看的指标。
       *
       * 只开了一支旁支也算 `ignored`：旁支不上板。
       */
      status: outcome.formed.length || outcome.confirms.length ? "ok" : "ignored",
      input: `${input.issueTitle} · 板上 ${input.board.length} 条`,
      output: outcome as unknown as Record<string, unknown>,
      violations: violations.map((v) => `${v.rule} ${v.severity} ${v.message}`),
    }),
  };
}
```

```ts
export function checkTurn(o: TurnOutcome): Violation[] {
  const v: Violation[] = [];
  if (o.ceoChallenge) v.push(...commonViolations(o.ceoChallenge, "追问"));
  for (const f of o.formed) {
    v.push(...commonViolations(f.statement, "新判断"));
    if (f.label.length < 6 || f.label.length > 14) {
      v.push({
        rule: "A6X-03",
        severity: "p1",
        message: `标签「${f.label}」是 ${f.label.length} 字，板上那一行要的是 6 到 14 字。`,
      });
    }
    if (f.changeFrom.length > 14 || f.changeTo.length > 14) {
      v.push({
        rule: "A6X-01",
        severity: "p1",
        message: `变化的两端太长（${f.changeFrom.length}/${f.changeTo.length} 字），箭头两边放不下。`,
      });
    }
    if (/^(在原判断|基于上述|如前所述|承上)/.test(f.statement)) {
      v.push({
        rule: "A6X-02",
        severity: "p1",
        message: "新判断用回指开头 —— 它要能被单独摘出来读懂。",
      });
    }
  }
  return v;
}
```

---

## 二、A2 · 收敛成一句需要公司决定的题（`src/lib/agent/a2/run.ts`）

判据只有一条：**答案是一个动作或一个取舍。** 「可以用「取决于很多因素」开头回答」的，那它不是题。

一句题三个部分，全长 ≤45 字。承接人只能从递过去的名单里挑（编一个人名出来，这条题就派不下去）。
限时要具体 —— 「尽快 / 近期 / 适时 / 择机 / 后续」都会被校验器打回。

`RESEARCHY` 那条正则挡的是研究型问句（`如何` / `怎样` / `为什么` 开头，或 `现状|趋势|分析|影响|原因` +
`如/是/怎`）—— A2-03 是这几条门里**唯一真正要守的那道**。一轮 inline 重修，maxTokens 1200。

### 2.1 System 段原文

```text
你是这家公司一号位的参谋。现在要把一场探讨收敛成**一句需要公司决定的题**。

## 什么叫「需要公司决定」

检验只有一条：**这句话的答案是一个动作或一个取舍，不是一段分析。**

- 「我们该如何提升续约率？」——不是题。它只能被继续研究，答不出来。
- 「Q4 之前是把续约的责任压到销售，还是单独设一个客户成功岗？」——是题。答案是一个选择，选完就有人要动。

如果你写出来的句子可以用「取决于很多因素」开头回答，那它不是题，重写。

## 一句题的三个部分

1. **要在什么之间做选择**（或者：要不要做某件事）。选项要具体到能被否决。
2. **约束**：什么时点之前、在什么前提下。
3. 全句一句话，不超过 45 个字。写不进一句话，说明还没收敛，那就挑当下最要紧的那一个决定来写。

## 承接人

从递给你的名单里挑一个，写名字。挑的理由是「这件事的答案要靠谁的判断」，不是「谁最闲」。名单之外的人一个都不许写。

## 限时

给一个具体日期或一个明确的时间锚（如「本月 Outcome 复盘之前」）。不要写「尽快」「近期」。

## 硬规矩

- 不要 markdown 记号。引号用「」。中英文与数字之间加空格。
- 不要写「建议持续关注」「需要综合考虑」这类等于没说的话。
- 只输出 JSON：{ "text": "……？", "suggestedDri": "姓名", "deadline": "……", "why": "为什么现在要定这个题，一句话" }
```

### 2.2 User 段与质量门

```ts
function buildUser(input: A2Input): string {
  const parts = [`## 议题\n\n${input.title}（编号 ${input.issueId}）`];

  if (input.research) {
    parts.push(
      `## 深研给出的判断\n\n${input.research.judgment.map((t) => `- ${t}`).join("\n")}`,
      `## 深研列出的反证\n\n${input.research.counters.map((t) => `- ${t}`).join("\n") || "（无）"}`,
      `## 还没答上的\n\n${input.research.unknowns.map((t) => `- ${t}`).join("\n") || "（无）"}`,
      `## 深研的建议分流\n\n${input.research.routeSuggestion || "（无）"}`
    );
  }

  const talk = input.dialogue.slice(-10);
  if (talk.length) {
    parts.push(
      `## 一号位在这件事上说过的话（最近 ${talk.length} 轮）\n\n` +
        talk.map((m) => `${m.role === "user" ? "一号位" : "参谋"}：${m.text}`).join("\n\n") +
        `\n\n**题要从他关心的那个点上长出来**，不是从报告的结论上长出来。` +
        `报告说的是这件事是什么，他关心的才是这件事要决定什么。`
    );
  } else {
    parts.push(
      `## 还没有对谈记录\n\n只能从报告收敛。这种情况下宁可把题写窄一点 —— 一个窄而真的题，` +
        `比一个宽而空的题有用。`
    );
  }

  parts.push(
    `## 可选承接人\n\n` +
      input.candidates.map((c) => `- ${c.name}（${c.role}）`).join("\n") +
      `\n\n只能从这里挑，写姓名原文。`
  );

  if (input.deadlineHint) parts.push(`## 时间锚\n\n${input.deadlineHint}`);

  return parts.join("\n\n");
}
```

```ts
export function validateQuestion(
  q: DecisionQuestion,
  candidates: string[]
): Violation[] {
  const v: Violation[] = [];
  const text = q.text ?? "";

  if (!text.trim()) {
    v.push({ rule: "A2-01", severity: "p0", message: "题是空的。" });
    return v;
  }
  if (!/[？?]$/.test(text.trim())) {
    v.push({ rule: "A2-01", severity: "p1", message: "题不是疑问句。" });
  }
  if (text.replace(/\s/g, "").length > 60) {
    v.push({ rule: "A2-02", severity: "p1", message: `题 ${text.length} 字，太长了 —— 写不进一句话说明还没收敛。` });
  }
  if (sentences(text).length > 1) {
    v.push({ rule: "A2-02", severity: "p1", message: "题超过一句。" });
  }
  /*
   * A2-03 是这个 agent 唯一真正要守的门。
   * 「如何提升 X」读起来像题，但它没法被回答 —— 一号位拿着它开完会还是原地。
   */
  if (RESEARCHY.test(text.trim())) {
    v.push({
      rule: "A2-03",
      severity: "p0",
      message: "这是一个研究问题，不是决策问题 —— 它的答案是一段分析，不是一个动作或取舍。",
    });
  }
  if (!/(还是|要不要|是否|先.*后|A 还是 B|哪一)/.test(text)) {
    v.push({
      rule: "A2-03",
      severity: "p1",
      message: "题里看不出要在什么之间做选择。",
    });
  }
  if (!q.suggestedDri?.trim()) {
    v.push({ rule: "A2-04", severity: "p0", message: "没有承接人。" });
  } else if (candidates.length && !candidates.includes(q.suggestedDri.trim())) {
    v.push({
      rule: "A2-04",
      severity: "p0",
      message: `承接人「${q.suggestedDri}」不在名单里 —— 编出来的人名会让交接包发不出去。`,
    });
  }
  if (!q.deadline?.trim()) {
    v.push({ rule: "A2-05", severity: "p0", message: "没有限时。" });
  } else if (/(尽快|近期|适时|择机|后续)/.test(q.deadline)) {
    v.push({ rule: "A2-05", severity: "p0", message: `限时写成了「${q.deadline}」—— 那不是一个时点。` });
  }

  v.push(...commonViolations(text, "定题"));
  return v;
}
```

```ts
/**
 * 定一次题。**失败就抛** —— 调用方有确定性兜底，见 store 里的 `doFrame`。
 * 在这里吞掉异常然后返回一个编出来的题，是最糟的做法。
 */
export async function runFrame(input: A2Input): Promise<{
  question: DecisionQuestion;
  why: string;
  violations: Violation[];
  attempts: number;
}> {
  const names = input.candidates.map((c) => c.name);
  const messages = [
    { role: "system", content: A2_SYSTEM },
    { role: "user", content: buildUser(input) },
  ];

  let raw = await callJson(messages, { slot: "pro", maxTokens: 1200 });
  let parsed = parseJson<{ text?: unknown; suggestedDri?: unknown; deadline?: unknown; why?: unknown }>(raw);
  let question: DecisionQuestion = {
    text: str(parsed.text),
    suggestedDri: str(parsed.suggestedDri),
    deadline: str(parsed.deadline),
  };
  let violations = validateQuestion(question, names);
  let attempts = 1;

  const bad = () => violations.filter((x) => x.severity === "p0");
  if (bad().length) {
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `上一版没通过质量门。逐条改，其余不要动：\n\n${bad()
        .map((x) => `${x.rule} ${x.message}`)
        .join("；")}\n\n只输出修正后的 JSON。`,
    });
    raw = await callJson(messages, { slot: "pro", maxTokens: 1200 });
    parsed = parseJson(raw);
    question = {
      text: str(parsed.text),
      suggestedDri: str(parsed.suggestedDri),
      deadline: str(parsed.deadline),
    };
    violations = validateQuestion(question, names);
    attempts = 2;
  }

  return { question, why: str(parsed.why), violations, attempts };
}
```

---

## 三、A10 · 写回提案（`src/lib/agent/a10/run.ts`）

**「这是提案，不是决定。」** 写「建议选择」「建议排除」，不写「决定」。

七要素一个都不能空：`choose` / `notChoose` / `why` / `keyHypothesis` / `riskAccepted` /
`commitment` / `reopenTrigger`。

`reopenTrigger` 有一条硬标准 —— **能不能挂到一个可观测的靶点上**：

- ✗ 「如果市场情况有变」
- ✓ 「如果下一个季度新签客户里有超过三家提出同样的集成需求」

判断翻版必须给出 `nextStatement` 全文。并且 user 段里钉了一句：**只有列出来的那一节里的判断可以被翻版**，
下面公司上下文里的编号是给它引证据用的，不是翻版对象。

参数：`pro`，`openContext("S03", title)`，maxTokens 5000，最多 2 轮重修（每轮独立记录并带 `repairOf`），
质量门 A10-01…A10-09。

### 3.1 System 段原文

```text
你是这家公司一号位的参谋。这件议题已经讨论完了，你要把它收成一份**写回提案**。

## 这是提案，不是决定

一号位按下确认之前，什么都没发生。所以不要用「我们已经决定」「公司确定」这种完成时。写「建议选择」「建议排除」。用完成时描述一件还没发生的事，是这块屏幕上最不该犯的错。

## 七要素，一个都不能空

- choose（选择）：具体到能被执行。不是方向，是选项。
- notChoose（排除）：**这一条最容易被省掉，也最贵。** 没有它，半年后「我们当初考虑过」这句话永远无法证伪。写清楚排除了哪个看起来同样合理的选项，以及为什么排除它。
- why（理由）：依据，不是感受。能引编号就引编号。
- keyHypothesis（关键假设）：**这个决定赌的是哪一句话成立。** 写成一句可以被证伪的陈述句 —— 半年后能拿真实数据去对。写不出可证伪的假设，说明这个决定还没想清楚。
- riskAccepted（已接受的风险）：明知会付什么代价还是决定付。写「有一定风险」等于没写。要写：会损失什么，大概多少，为什么这个代价可以接受。
- commitment（承诺）：谁、在什么时候之前、做完什么。三样缺一不可。
- reopenTrigger（重开条件）：**什么条件出现，就把这件事重新打开。**

## reopenTrigger 的硬标准

检验只有一条：**它能不能挂到一个可观测的靶点上，由系统自己去看。**

- 「如果市场情况有变」——挂不上去，等于没写。
- 「如果下一个季度新签客户里有超过三家提出同样的集成需求」——挂得上去。

写成「如果……，则重开」的形式，条件部分必须是能被观察到的事实。

## 判断翻版

如果这个决定要改公司在版的某条判断，点名是哪一条（写编号），并写出**改完之后的新陈述全文** —— 不是「把 X 改成 Y」，是直接给出那句话新的样子。判断的下一版是要被写进本体的，模糊的描述写不进去。

不需要改任何判断就返回空数组。硬凑一条翻版比不翻更糟。

## 硬规矩

- 不要 markdown 记号。引号用「」。称呼一号位用「您」。中英文与数字之间加空格。
- 只用递给你的事实，不许编数字、编人名、编日期。
- 一号位在对谈里自己说过的取舍，要按他说的写，不要替换成你认为更好的那个。
- 不写「建议持续关注」「需要综合考虑」「机会与挑战并存」这类等于没说的话。
```

### 3.2 User 段与质量门

```ts
function buildUser(input: A10Input, companyContext: string): string {
  const parts = [`## 议题\n\n${input.title}（编号 ${input.issueId}）`];

  if (input.question) {
    parts.push(
      `## 已定的题\n\n${input.question.text}\n` +
        `承接：${input.question.suggestedDri} · 限时：${input.question.deadline}`
    );
  }
  if (input.research) {
    parts.push(
      `## 深研判断\n\n${input.research.judgment.map((t) => `- ${t}`).join("\n")}`,
      `## 关键 Evidence\n\n${input.research.keyEvidence.map((t) => `- ${t}`).join("\n")}`,
      `## 反证与风险\n\n${input.research.counters.map((t) => `- ${t}`).join("\n") || "（无）"}`,
      `## 还没答上的\n\n${input.research.unknowns.map((t) => `- ${t}`).join("\n") || "（无）"}`
    );
    parts.push(
      `注意：「反证与风险」这一节是 riskAccepted 的原料 —— 已经被识别出来、` +
        `但仍然决定往前走的那几条，就是「已接受的风险」。不要另外编。`
    );
  }

  const talk = input.dialogue.slice(-12);
  if (talk.length) {
    parts.push(
      `## 对谈记录（最近 ${talk.length} 轮）\n\n` +
        talk.map((m) => `${m.role === "user" ? "一号位" : "参谋"}：${m.text}`).join("\n\n")
    );
  }

  if (input.judgments.length) {
    parts.push(
      `## 这件议题正在动摇的在版判断\n\n` +
        input.judgments.map((j) => `- ${j.id}（${j.standing}）：${j.statement}`).join("\n") +
        /*
         * 这一句是因为下面那节公司上下文才需要的：图谱里会带进来一批别的编号，
         * 模型很容易挑一条去翻版。那种翻版过不了 A10-08，更要紧的是 —— 万一过了，
         * 一号位按下确认时 `confirmClosure` 会因为找不到那条判断当场报错，而报错
         * 出现在他按确认的那一刻，看着像「系统坏了」，不像「提案写错了」。
         */
        `\n\n**只有这一节列出的判断可以被翻版。** 下面公司上下文里的编号是给你引证据用的，` +
        `不是翻版对象。`
    );
  }

  // 这一段**永远存在**。纯外部时它是 NO_COMPANY_CONTEXT，明确写着「没有」并把
  // 「不许编」「引用必须为空」写成硬约束 —— 和 A3/A4 同一个规矩，理由见
  // `prompts.ts` 里那段注释。
  parts.push(`## 公司决策上下文（GraphKnowledge S03）\n\n${companyContext}`);

  parts.push(`## 输出

只输出 JSON：

{
  "choose": "建议选择……",
  "notChoose": "建议排除……，因为……",
  "why": "……",
  "keyHypothesis": "……（一句可证伪的陈述）",
  "riskAccepted": "……",
  "commitment": "……在……之前完成……",
  "reopenTrigger": "如果……，则重开",
  "revises": [
    { "judgmentId": "01-J2", "nextStatement": "改完之后那句话的全文", "note": "为什么要改", "arms": ["挂在这条判断上的重开条件"] }
  ]
}
```

```ts
export function validateClosure(
  fields: Closure,
  revises: A10Result["revises"],
  knownJudgmentIds: string[]
): Violation[] {
  const v: Violation[] = [];
  const push = (rule: string, severity: "p0" | "p1", message: string) =>
    v.push({ rule, severity, message });

  // A10-01 七要素一个都不能空。
  for (const k of Object.keys(FIELD_LABEL) as (keyof Closure)[]) {
    if (!fields[k]?.trim()) push("A10-01", "p0", `七要素缺「${FIELD_LABEL[k]}」。`);
  }

  // A10-02 排除项不能是敷衍。它是七要素里最容易被写空的一条。
  if (fields.notChoose && !/(因为|理由|由于|考虑到|代价)/.test(fields.notChoose)) {
    push("A10-02", "p0", "「排除」没写为什么排除 —— 没有理由的排除项半年后无法证伪。");
  }
  if (/^(无|暂无|没有|不适用|N\/?A)$/i.test(fields.notChoose?.trim() ?? "")) {
    push("A10-02", "p0", "「排除」写成了「无」。任何一个决定都排除了别的东西，写不出来说明还没做取舍。");
  }

  // A10-03 关键假设必须可证伪。
  if (fields.keyHypothesis) {
    if (/[？?]$/.test(fields.keyHypothesis.trim())) {
      push("A10-03", "p0", "「关键假设」写成了问句 —— 它应该是一句可以拿数据去对的陈述。");
    }
    if (/(可能|也许|或许|大概|不排除)/.test(fields.keyHypothesis)) {
      push("A10-03", "p1", "「关键假设」里有模糊词，半年后没法拿数据去对。");
    }
  }

  // A10-04 已接受的风险不能是套话。
  if (/(有一定风险|存在风险|风险可控|总体可控)/.test(fields.riskAccepted ?? "")) {
    push("A10-04", "p0", "「已接受的风险」是套话 —— 要写会损失什么、大概多少、为什么这个代价可以接受。");
  }

  // A10-05 承诺要有人、有时点、有交付物。
  const c = fields.commitment ?? "";
  if (c) {
    if (!/(之前|前完成|截至|月|日|周|季度)/.test(c)) push("A10-05", "p0", "「承诺」没有时点。");
    if (!/(完成|交付|上线|给出|产出|提交|定稿)/.test(c)) push("A10-05", "p1", "「承诺」没有交付物。");
  }

  /*
   * A10-06 重开条件必须可观测。
   *
   * 这是七要素里唯一一条**系统要真的去用**的：确认之后它会被挂成靶点。
   * 挂不上去的重开条件不只是写得差，是让「会自动重开」这个承诺变成假的。
   */
  const t = fields.reopenTrigger ?? "";
  if (t) {
    if (!/(如果|若|一旦|当)/.test(t)) push("A10-06", "p1", "「重开条件」没写成条件句。");
    if (/(情况有变|有变化|出现问题|不及预期|形势变化|另行判断)/.test(t)) {
      push("A10-06", "p0", `「重开条件」挂不到靶点上（${t.slice(0, 20)}…）—— 系统没法自己去看的条件等于没有。`);
    }
  }

  // A10-07 提案不能用完成时。
  const all = Object.values(fields).join("\n");
  if (/(我们已经决定|公司已决定|已经确定|已敲定|决定如下)/.test(all)) {
    push("A10-07", "p0", "用完成时描述了一件还没被确认的事 —— 这是提案，一号位按下确认之前什么都没发生。");
  }

  // A10-08 翻版必须指向真实存在的判断，并给出新陈述全文。
  for (const r of revises) {
    if (!knownJudgmentIds.includes(r.judgmentId)) {
      push("A10-08", "p0", `翻版指向了不存在的判断 ${r.judgmentId}。`);
    }
    if (!r.nextStatement?.trim()) {
      push("A10-08", "p0", `${r.judgmentId} 的翻版没有给出新陈述全文。`);
    } else if (r.nextStatement.replace(/\s/g, "").length < 12) {
      push("A10-08", "p1", `${r.judgmentId} 的新陈述太短，写不进本体。`);
    }
    if (/(把|将).{0,10}(改成|换成)/.test(r.nextStatement ?? "")) {
      push("A10-08", "p0", `${r.judgmentId} 的新陈述写成了修改说明，不是那句话本身。`);
    }
  }

  for (const k of Object.keys(FIELD_LABEL) as (keyof Closure)[]) {
    v.push(...commonViolations(fields[k] ?? "", FIELD_LABEL[k]));
    if (sentences(fields[k] ?? "").length > 4) {
      push("A10-09", "p1", `「${FIELD_LABEL[k]}」超过四句；七要素每一条是一段结论，不是一节论述。`);
    }
  }

  return v;
}
```

```ts
export async function runWriteBack(input: A10Input): Promise<A10Result> {
  /*
   * 能被翻版的判断**只有调用方递进来的这几条**，不并入 `h.memberIds`。
   *
   * 图谱里的判断编号未必在本机对象库里有对应的那一条，而 `confirmClosure` 是
   * `findJudgment(id)` —— 找不到就抛。放宽这一层的后果是：提案过了质量门、一号位
   * 按下确认，然后当场报错。A10-08 存在的意义就是保证「这份提案能被写回去」。
   */
  const known = input.judgments.map((j) => j.id);

  /*
   * 上下文用 S03，锚点由 harness 按 `issue.title` 自动选 —— `q` 里不含任何指令
   * 样板（P3 的 q 上限 100 字符，前 100 字全是模板文字的话，拿去检索的就是模板）。
   *
   * `GraphKnowledgeUnavailable` 不接：图服务挂了要是被当成「图谱里没有这条议题」，
   * 每一份写回提案都会悄悄降级成纯外部，而它的产出是要改写本体的。
   */
  const h = new Harness({ agent: "A10", slot: "pro" });
  await h.openContext("S03", input.title);

  const messages: Msg[] = [
    { role: "system", content: A10_SYSTEM },
    { role: "user", content: buildUser(input, h.contextBlock) },
  ];

  const once = async (
    label: string,
    extraDetail: Record<string, unknown> = {}
  ): Promise<{ fields: Closure; revises: A10Result["revises"]; raw: string }> => {
    // 实测 3000 会在 revises 的 nextStatement 中间截断 —— 七要素本身不长，
    // 但判断翻版要给出新陈述全文，而那是要写进本体的一整句话。
    const raw = (await h.callMessages(label, messages, { maxTokens: 5000 }, extraDetail, "a10.writeback"))
      .text;
    const j = parseJson<Record<string, unknown>>(raw);
    const fields: Closure = {
      choose: str(j.choose),
      notChoose: str(j.notChoose),
      why: str(j.why),
      keyHypothesis: str(j.keyHypothesis),
      riskAccepted: str(j.riskAccepted),
      commitment: str(j.commitment),
      reopenTrigger: str(j.reopenTrigger),
    };
    const revises = Array.isArray(j.revises)
      ? j.revises.map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          return {
            judgmentId: str(o.judgmentId),
            nextStatement: str(o.nextStatement),
            note: str(o.note),
            arms: strList(o.arms),
          };
        }).filter((r) => r.judgmentId)
      : [];
    return { fields, revises, raw };
  };

  let { fields, revises, raw } = await once("模型调用 · a10.writeback");
  let violations = validateClosure(fields, revises, known);
  let attempts = 1;

  const bad = () => violations.filter((x) => x.severity === "p0");
  while (bad().length && attempts <= 2) {
    const told = bad()
      .map((x) => `${x.rule} ${x.message}`)
      .join("；");
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content: `上一版没通过质量门。逐条改，其余不要动：\n\n${told}\n\n只输出修正后的 JSON。`,
    });
    // 每一轮重修都是台账上独立的一个节点，并且记下这一轮是被哪几条挡回来的 ——
    // 「三轮才成文」和「一轮就过」在成本和质量上是两回事，合成一条就看不出来了。
    ({ fields, revises, raw } = await once(`模型调用 · a10.writeback 重修第 ${attempts} 轮`, {
      repairOf: told,
    }));
    violations = validateClosure(fields, revises, known);
    attempts += 1;
  }

  const degraded = bad().length > 0;
  const out = { ...EMPTY, ...fields };
  return {
    fields: out,
    revises,
    violations,
    attempts,
    degraded,
    run: h.finish({
      status: "ok",
      input: input.title,
      output: { ...out, revises } as unknown as Record<string, unknown>,
      violations: violations.map((v) => `${v.rule} ${v.severity} ${v.message}`),
      degraded,
    }),
  };
}
```

---

## 四、给材料起一行标题（`src/lib/data/own-issue-input.ts`）

他自己贴一份材料进来时跑的那一次小调用。**不上 harness**（没有上下文、没有质量门、没有台账），
走 `callJson`：`slot: "flash"`、`maxTokens: 200`、`temperature: 0.3`、`hint: "own.title"`，
正文只递前 4000 字。

失败就回落到 `firstSentence`（截前 40 字）—— **不编，只截**。

### 4.1 System 段原文

```text
你替一号位的参谋给一份材料起一行标题。

只输出 JSON：{"title": "……"}

标题的要求：

- 说清这份材料在讲什么。如果材料本身摆出了一个待决的问题，就写成问句 —— 但不要为了写成问句而编一个材料里没有的问题。
- 12 到 24 个字。它在屏幕上是一行大字，一行半就到顶了。
- 只用材料里有的东西。**一个材料里没有的数字、公司名、时间都不许出现。**
- 不写「关于」「浅析」「深度解读」这类套话，不加书名号，末尾不加句号。
- 引号一律用「」—— 输出是 JSON，裸的 " 会把它弄坏。
- 中英文与数字之间加空格：写「产品 1.0」，不写「产品1.0」。
```

### 4.2 调用与回落

```ts
const firstSentence = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[。！？!?\n]/);
  const head = cut > 0 ? flat.slice(0, cut) : flat;
  return head.length > 40 ? `${head.slice(0, 40)}…` : head;
};
```

```ts
/**
 * 叫一次小模型起标题。**永不抛** —— 失败返回 null，由调用处回落。
 *
 * 走 `callJson` 而不是 Harness：这一下没有质量门、不进运营台、也不该在 Run 记录里
 * 占一条（那张表是给 A 系列 agent 的产出用的）。同样的判断在 A2 那条路上已经做过一次。
 */
const titleFor = async (body: string): Promise<string | null> => {
  try {
    const raw = await callJson(
      [
        { role: "system", content: TITLE_SYSTEM },
        // 只递前 4000 字。标题看开头就够了，而他在等这一下。
        { role: "user", content: body.slice(0, 4000) },
      ],
      { slot: "flash", maxTokens: 200, temperature: 0.3, hint: "own.title" },
    );
    const title = str(parseJson<{ title?: unknown }>(raw).title);
    return title.length > 0 ? title.slice(0, 60) : null;
  } catch (e) {
    // 不静默：起标题挂了要在服务端日志里看得见，否则「标题怎么老是原文开头」查不出来。
    console.warn("[tkos:own.title] 起标题失败，回落成原文首句：", e instanceof Error ? e.message : e);
    return null;
  }
};
```
