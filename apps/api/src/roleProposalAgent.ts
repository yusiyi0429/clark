import { Type, type Static } from "@sinclair/typebox";
import type { TCardCriterionVerdict, TCardHandbackOutcome, TRoleKind } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import { boardModel, type BoardModelOptions } from "./cardPlanAgent.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * 提岗位修改的「作业」（V2 设计第 19.4 节）：本人推翻验收，或同一张卡第二次没过时，伙伴提一条「这个技能要改什么」。轻模型。
 * 这一层只管「给什么、出什么」，排队、落库、采纳在 roleProposals.ts、roles.ts；以后交给别的服务来跑，只换这一层的 RoleProposalAgent 实现。
 */

export const ROLE_PROPOSAL_PROMPT = `# 角色

你是本人的伙伴。本人的技能用 Markdown 写着职责、做法、验收口径，技能会成长：一张卡的验收被本人推翻了，或者同一张卡第二次验收还没过，你看这次哪里出了问题，提一条「这个技能要改什么」。本人点采纳才写进去。

# 输入

一个 JSON：sourceKind 是 overrule（本人推翻了 Agent 的验收结论）或 second_fail（同一张卡第二次没过）；reason 是本人推翻的理由（只有 overrule 有）；
card 是卡的标题、交代、完成标准；acceptance 是这次验收的结论（outcome：Agent 判的 pass 或 fail）和逐条结果；roles 是可以改的技能（id、名称、种类、职责、做法、验收口径）。

# 怎么提

- 只提一条：改哪个技能（roleId，必须是 roles 里的）、改哪一段（field：dutiesMd 职责、practiceMd 做法、acceptanceMd 验收口径）、改后的整段（proposedText）、为什么（why）。
- overrule：Agent 判通过、本人推翻的，多半是验收口径太松；Agent 判没过、本人算通过的，多半是验收口径太严或没对上本人的意思。改验收口径。
- second_fail：两次都没过，多半是做法不对或职责没写清，改干活技能的做法或职责。
- proposedText 是改后的整段 Markdown：保留原来还对的部分，只加或改这次学到的一两句，不重写整段。
- why：这次卡上发生了什么、改了以后下次会怎样，不超过 80 字。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

const RoleProposalCandidate = Type.Object({
  roleId: Type.String({ minLength: 1 }),
  field: Type.Union([Type.Literal("dutiesMd"), Type.Literal("practiceMd"), Type.Literal("acceptanceMd")]),
  proposedText: Type.String({ minLength: 1, maxLength: 8000 }),
  why: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type TRoleProposalCandidate = Static<typeof RoleProposalCandidate>;

export type RoleProposalInput = {
  sourceKind: "overrule" | "second_fail";
  reason: string | null;
  card: { title: string; brief: string | null; standards: string[] };
  acceptance: { outcome: TCardHandbackOutcome | null; criteria: { index: number; text: string; verdict: TCardCriterionVerdict; reason: string; fix: string | null }[] };
  roles: { id: string; name: string; kind: TRoleKind; dutiesMd: string; practiceMd: string; acceptanceMd: string }[];
};
export type RoleProposalAgent = {
  propose(input: RoleProposalInput, options: { proposalId: string; personId: string; signal: AbortSignal }): Promise<TRoleProposalCandidate>;
};

/** 业务校验：岗位要是给的那几个，改后的文本要和现在不一样。 */
export function roleProposalProblem(candidate: TRoleProposalCandidate, input: RoleProposalInput): string | null {
  const role = input.roles.find((item) => item.id === candidate.roleId);
  if (!role) return "roleId 只能是 roles 里的 id";
  if (role[candidate.field].trim() === candidate.proposedText.trim()) return "proposedText 和现在的一样，要写改后的整段";
  return null;
}

export function createRoleProposalAgent(options: BoardModelOptions): RoleProposalAgent {
  return {
    async propose(input, { proposalId, personId, signal }) {
      return (await runCandidateAgent({ ...boardModel(options), kind: "role_proposal", objectRef: { type: "role_proposal", id: proposalId }, personId, input,
        prompt: ROLE_PROPOSAL_PROMPT, schema: RoleProposalCandidate, signal, maxModelCalls: 3, validate: (candidate) => roleProposalProblem(candidate, input) })).candidate;
    },
  };
}
