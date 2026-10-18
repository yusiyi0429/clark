import { Type, type Static } from "@sinclair/typebox";
import type { Pool } from "pg";
import { runCandidateAgent } from "../candidateAgentRuntime.js";
import type { AppEnv } from "../app.js";
import { ADDRESS_STYLE } from "../promptStyle.js";

/**
 * 送达通道里的三处轻量模型调用（⑨ 传话）：起草请求并自查歧义、提问前查有没有人答过并整理问题、替发起人起草回答。
 * 都只读、只产出候选；写库和发出都由本人在界面上确认后走 Action。
 */
export type DraftInput = {
  prompt: string;
  clarifications: { question: string; answer: string | null }[];
  /** 当前草稿（重写时给出）。 */
  current: { title: string; body: string } | null;
  people: { personId: string; displayName: string }[];
  initiator: string;
};
export type LookupInput = {
  title: string;
  body: string;
  answered: { questionId: string; question: string; answer: string }[];
  question: string;
  initiator: string;
};
export type AnswerInput = { title: string; body: string; question: string; asker: string; answered: { question: string; answer: string }[] };

const DraftCandidate = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 60 }),
  body: Type.String({ minLength: 1, maxLength: 4000 }),
  recipientIds: Type.Array(Type.String(), { maxItems: 20 }),
  questions: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 3 }),
}, { additionalProperties: false });
const LookupCandidate = Type.Object({
  /** none：说明和问答里都没有答案。 */
  match: Type.Union([Type.Literal("none"), Type.Literal("body"), Type.Literal("question")]),
  /** match=body 时：说明里能直接回答这个问题的原文片段（逐字摘录）。 */
  quote: Type.Union([Type.String(), Type.Null()]),
  /** match=question 时：已回答的那条问答的 questionId。 */
  questionId: Type.Union([Type.String(), Type.Null()]),
  /** 整理好的问题：带上是哪张表、哪一栏、哪一步。 */
  question: Type.String({ minLength: 1, maxLength: 300 }),
}, { additionalProperties: false });
const AnswerCandidate = Type.Object({ answer: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });

export type RequestDraft = Static<typeof DraftCandidate>;
export type RequestLookup = Static<typeof LookupCandidate>;

export type RequestAgent = {
  draft(input: DraftInput, ref: { requestId: string; personId: string }, signal: AbortSignal): Promise<RequestDraft>;
  lookup(input: LookupInput, ref: { requestId: string; personId: string }, signal: AbortSignal): Promise<RequestLookup>;
  answer(input: AnswerInput, ref: { requestId: string; personId: string }, signal: AbortSignal): Promise<{ answer: string }>;
};

export const REQUEST_DRAFT_PROMPT = `你替发起人把一句话起草成发给同事的请求，只调用 submit_candidate 提交 {title, body, recipientIds, questions}。
- title：一句话写清要对方做什么，不超过 30 字。
- body：写给接收人看的说明，分三段：前因后果（为什么要做）、要做什么（具体到哪张表、哪一栏、交什么）、截止和交付方式。只用发起人的原话和已回答的问题里的事实，不编造日期、链接和数字；原话里有链接原样保留。
- recipientIds：从 people 里挑原话点名或明显负责这件事的人，只填 people 里的 personId；对不上就交空数组，由发起人自己选。
- questions：自查接收人照着说明做时最容易来回问的细节（交付形式、放在哪里、格式、截止时间、范围），只问说明里确实没写清的，最多 3 个，每个一句话、带具体选项，例如「截图是直接贴进表格，还是存云盘、贴链接？」。clarifications 里已经回答过的不要再问；都清楚就交空数组。
- 有 clarifications 的回答时，把回答写进 body 对应的位置。

${ADDRESS_STYLE}`;

export const REQUEST_LOOKUP_PROMPT = `接收人对一条请求有疑问。你先查请求说明和已经回答过的问答里有没有答案，只调用 submit_candidate 提交 {match, quote, questionId, question}。
- 说明里有原文能直接回答这个问题：match=body，quote 逐字摘录那一段（不改写），questionId=null。
- 已回答的问答里有同一个问题或能直接回答它：match=question，questionId 填那一条的 questionId，quote=null。
- 都没有：match=none，quote=null，questionId=null。拿不准就算没有。
- question：不论有没有找到，都把接收人的话整理成一个发给发起人的清楚问题：一句话，带上请求标题里的对象（哪张表、哪一栏、哪一步），给出可选项。不加称呼和客套。

${ADDRESS_STYLE}`;

export const REQUEST_ANSWER_PROMPT = `你替请求的发起人起草对接收人问题的回答，只调用 submit_candidate 提交 {answer}。
- 只依据请求说明和已回答的问答；说明里没有依据的部分写成需要发起人补的空，用【】标出，不编造。
- 一到两句话，直接给结论，不加称呼和客套。

${ADDRESS_STYLE}`;

export function createRequestAgent(pool: Pool, env: AppEnv): RequestAgent {
  const run = async <T extends typeof DraftCandidate | typeof LookupCandidate | typeof AnswerCandidate>(
    kind: string, prompt: string, schema: T, input: unknown, ref: { requestId: string; personId: string }, signal: AbortSignal,
  ) => (await runCandidateAgent({
    query: pool.query.bind(pool), kind, objectRef: { type: "request", id: ref.requestId }, personId: ref.personId,
    input, prompt, schema, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.lightModel, modelSlot: "light", signal,
  })).candidate as Static<T>;
  return {
    draft: (input, ref, signal) => run("request-draft", REQUEST_DRAFT_PROMPT, DraftCandidate, input, ref, signal),
    lookup: (input, ref, signal) => run("request-lookup", REQUEST_LOOKUP_PROMPT, LookupCandidate, input, ref, signal),
    answer: (input, ref, signal) => run("request-answer", REQUEST_ANSWER_PROMPT, AnswerCandidate, input, ref, signal),
  };
}

/** 模型调用的统一时限：超时按失败处理，调用方决定降级还是报错。 */
export async function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("request agent timed out")), timeoutMs);
  try {
    return await Promise.race([
      call(abort.signal),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true })),
    ]);
  } finally { clearTimeout(timer); }
}
