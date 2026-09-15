/**
 * 跑一次 A5：把深研报告读成几条**待一号位确认**的判断。
 *
 * 两步：出判断（校验 + 带违规重修）→ 交给调用方推上判断板。
 *
 * ## 为什么它是真的一次生成，而 J₀ 是投影
 *
 * `types.ts` 的 `InitialJudgment` 上写着一条规矩：J₀ 从深研报告**算**出来，不许再叫
 * 一次模型 —— 因为 J₀ 的内容全部已经在报告里，再叫一次只会得到一份换了措辞的同源
 * 结论，而两份措辞不同的同源结论摆在一号位面前，他会以为那是两个独立判断。
 *
 * 这一条在这里仍然成立，所以 A5 **不产出「换了措辞的报告结论」**：它产出的是报告里
 * 没有的四样东西 —— 短标签、判断依据、当前边界、重开条件。报告是四节并列的研究结果，
 * 判断是几句「他点头之后就可以对外说的话」，每一句都要能被单独摘出去用。收成那个形状
 * 是一次真的工作，不是换措辞。
 *
 * 所以它也**替换掉**了原来那条把 `doc.judgment[]` 直接推上板的投影（见 `store.ts`
 * 的 `ensureDeepResearch`）。两条一起留着，板上就会有一批只有正文的判断和一批带
 * 依据边界的判断，而它们看起来都是「参谋给的」。
 *
 * ## 为什么不开图谱上下文
 *
 * 它读的报告在装配时已经带过公司上下文（S03 那一整套）。为同一批材料再打一次图服务，
 * 多花一次钱，还多一条失败路径：图挂了连判断都生不出来 —— 而报告已经在库里躺着。
 * 需要的公司材料由调用方从对象库里递进来（在版判断、板上已有的判断）。
 * 台账上这次运行的 `contextMode` 因此是空串，和 A6 一样，那是诚实的空。
 *
 * ## 为什么没有独立第二源
 *
 * A4 那边第二个模型的价值在分歧：两个家族都推不翻的判断更硬。这里不需要 ——
 * 报告已经被冲过一轮，而判断这一层的裁判是人：他在对谈里或者会上逐条表态。
 * 再加一个模型来评判断，只会在他之前先给出一个看起来权威的意见。
 */
import { parseJson, str, toStatements } from "@/lib/agent/json";
import { Harness } from "@/lib/agent/harness";
import { blocking, fmt, summarize, type Violation } from "@/lib/agent/rules";
import type { AgentRunRecord, DraftJudgement } from "@/lib/data/types";

import { A5_SYSTEM, buildA5Repair, buildA5User, type A5Input } from "./prompt";
import { validateJudgements } from "./validate";

const MAX_REPAIR = 2;

/**
 * 输出上限。**4000 不够，实跑时被截断过一次**（2026-08-19，ISS-103：深研报告已经落库，
 * 这一轮报「模型输出被 max_tokens(4000) 截断」就地失败，于是那份报告再也读不成判断）。
 *
 * 算一下就知道 4000 为什么不够：五条判断，每条五样东西（标签、正文 40 字以上、依据、
 * 边界、重开条件），而这个槽位是**推理模型 —— 思考 token 也算在这个额度里**（同一天
 * A3 一轮花掉 5101 个 reasoningTokens）。1200 字左右的正文本身放得下，跟思考挤在一起
 * 就放不下了。
 *
 * 比 A4 那份报告的 12000 小：这一步的产出是收窄，不是再写一篇。两个调用点共用这一个
 * 常量 —— 重修那一轮的额度更不该比第一轮小，而两处各写一个数字必然漂。
 */
const MAX_TOKENS = 8000;

export type A5Result = {
  judgements: DraftJudgement[];
  violations: Violation[];
  attempts: number;
  degraded: boolean;
  /** 这次运行的可复现记录。由调用方落库（`agentRunPut`）。 */
  run: AgentRunRecord;
};

