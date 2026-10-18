import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { testEnv } from "./helpers.js";

/** 已定设计第 6 节第 5 条：回答里用到个人记忆的地方带一个小标记；系统提示告诉模型怎么写这个标记。 */
it("both the CEO and member agents are told to mark used personal memory as [记忆](cite:pmem:<id>) with the id copied", async () => {
  const contexts: Context[] = [];
  const runtime = await createPiConversationRuntime({
    companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
    streamSimple: (_model, context) => {
      contexts.push(context);
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => events.push({ type: "done", reason: "stop", message: {
        role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content: [{ type: "text", text: "好" }],
        stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } }));
      return events;
    },
  });
  try {
    for (const role of ["ceo", "member"] as const) await runtime.run({
      scope: "global", viewer: { role, personId: role, displayName: role }, message: "我之前对渠道下沉是什么看法？",
      currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined,
      personalMemory: [{ id: "5f0e8c1a-0000-4000-8000-000000000001", title: "渠道下沉", text: "先做县城样板。" }],
    });
    const prompts = contexts.filter((context) => /个人记忆/.test(context.systemPrompt ?? "")).map((context) => context.systemPrompt ?? "");
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of prompts) expect(prompt).toContain("[记忆](cite:pmem:<条目 id>)");
  } finally { await runtime.close?.(); }
});
