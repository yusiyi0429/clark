import { Type } from "@sinclair/typebox";
import type { Pool } from "pg";
import type { TThreadObjectType } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import type { AppEnv } from "./app.js";

export type IntroInput = {
  objectType: TThreadObjectType; objectId: string; title: string; description: string;
  inviter: string; newcomers: string[]; note?: string; history: string[];
};
export type ThreadIntroAgent = { generate(input: IntroInput, signal: AbortSignal): Promise<{ message: string }> };
const Candidate = Type.Object({ message: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false });
const PROMPT = `你是群里的 Co-Agent。只调用 submit_candidate 提交 {message}。用 3 到 6 句中文向新成员介绍：这件事是什么、为什么与他们有关、前因后果、现在进度和下一步。优先使用邀请人的留言。只能使用输入中的成员可见事实，不编造。`;

export function createThreadIntroAgent(pool: Pool, env: AppEnv): ThreadIntroAgent {
  return { async generate(input, signal) {
    const result = await runCandidateAgent({
      query: pool.query.bind(pool), kind: "thread-intro", objectRef: { type: input.objectType, id: input.objectId },
      input, prompt: PROMPT, schema: Candidate, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
      modelId: env.lightModel, modelSlot: "light", signal,
    });
    return result.candidate;
  } };
}

/** 请求已提交后运行；模型异常和超时都留下可读的进群说明。 */
export async function postThreadIntro(pool: Pool, agent: ThreadIntroAgent, input: IntroInput, existingIds: string[], timeoutMs = 20_000): Promise<void> {
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
    message = `${input.inviter} 把 ${input.newcomers.join("、")} 拉进了这个群：「${input.title}」。`
      + (input.description ? sentence(input.description) : "")
      + (input.note ? `${input.inviter}说：「${input.note.trim()}」` : "");
  } finally { clearTimeout(timeout); }
  const saved = await pool.query<{ id: string }>(
    "INSERT INTO thread_messages (object_type, object_id, kind, content) VALUES ($1, $2, 'co-agent', $3) RETURNING id",
    [input.objectType, input.objectId, message],
  );
  for (const personId of existingIds) {
    await pool.query(`INSERT INTO thread_reads (object_type, object_id, person_id, last_read_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT (object_type,object_id,person_id) DO UPDATE
      SET last_read_id=GREATEST(thread_reads.last_read_id,EXCLUDED.last_read_id),updated_at=now()`,
    [input.objectType, input.objectId, personId, saved.rows[0].id]);
  }
}
