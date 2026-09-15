/**
 * A10 写回提案：把一场已经讨论完的议题，收成一份可以按下确认的 Closure 草案。
 *
 * ## 七要素为什么是七个，不是三个
 *
 * 一份决定如果只写「选了 A」，半年后没有人能判断它当时对不对 —— 因为不知道
 * 当时排除了什么、赌的是什么、认了多大的风险。七要素每一条都在回答一个
 * 「半年后回头看」的问题：
 *
 *   choose        选了什么
 *   notChoose     **排除了什么** —— 这一条最常被省掉，也最贵。没有它，
 *                 「我们当初考虑过」永远无法证伪
 *   why           为什么（依据，不是感受）
 *   keyHypothesis 这个决定赌的是哪一句话成立
 *   riskAccepted  明知会付什么代价还是决定付
 *   commitment    谁在什么时候之前做完什么
 *   reopenTrigger 什么条件出现就把这件事重新打开
 *
 * ## 这个 agent 的产物**不是**决定
 *
 * 它是提案。一号位确认之前，本体里什么都不会变。这条边界写进 prompt 是必要的：
 * 模型的默认语气是「我们已经决定」，而屏幕上这份东西还没被按下确认 ——
 * 用完成时写一件没发生的事，是这个产品最容易犯的信任错误。
 *
 * ## reopenTrigger 必须可观测
 *
 * 「如果情况有变」不是重开条件。重开条件的检验是：**能不能挂到一个靶点上，
 * 由系统自己去看。** 挂不上去的重开条件等于没有 —— 半年后没人会想起来查它。
 *
 * ## 为什么这条链路上 harness
 *
 * 它是三条 agent 链路之外**最需要留痕**的一条：产出一旦被一号位按下确认，就会
 * 真的改写本体（判断 +1 版、陈述换新、重开条件挂成靶点）。半年后回头问「这条
 * 判断为什么变成了这句话」，答案必须能一直追到当时用了哪份公司上下文、哪个模型、
 * 重修了几轮 —— 那正好是 Run 台账记的东西。
 *
 * 上下文用 S03（和 A4 同一个配方、同一种锚点）。A10 一件议题只跑一次，装配那点
 * 开销换的是「写回依据来自公司现有的判断链」，不是模型的常识。
 */
import { Harness } from "@/lib/agent/harness";
import { parseJson, str, strList, type Msg } from "@/lib/agent/json";
import { commonViolations, sentences, type Violation } from "@/lib/agent/rules";
import type { AgentRunRecord, Closure } from "@/lib/data/types";

export type A10Input = {
  issueId: string;
  title: string;
  /** 深研四节。写回的依据来自这里。 */
  research: {
    judgment: string[];
    keyEvidence: string[];
    counters: string[];
    unknowns: string[];
    routeSuggestion: string;
  } | null;
  /** 定下来的题。有了它，choose / notChoose 才有对照。 */
  question: { text: string; suggestedDri: string; deadline: string } | null;
  /** 对谈。一号位自己说过的取舍要被写进去，不能被模型替换成它认为更好的。 */
  dialogue: { role: "user" | "agent"; text: string }[];
  /** 这件议题正动摇的在版判断。写回要点名改哪一条、改成什么。 */
  judgments: { id: string; statement: string; standing: string }[];
};

export type A10Result = {
  fields: Closure;
  revises: { judgmentId: string; nextStatement: string; note: string; arms: string[] }[];
  violations: Violation[];
  attempts: number;
  degraded: boolean;
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
};

const A10_SYSTEM = `你是这家公司一号位的参谋。这件议题已经讨论完了，你要把它收成一份**写回提案**。

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
- 不写「建议持续关注」「需要综合考虑」「机会与挑战并存」这类等于没说的话。`;

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

不需要翻版任何判断就写 "revises": []。`);

  return parts.join("\n\n");
}

const EMPTY: Closure = {
  choose: "",
  notChoose: "",
  why: "",
  keyHypothesis: "",
  riskAccepted: "",
  commitment: "",
  reopenTrigger: "",
};

const FIELD_LABEL: Record<keyof Closure, string> = {
  choose: "选择",
  notChoose: "排除",
  why: "理由",
  keyHypothesis: "关键假设",
  riskAccepted: "已接受的风险",
  commitment: "承诺",
  reopenTrigger: "重开条件",
};

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
   * 上下文用 S03，锚点走判断号这条路，同 A3 预研与 A4 深研：图谱里没有前端这些议题
   * 对象，按 `issue.title` 检索 `ISS-*` 一次都命中不了；而这些判断号在图里是真实存在的。
   *
   * 递进去的就是上面那一串 —— 这条链路要翻版的判断和它该拿来当锚点的判断本来就是同一
   * 批，写成两份的话，某一天改了其中一份，提案会去改一条上下文里根本没有的判断。为空
   * 照旧走检索。`q` 里不含任何指令样板（P3 的 q 上限 100 字符，前 100 字全是模板文字的
   * 话，拿去检索的就是模板）。
   *
   * `GraphKnowledgeUnavailable` 不接：图服务挂了要是被当成「图谱里没有这条议题」，
   * 每一份写回提案都会悄悄降级成纯外部，而它的产出是要改写本体的。
   */
  const h = new Harness({ agent: "A10", slot: "pro" });
  await h.openContext("S03", input.title, { judgmentCodes: known });

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
