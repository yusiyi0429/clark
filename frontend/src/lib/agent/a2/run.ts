/**
 * A2 定题：把一场探讨收敛成一句真正需要公司决定的 Decision Question。
 *
 * ## 为什么这是一个独立的 agent，而不是深研顺手输出的一个字段
 *
 * 因为它的失败模式和深研完全不同。深研写坏了是「说得不准」；定题写坏了是
 * **把一个研究问题伪装成了一个决策问题**，而这件事在屏幕上看不出来 ——
 * 「我们该如何提升客户续约率？」读起来非常像一句正经的题，但它没法被回答，
 * 只能被继续研究。一号位拿着它去开会，会开完还是原地。
 *
 * 一句合格的 Decision Question 有一个很朴素的检验：**它的答案是一个动作或一个
 * 取舍，不是一段分析。** 「先做 A 还是先做 B」「要不要在 Q4 之前把 X 停掉」
 * 是题；「X 的现状如何」不是。
 *
 * ## 为什么它同步等模型，不做成后台任务
 *
 * 定题是他按下去的一个按钮，按下去就在等一句话。这跟深研（自动跑、一两分钟）
 * 是两种交互。一句话的生成十几秒，转圈是可以接受的；把它变成轮询反而更慢，
 * 而且会出现「定完题但屏幕还没更新」的中间态。
 */
import { callJson, parseJson, str } from "@/lib/agent/json";
import { commonViolations, sentences, type Violation } from "@/lib/agent/rules";
import type { DecisionQuestion } from "@/lib/data/types";

export type A2Input = {
  issueId: string;
  title: string;
  /** 深研四节的正文，收敛的原料。 */
  research: {
    judgment: string[];
    counters: string[];
    unknowns: string[];
    routeSuggestion: string;
  } | null;
  /** 对谈里他自己说过的话。题是从这里长出来的，不是从报告里。 */
  dialogue: { role: "user" | "agent"; text: string }[];
  /** 可选的承接人。模型只能从这里挑，不许编人名。 */
  candidates: { name: string; role: string }[];
  /** 建议限时的参考锚点，例如「本月 Outcome 复盘在 8 月 28 日」。 */
  deadlineHint: string | null;
};

const A2_SYSTEM = `你是这家公司一号位的参谋。现在要把一场探讨收敛成**一句需要公司决定的题**。

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
- 只输出 JSON：{ "text": "……？", "suggestedDri": "姓名", "deadline": "……", "why": "为什么现在要定这个题，一句话" }`;

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

/** 研究式提问的特征词。命中就说明它答不出来，只能继续研究。 */
const RESEARCHY = /^(如何|怎样|怎么|为什么|为何)|(现状|情况|趋势|分析|影响|原因)[如是怎]/;

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
