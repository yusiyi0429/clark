import { Type } from "@sinclair/typebox";
import type { Pool } from "pg";
import type { TThreadObjectType } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import type { AppEnv } from "./app.js";
import { postCoAgentMessage } from "./threads.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

export type IntroInput = {
  objectType: TThreadObjectType; objectId: string; title: string; description: string;
  inviter: string; newcomers: string[]; note?: string; history: string[];
};
export type ThreadIntroAgent = { generate(input: IntroInput, signal: AbortSignal): Promise<{ message: string }> };
const Candidate = Type.Object({ message: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false });
export const THREAD_INTRO_PROMPT = `你是群里的 Co-Agent。只调用 submit_candidate 提交 {message}。用 3 到 6 句中文向新成员介绍：这件事是什么、为什么与他们有关、前因后果、现在进度和下一步。优先使用邀请人的留言。只能使用输入中的成员可见事实，不编造。

${ADDRESS_STYLE}`;

export function createThreadIntroAgent(pool: Pool, env: AppEnv): ThreadIntroAgent {
  return { async generate(input, signal) {
    const result = await runCandidateAgent({
      query: pool.query.bind(pool), kind: "thread-intro", objectRef: { type: input.objectType, id: input.objectId },
      input, prompt: THREAD_INTRO_PROMPT, schema: Candidate, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
      modelId: env.lightModel, modelSlot: "light", signal,
    });
    return result.candidate;
  } };
}

/** 资料里的章节 / 指标编号（A3、B1、G3a、A4-PO……）：一号位看不懂，兜底说明里不出现。 */
const SECTION_CODE_RE = /(?<![A-Za-z0-9])[A-G]\d{1,2}[a-z]?(?:-[A-Za-z]+)?(?![A-Za-z0-9])/;

/** 兜底说明用的背景：去掉「（依据：…）」括注；还带章节编号就不写背景，只说谁拉了谁、为什么。 */
function plainBackground(description: string): string {
  const text = description.replace(/[（(]\s*依据[:：][^（）()]*[）)]/g, "").trim();
  return SECTION_CODE_RE.test(text) ? "" : text;
}

/** 请求已提交后运行；模型异常和超时都留下可读的进群说明。开场白是异步补上的，等模型可以久一点。 */
export async function postThreadIntro(pool: Pool, agent: ThreadIntroAgent, input: IntroInput, existingIds: string[], timeoutMs = 45_000): Promise<void> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("thread intro timed out")), timeoutMs);
  let message: string;
  try {
    const generated = await Promise.race([
      agent.generate(input, abort.signal),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("thread intro timed out")), { once: true })),
    ]);
    if (typeof generated.message !== "string" || !generated.message.trim() || generated.message.length > 4000) throw new Error("invalid thread intro");
    message = generated.message.trim();
  } catch {
    const sentence = (text: string) => text.trim().replace(/[。.！!；;，,\s]+$/u, "") + "。";
    const background = plainBackground(input.description);
    message = `${input.inviter}把${input.newcomers.join("、")}拉进了这个群：「${input.title}」。`
      + (background ? sentence(background) : "")
      + (input.note ? `${input.inviter}说：「${input.note.trim()}」` : "");
  } finally { clearTimeout(timeout); }
  await postCoAgentMessage(pool.query.bind(pool), { objectType: input.objectType, objectId: input.objectId }, message, existingIds);
}
