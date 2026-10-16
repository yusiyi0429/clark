/**
 * 3g：记忆正文可以进 LangSmith（只有项目成员能看，用户已确认），凭证和密钥仍要脱敏。
 * 不连 LangSmith：假 client 记录 SDK 发出的 create / update。
 */
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { redactSecrets } from "../src/observability.js";
import { AGENT_ROLES, configureTracing, newThreadId, resetTracing, tracedTurn, type TraceClientLike } from "../src/tracing.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createPersonalMemory } from "../src/personalMemory.js";
import { createPersonalDistillation } from "../src/personalDistillation.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testEnv } from "./helpers.js";

const CREDENTIAL = "lsv2_pt_0123456789abcdefABCDEF";
const BEARER = "Bearer abcdefghijklmnopqrstuvwxyz012345";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function fakeClient() {
  const sent: unknown[] = [];
  const client: TraceClientLike = {
    async createRun(run) { sent.push(structuredClone(run)); },
    async updateRun(id, run) { sent.push({ id, ...structuredClone(run) }); },
  };
  return { client, wire: () => JSON.stringify(sent) };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
  const message: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, stopReason, usage, timestamp: Date.now() };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "done", reason: stopReason, message } as never));
  return stream;
}

afterEach(() => resetTracing());

test("redaction keeps memory and message bodies but removes credentials embedded in text or under secret keys", () => {
  expect(redactSecrets({ text: `PRIVATE_MEMORY_BODY ${CREDENTIAL}`, header: BEARER, apiKey: "plain", totalTokens: 3 })).toEqual({
    text: "PRIVATE_MEMORY_BODY [REDACTED]", header: "[REDACTED]", apiKey: "[REDACTED]", totalTokens: 3,
  });
});

test("a main conversation turn traces the personal memory body and tool results, never the credential", async () => {
  const fake = fakeClient();
  configureTracing({ enabled: true, client: fake.client, salt: "test-salt" });
  let calls = 0;
  const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://provider.invalid/v1", apiKey: "test-key", modelId: "fake-light",
    streamSimple: () => ++calls === 1
      ? reply([{ type: "toolCall", id: "p1", name: "search_personal_memory", arguments: { query: "结论" } }], "toolUse")
      : reply([{ type: "text", text: "按你的习惯先给结论。" }], "stop") });
  try {
    await tracedTurn({ resolve: async () => ({ agentRole: AGENT_ROLES.ceoAgent, logicalTurnId: "conv-test-t1", attempt: 1, threadId: newThreadId(), scope: "global", anonUserId: "u_test", inputs: {} }) },
      () => runtime.run({ viewer: { personId: "alice", displayName: "甲", role: "ceo" }, scope: "global", message: `帮我看看这个，key 是 ${CREDENTIAL}`,
        currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => {},
        personalMemory: [{ id: "m1", title: "沟通偏好", text: "PRIVATE_MEMORY_BODY 先给结论" }],
        personalMemoryTools: {
          search: async () => [{ id: "m2", title: "立场", text: "PRIVATE_TOOL_BODY 县城样板优先" }],
          remember: async () => { throw new Error("unused"); }, forget: async () => { throw new Error("unused"); },
        } }));
    await settle();
    const wire = fake.wire();
    expect(wire).toContain("PRIVATE_MEMORY_BODY");
    expect(wire).toContain("PRIVATE_TOOL_BODY");
    expect(wire).toContain("帮我看看这个");
    expect(wire).not.toContain(CREDENTIAL);
    expect(wire).not.toContain("test-key");
  } finally { await runtime.close?.(); }
});

test("personal memory distillation traces the user's words and memory, never the credential", async () => {
  const fake = fakeClient();
  configureTracing({ enabled: true, client: fake.client, salt: "test-salt" });
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    {
      const memory = createPersonalMemory({ pool });
      await memory.add("alice", { title: "沟通偏好", text: "PRIVATE_MEMORY_BODY 先给结论。" });
      const conversationId = randomUUID();
      await db.query("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, 'alice', 'global', $2)", [conversationId, randomUUID()]);
      await db.query("INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id) VALUES ($1, 1, 'user', $2, $3)",
        [conversationId, `我的想法：县城样板优先。顺便 ${CREDENTIAL}`, randomUUID()]);
      const worker = createPersonalDistillation({ pool, memory, baseUrl: "https://provider.invalid/v1", apiKey: "test-key", modelId: "fake-light",
        streamSimple: () => reply([{ type: "toolCall", id: "c1", name: "submit_candidate", arguments: { status: "noop", changes: [], clarification: "" } }], "toolUse") });
      await worker.enqueue(db, { personId: "alice", conversationId, throughSequence: 1 });
      await worker.processNext();
      await settle();
      const wire = fake.wire();
      expect(wire).toContain("PRIVATE_MEMORY_BODY");
      expect(wire).toContain("县城样板优先");
      expect(wire).not.toContain(CREDENTIAL);
      expect(wire).not.toContain("test-key");
    }
  });
});