export async function runJudgements(input: A5Input): Promise<A5Result> {
  /*
   * 认知段（prompt 第 ③ 段）**整段不存在**，也不去 `cognitiveFor` 取。
   *
   * 这不是还没装：`prompts/cognitive/` 下故意没有 `a5.*.md`，理由写在 `prompt.ts`
   * 文件头 —— 这一步不归方法部门管。取一次拿到 `empty` 反而会在台账上留下一条
   * 「这一轮没带标准」的记录，而它其实没有标准可带。
   */
  const h = new Harness({ agent: "A5", slot: "pro" });
  h.note("不开图谱上下文", {
    why: "读的深研报告装配时已经带过公司上下文，公司材料由调用方递入",
    docJudgments: input.doc.judgment.length,
    standingJudgments: input.judgments.length,
    existingOnBoard: input.existing.length,
  });

  const messages = [
    { role: "system", content: A5_SYSTEM },
    { role: "user", content: buildA5User(input) },
  ];
  const callDetail = { promptKey: "a5.judgements", cognitiveSource: "none" };

  let raw = (
    await h.callMessages("模型调用 · a5.judgements", messages, { maxTokens: MAX_TOKENS }, callDetail, "a5.judgements")
  ).text;
  let items = shape(raw);
  let violations = validateJudgements(items);
  let attempts = 1;

  // 第一轮的违规在这里就留下来 —— 下面那个 while 会把 `violations` 覆盖掉，
  // 而绝大多数违规是第一轮犯、第二轮改对的。理由同 A4。
  const firstRoundViolations = violations.map(fmt);

  while (blocking(violations).length && attempts <= MAX_REPAIR) {
    messages.push({ role: "assistant", content: raw });
    messages.push({ role: "user", content: buildA5Repair(summarize(blocking(violations))) });
    raw = (
      await h.callMessages(
        `模型调用 · a5.judgements 重修第 ${attempts} 轮`,
        messages,
        { maxTokens: MAX_TOKENS },
        { ...callDetail, repairOf: summarize(blocking(violations)) },
        "a5.judgements"
      )
    ).text;
    items = shape(raw);
    violations = validateJudgements(items);
    attempts += 1;
  }

  const degraded = blocking(violations).length > 0;
  return {
    judgements: items,
    violations,
    attempts,
    degraded,
    run: h.finish({
      status: "ok",
      input: `${input.issueId} · ${input.title}`,
      output: { judgements: items } as unknown as Record<string, unknown>,
      violations: violations.map(fmt),
      // 一轮就过时不落这个字段：空数组和「没记」在统计时分不开。
      ...(attempts > 1 ? { firstRoundViolations } : {}),
      degraded,
    }),
  };
}

type Raw = { judgements?: unknown; judgments?: unknown };

/**
 * 整形。
 *
 * `judgements` 和 `judgments` 两个拼法都收：产品里这两种拼法确实并存（判断板那一族
 * 是 `Judgement`，本体里的在版判断是 `Judgment`），模型跟着输入里的词摇摆是常态。
 * 为一个拼字母的问题让整次运行产出零条判断，换不来任何诚实。
 */
function shape(raw: string): DraftJudgement[] {
  const j = parseJson<Raw>(raw);
  const list = Array.isArray(j.judgements) ? j.judgements : Array.isArray(j.judgments) ? j.judgments : [];
  const out: DraftJudgement[] = [];
  for (const x of list) {
    const o = (x ?? {}) as Record<string, unknown>;
    // 溯源的整形借 `toStatements` 走同一条路：kind 的兜底规则只该有一份。
    const [s] = toStatements([{ text: str(o.statement), traces: o.traces }]);
    if (!s) continue;
    out.push({
      label: str(o.label),
      statement: s.text,
      basis: str(o.basis),
      boundary: str(o.boundary),
      reopenIf: str(o.reopenIf),
      traces: s.traces ?? [],
    });
  }
  return out;
}
