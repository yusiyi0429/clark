import { Type, type Static } from "@sinclair/typebox";
import type { Pool } from "pg";
import type { AppEnv } from "./app.js";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/**
 * ③ 信息收集的起草（轻模型）：把发起人的一句话判断成两个场景之一，起草标题、收件人、截止和是否每周固定。
 * 只出候选；表里收哪几栏按场景固定（collections.ts），写库和发出都由发起人在预览里确认。
 */
export type CollectionDraftInput = {
  prompt: string;
  /** 现在（上海时间），例如「2026-10-19 周一 10:30」。 */
  now: string;
  people: { personId: string; displayName: string }[];
  initiator: string;
  /** 重写时的上一版。 */
  current: { scenario: string; title: string; recipientIds: string[]; deadline: string; weekly: boolean } | null;
};

const DraftCandidate = Type.Object({
  scenario: Type.Union([Type.Literal("expense"), Type.Literal("method_progress"), Type.Literal("unsupported")]),
  title: Type.String({ minLength: 1, maxLength: 30 }),
  recipientIds: Type.Array(Type.String(), { maxItems: 30 }),
  /** 上海时间 YYYY-MM-DD HH:mm；原话没说截止就交 null。 */
  deadline: Type.Union([Type.String({ maxLength: 20 }), Type.Null()]),
  weekly: Type.Boolean(),
}, { additionalProperties: false });
export type CollectionDraftCandidate = Static<typeof DraftCandidate>;

export type CollectionAgent = {
  draft(input: CollectionDraftInput, ref: { collectionId: string; personId: string }, signal: AbortSignal): Promise<CollectionDraftCandidate>;
};

export const COLLECTION_DRAFT_PROMPT = `你替发起人把一句话起草成一次信息收集，只调用 submit_candidate 提交 {scenario, title, recipientIds, deadline, weekly}。
- scenario：只有两类。expense = 财务收每个人推进项目的开销（花了多少钱、用在哪）；method_progress = 方法部门收每个人这周的进展（共填一张进展表）。两类都不是（例如收反馈、收材料、给每个人生成不同内容）就交 unsupported，其余字段照常填。
- title：表名，不超过 16 个字，例如「灯塔项目每周开销」「方法部周进展」。不写日期。
- recipientIds：从 people 里挑原话点名的人；原话说「全员」「大家」「所有人」就交 people 里的全部；对不上就交空数组，由发起人自己选。只填 people 里的 personId。
- deadline：原话说了截止就换成上海时间 YYYY-MM-DD HH:mm（以 now 为准推算「周五」「明天下班前」这类说法，下班按 18:00）；没说就交 null。
- weekly：原话有「每周」「每个礼拜」「固定」一类说法就交 true，否则 false。
- 有 current 时是在上一版上按新的原话改：原话没提到的保持上一版。

${ADDRESS_STYLE}`;

export function createCollectionAgent(pool: Pool, env: AppEnv): CollectionAgent {
  return {
    async draft(input, ref, signal) {
      return (await runCandidateAgent({
        query: pool.query.bind(pool), kind: "collection-draft", objectRef: { type: "collection", id: ref.collectionId }, personId: ref.personId,
        input, prompt: COLLECTION_DRAFT_PROMPT, schema: DraftCandidate, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.lightModel, modelSlot: "light", signal,
      })).candidate;
    },
  };
}
