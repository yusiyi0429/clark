import { Type, type Static } from "@sinclair/typebox";
import { runCandidateAgent, type CandidateThinkingLevel } from "./candidateAgentRuntime.js";
import type { Query } from "./meetingStore.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * 拆卡的「作业」（V2 设计第 8.1、19.4 节）：输入一个 Task 和本人的岗位，出 3–8 张草稿卡。
 * 这一层只管「给什么、出什么」，存草稿、排队、重试在 cardPlanner.ts；以后交给别的服务来跑，只换这一层的 CardPlanAgent 实现。
 */

export const CARD_PLAN_PROMPT = `# 角色

你是本人的伙伴。本人要把一个 Task 拆成几张卡（执行事项），每张卡按岗位派给一个执行方：claude_code 是在本人电脑上由 Claude Code 按岗位去干，交回后由 Agent 按完成标准验收；self 是本人自己做。你出 3 到 8 张草稿卡，本人挑着放进看板。

# 输入

一个 JSON：task 是 Task 的名字、完成定义和标准（criteria，编号从 1 起）；mission 是所属 Mission 的名字和验收时间点（milestones）；existing 是这个 Task 下已有的卡（标题、对第几条、状态）；roles 是本人团队里干活的岗位（id、名称、职责）；presets 是本人还没加的预设岗位（key、名称、职责）；hint 是本人说的想怎么拆，有时没有。

# 怎么拆

- 每张卡是一件能交回、能验收的事，一两天内做得完。按标准拆：一条标准可以拆成几张，几条小标准也可以合成一张。
- 已有的卡做了的不再拆；标题不能和已有的卡一样，草稿之间也不能一样。
- criterionIndex：这张卡对的是第几条标准，哪条都对不上的写 null。
- title：要交付的结果，不超过 30 字，不写「完成……」「推进……」这类空话。
- brief：交代，写清要做什么、从哪里入手、产出写成什么（文件名、格式），不超过 600 字。
- standards：可检查的完成标准，每条一句，1 到 5 条，要能凭产出、链接、截图或改动核对。
- executor：能在电脑上靠文件、代码、网页完成的给 claude_code；要本人当面沟通、拍板、线下办的给 self。
- roleId：claude_code 的卡从 roles 里挑职责最对得上的岗位，写它的 id；self 的卡写 null。
- suggestPresetKey：roles 里没有对得上的岗位、presets 里有时，写那个预设的 key，roleId 写 null；都没有就写 null。
- why：一句话说为什么这么拆，不超过 40 字。
- 有 hint 时照 hint 拆。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

const CardPlanCandidate = Type.Object({
  cards: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 60 }),
    brief: Type.String({ maxLength: 1200 }),
    standards: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 5 }),
    criterionIndex: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    executor: Type.Union([Type.Literal("claude_code"), Type.Literal("self")]),
    roleId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    suggestPresetKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    why: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }), { minItems: 3, maxItems: 8 }),
}, { additionalProperties: false });
export type TCardPlanCandidate = Static<typeof CardPlanCandidate>;

export type CardPlanInput = {
  task: { name: string; doneDefinition: string | null; criteria: { index: number; text: string }[] };
  mission: { title: string; milestones: string[] };
  existing: { title: string; criterionIndex: number | null; status: string }[];
  roles: { id: string; name: string; duties: string }[];
  presets: { key: string; name: string; duties: string }[];
  hint?: string;
};
export type CardPlanAgent = { plan(input: CardPlanInput, options: { planId: string; personId: string; signal: AbortSignal }): Promise<TCardPlanCandidate> };

const normalTitle = (title: string) => title.replace(/\s+/g, "").toLowerCase();

/**
 * 业务校验：编号在标准范围内；完成标准合起来放得进一件执行事项（500 字）；不和已有的卡、也不和彼此重名；
 * 岗位只能是给的那几个，建议的预设只能是给的那几个，两样不同时写。
 */
export function cardPlanProblem(candidate: TCardPlanCandidate, input: Pick<CardPlanInput, "task" | "existing" | "roles" | "presets">): string | null {
  const criteriaCount = input.task.criteria.length;
  const seen = new Set(input.existing.map((card) => normalTitle(card.title)));
  for (const [position, card] of candidate.cards.entries()) {
    const n = position + 1;
    if (card.criterionIndex !== null && card.criterionIndex > criteriaCount)
      return criteriaCount ? `第 ${n} 张的 criterionIndex 只能是 1 到 ${criteriaCount} 或 null` : `这个 Task 没有标准，第 ${n} 张的 criterionIndex 写 null`;
    if (card.standards.map((line) => line.trim()).filter(Boolean).join("\n").length > 500) return `第 ${n} 张的完成标准合起来超过 500 字，写短一些`;
    if (!card.standards.some((line) => line.trim())) return `第 ${n} 张至少要有一条完成标准`;
    if (seen.has(normalTitle(card.title))) return `第 ${n} 张「${card.title}」和已有的卡或前面的草稿重名`;
    seen.add(normalTitle(card.title));
    if (card.roleId !== null && !input.roles.some((role) => role.id === card.roleId)) return `第 ${n} 张的 roleId 只能是 roles 里的 id 或 null`;
    if (card.suggestPresetKey !== null && !input.presets.some((preset) => preset.key === card.suggestPresetKey))
      return `第 ${n} 张的 suggestPresetKey 只能是 presets 里的 key 或 null`;
    if (card.roleId !== null && card.suggestPresetKey !== null) return `第 ${n} 张已经配了岗位，suggestPresetKey 写 null`;
  }
  return null;
}

const THINKING_LEVELS = new Set<CandidateThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type BoardModelOptions = { query: Query; baseUrl: string; apiKey: string; modelId: string; thinking?: string };
export const boardModel = (options: BoardModelOptions) => {
  const level = options.thinking?.trim().toLowerCase() as CandidateThinkingLevel | undefined;
  return { query: options.query, baseUrl: options.baseUrl, apiKey: options.apiKey, modelId: options.modelId,
    thinkingLevel: level && THINKING_LEVELS.has(level) ? level : "medium" as const };
};

export function createCardPlanAgent(options: BoardModelOptions): CardPlanAgent {
  return {
    async plan(input, { planId, personId, signal }) {
      return (await runCandidateAgent({ ...boardModel(options), kind: "card_plan", objectRef: { type: "card_plan", id: planId }, personId, input,
        prompt: CARD_PLAN_PROMPT, schema: CardPlanCandidate, signal, maxModelCalls: 4, validate: (candidate) => cardPlanProblem(candidate, input) })).candidate;
    },
  };
}
