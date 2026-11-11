import { Type, type Static } from "@sinclair/typebox";
import { runCandidateAgent, type CandidateThinkingLevel } from "./candidateAgentRuntime.js";
import type { Query } from "./meetingStore.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * 复盘的统一评审员（设计第三版第 6 节）：同一套口径、同一个模型、不带伙伴性格。只评机械判不了的条目（monthReview.ts 先判过）。
 */

export const MONTH_REVIEW_PROMPT = `# 角色
你是月底复盘的评审员。按同一套口径，对一件 Task 的每条验收标准，判断这个月做到了什么程度。你不代表任何人，不鼓励、不批评。

# 输入
JSON：月份、Mission 名、Task 名、要评的几条标准（index、text），以及读得到的材料：
- deliverable：最新一版交付物（第几版、交没交、说明、材料名字和摘录、交付物评审逐条的结论），没有为 null；
- cards：这件 Task 下的卡（标题、状态、对第几条、验收过没过）；
- outputs：子会话的产出（标题、摘录）；
- events：本体里这件 Task 的事件（时间、内容）。

# 三档
- met 达到：标准写的内容做到了。评的是写下来的那条标准，不是「做得好不好」；做到了就是达到，不因为还能更好而降档。
- partial 部分达到：做了，但没做到标准写的程度；或者做到了还没人验收。
- unmet 未达到：没有结果，只有过程，或者什么都没有。

# 规矩
1. 只依据材料。材料里看不出做到了，不给 met。
2. 月底前做到就算，晚于计划的时间点不降档。
3. 每条写 basis：一句话说依据，点到具体材料（如「第 2 版交付物里有安装包和安装记录」），不超过 60 字，不写建议。
4. 标准本身写得含糊、判不了的，照样给一档，同时 vague 记 true。
5. deliverable 为 true 表示这条的依据是最新一版交付物（会把它的材料挂到这条上）。
6. 每条标准都要评，index 和输入对上，不多不少。通过 submit_candidate 提交。

${ADDRESS_STYLE}`;

export const MonthReviewCandidate = Type.Object({
  criteria: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    rating: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
    basis: Type.String({ minLength: 1, maxLength: 300 }),
    vague: Type.Boolean(),
    deliverable: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type TMonthReviewCandidate = Static<typeof MonthReviewCandidate>;

export type MonthReviewAgentInput = {
  period: string;
  missionTitle: string;
  taskName: string;
  criteria: { index: number; text: string }[];
  deliverable: { number: number; delivered: boolean; statement: string | null; review: unknown[] | null;
    items: { kind: string; name: string; url: string | null; text: string | null }[] } | null;
  cards: { title: string; status: string; criterionIndex: number | null; accepted: boolean }[];
  outputs: { title: string; text: string | null }[];
  events: { at: string; text: string }[];
};

export type MonthReviewAgent = { rate(input: MonthReviewAgentInput, ctx: { taskId: string; personId: string }): Promise<TMonthReviewCandidate> };

const THINKING_LEVELS = new Set<CandidateThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** 评的条目和输入对不上时让模型重交。 */
export function monthReviewProblem(candidate: TMonthReviewCandidate, indexes: number[]): string | null {
  const got = candidate.criteria.map((item) => item.index).sort((a, b) => a - b);
  const want = [...indexes].sort((a, b) => a - b);
  return got.length === want.length && got.every((index, i) => index === want[i]) ? null : `要评的是第 ${want.join("、")} 条，每条一个结果`;
}

export function createMonthReviewAgent(options: { query: Query; baseUrl: string; apiKey: string; modelId: string; thinking?: string }): MonthReviewAgent {
  const level = options.thinking?.trim().toLowerCase() as CandidateThinkingLevel | undefined;
  return {
    async rate(input, { taskId, personId }) {
      const result = await runCandidateAgent({ query: options.query, baseUrl: options.baseUrl, apiKey: options.apiKey, modelId: options.modelId,
        thinkingLevel: level && THINKING_LEVELS.has(level) ? level : "medium", kind: "month_review", objectRef: { type: "plan_task", id: taskId }, personId,
        input, prompt: MONTH_REVIEW_PROMPT, schema: MonthReviewCandidate, maxModelCalls: 3,
        validate: (candidate) => monthReviewProblem(candidate, input.criteria.map((item) => item.index)) });
      return result.candidate;
    },
  };
}
