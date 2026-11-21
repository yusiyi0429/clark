import { Type, type Static } from "@sinclair/typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TCardCriterionVerdict, TLocalHandbackCriterion } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import { boardModel, type BoardModelOptions } from "./cardPlanAgent.js";
import { reviewProblem, type TReviewCandidate } from "./deliverableReview.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * Agent 验收的「作业」（V2 设计第 7.2–7.3、19.4 节）：输入一次交回和三样口径（约定、卡所属岗位的验收口径、验收员岗位的验收口径），出逐条结论。
 * 这一层只管「给什么、出什么」，排队、落库、推翻在 cardAcceptance.ts；以后交给别的服务来跑，只换这一层的 CardAcceptanceAgent 实现。
 */

export const CARD_ACCEPTANCE_PROMPT = `# 角色

你是本人团队里的验收员。执行方（本人电脑上的 Claude Code）做完一张卡（执行事项）交回来了，你按这张卡的完成标准逐条验收。只按完成标准判，不加新要求。

# 输入

一个 JSON：card 是卡的标题、交代和完成标准（criteria，编号从 1 起，是交回那一刻的快照）；taskCriterion 是这张卡对的那条 Task 标准的原文，有时没有；
claims 是执行方逐条写的（index、它自己判的 met/partial/unmet、证据）；summary 是它的一句总结；outputs 是它交出的产出和证据（名字、种类、文字、链接），截图随消息附上；
unreadable 是读不到的产出和原因；previous 是上一次没过时的逐条结果，第一次交回没有。

还有三样口径：
- agreement：这条 Task 标准的约定——用什么证明（proof）、这次不包括什么（exclusions）；没有约定时为 null。
- role：这张卡所用技能的名称和验收口径（acceptanceMd）；卡没配技能时为 null。
- reviewer：你自己（验收员技能）的做法（practiceMd）和验收口径（acceptanceMd）。

# 怎么判

- 照三样口径判这几条完成标准：约定写了用什么证明的，按它要证据；约定里「这次不包括」的，不能当作没达到的理由；技能的验收口径和你自己的口径用来判「做到什么程度算达到」。三样口径都不增加新的标准。
- 每一条三档：met 达到，partial 部分达到，unmet 未达到。部分达到按没过算，所以拿不准就判 partial，写清差什么。
- 执行方自己说的不算证据：要有产出、链接、截图或改动对得上。claims 里写了「已完成」但 outputs 里找不到对应的东西，判 unmet。
- 读不到的产出不能当证据；某一条要靠它时，fix 写「这份产出打不开，请重新交」。
- reason：一句话说判定的理由，不超过 60 字。
- evidence：引用的证据位置，写哪份产出、哪一段，或哪个链接、哪张截图；met 必须写，其余没有就写 null。
- fix：具体怎么补，补什么、做到什么程度；partial 和 unmet 必须写，met 写 null。
- 有 previous 时，看上次没过的几条这次补上没有。

# 报告

- headline：一句结论，不超过 30 字。都达到写「3 条都达到了」这样的话；没都达到点出最要紧的缺口。
- criteria：每一条一项，index 和输入的编号一一对应，不多不少。
- beyondScope：标准以外你觉得值得做的改进，最多 3 条，每条一句；没有就写空数组。它们不算进没达到，也不能当作判 partial、unmet 的理由。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

const AcceptanceCandidate = Type.Object({
  headline: Type.String({ minLength: 1, maxLength: 60 }),
  criteria: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    verdict: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]),
    reason: Type.String({ minLength: 1, maxLength: 120 }),
    evidence: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    fix: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
  }, { additionalProperties: false }), { minItems: 1 }),
  beyondScope: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 3 }),
}, { additionalProperties: false });
export type TAcceptanceCandidate = Static<typeof AcceptanceCandidate>;

export type AcceptanceInput = {
  card: { title: string; brief: string | null; criteria: { index: number; text: string }[] };
  taskCriterion: { index: number; text: string } | null;
  claims: TLocalHandbackCriterion[];
  summary: string | null;
  outputs: { name: string; kind: "artifact" | "evidence"; text: string | null; url: string | null }[];
  unreadable: { name: string; note: string }[];
  previous?: { index: number; text: string; verdict: TCardCriterionVerdict; reason: string; fix: string | null }[];
  /** 约定（V1）：卡对的那条 Task 标准用什么证明、这次不包括什么；两样都没有为 null。 */
  agreement: { proof: string | null; exclusions: string[] } | null;
  role: { name: string; acceptanceMd: string } | null;
  reviewer: { name: string; practiceMd: string; acceptanceMd: string } | null;
};
export type CardAcceptanceAgent = {
  accept(input: AcceptanceInput, options: { handbackId: string; personId: string; images: ImageContent[]; signal: AbortSignal }): Promise<TAcceptanceCandidate>;
};

/** 业务校验照参考评审：编号正好 1..n 各一次；met 要写依据，partial / unmet 要写怎么补。 */
export const acceptanceProblem = (candidate: TAcceptanceCandidate, total: number) =>
  reviewProblem({ headline: candidate.headline, summary: candidate.headline, gain: null, criteria: candidate.criteria } satisfies TReviewCandidate, total);

export function createCardAcceptanceAgent(options: BoardModelOptions): CardAcceptanceAgent {
  return {
    async accept(input, { handbackId, personId, images, signal }) {
      return (await runCandidateAgent({ ...boardModel(options), kind: "card_acceptance", objectRef: { type: "card_handback", id: handbackId }, personId, input,
        prompt: CARD_ACCEPTANCE_PROMPT, schema: AcceptanceCandidate, images, signal, maxModelCalls: 4,
        validate: (candidate) => acceptanceProblem(candidate, input.card.criteria.length) })).candidate;
    },
  };
}
