import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createTestApp, createTestDb, TEST_CEO } from "./helpers.js";
import { migrate } from "../src/migrate.js";
import { historyTerms, searchOwnConversationHistory } from "../src/conversationHistorySearch.js";
import type { ConversationRuntime } from "../src/conversations.js";

async function conversation(db: import("pg").PoolClient, owner: string, scope: string, messages: [string, string][], options: { archived?: boolean; deleted?: boolean; at?: string } = {}) {
  const id = randomUUID();
  await db.query("INSERT INTO conversations (id, owner_id, scope, pi_session_id, archived_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, owner, scope, randomUUID(), options.archived ? new Date() : null, options.deleted ? new Date() : null]);
  for (const [index, [role, content]] of messages.entries()) {
    await db.query("INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))",
      [id, index + 1, role, content, randomUUID(), options.at ?? null]);
  }
  return id;
}

test("history terms split long Chinese runs into two-character words and keep short ones whole", () => {
  expect(historyTerms("渠道下沉")).toEqual(["渠道下沉"]);
  expect(historyTerms("渠道下沉的打法 GTM")).toEqual(["gtm", "渠道", "道下", "下沉", "沉的", "的打", "打法"]);
});

test("finds the owner's original words across scopes and archived conversations, two months back, with cite (3e)", async () => {
  await createTestDb(async ({ db, pool }) => {
    await migrate(db);
    const old = await conversation(db, "alice", "global", [["user", "我觉得渠道下沉要先做县城样板，再谈全国铺开。"], ["assistant", "明白。"]],
      { archived: true, at: new Date(Date.now() - 62 * 86_400_000).toISOString() });
    const issue = await conversation(db, "alice", "issue:abc", [["user", "这个议题和渠道下沉有关系吗？"]]);
    await conversation(db, "alice", "global", [["user", "渠道下沉的删除对话"]], { deleted: true });
    await conversation(db, "bob", "global", [["user", "渠道下沉是 bob 的想法"]]);
    const result = await searchOwnConversationHistory(pool.query.bind(pool), { personId: "alice", query: "渠道下沉" });
    expect(result.hits.map((hit) => hit.cite).sort()).toEqual([`cite:chat:${issue}#1`, `cite:chat:${old}#1`].sort());
    const archived = result.hits.find((hit) => hit.cite === `cite:chat:${old}#1`)!;
    expect(archived).toMatchObject({ scope: "global", role: "user", archived: true });
    expect(archived.snippet).toContain("县城样板");
    expect(JSON.stringify(result)).not.toContain("bob");
    expect(JSON.stringify(result)).not.toContain("删除对话");
    expect((await searchOwnConversationHistory(pool.query.bind(pool), { personId: "carol", query: "渠道下沉" })).hits).toEqual([]);
  });
});

test("the Pi runtime exposes search_conversation_history and returns the cite to the model (3e)", async () => {
  const { createPiConversationRuntime } = await import("../src/piConversationRuntime.js");
  const { loadCompanyMemory } = await import("../src/companyMemory.js");
  const { testEnv } = await import("./helpers.js");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  let calls = 0;
  let toolResult = "";
  const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(testEnv), baseUrl: "https://provider.invalid/v1", apiKey: "test-key", modelId: "fake-light",
    streamSimple: (_model, context) => {
      calls++;
      if (calls === 1) expect(context.tools?.map((tool) => tool.name)).toContain("search_conversation_history");
      else toolResult = JSON.stringify(context.messages.findLast((item) => item.role === "toolResult"));
      const content = calls === 1 ? [{ type: "toolCall" as const, id: "h1", name: "search_conversation_history", arguments: { query: "县城样板" } }] : [{ type: "text" as const, text: "找到了" }];
      const message = { role: "assistant" as const, api: "openai-responses" as const, provider: "warmap", model: "fake-light", content, stopReason: calls === 1 ? "toolUse" as const : "stop" as const, usage, timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message } as never));
      return stream;
    } });
  try {
    const result = await runtime.run({ viewer: { personId: "alice", displayName: "甲", role: "ceo" }, scope: "global", message: "上次说的县城样板？", currentObject: null, referencesSnapshot: [],
      runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => {},
      searchHistory: async () => ({ hits: [{ cite: "cite:chat:c1#3", scope: "global", role: "user", at: "2026-08-01T00:00:00.000Z", archived: true, snippet: "先做县城样板" }] }) });
    expect(result.assistantMessage).toBe("找到了");
    expect(toolResult).toContain("cite:chat:c1#3");
  } finally { await runtime.close?.(); }
});

test("the main agent gets a history search bound to the signed-in person that skips the current message (3e)", async () => {
  const results: unknown[] = [];
  const t = await createTestApp({}, { async run(input) {
    if (input.message.includes("上次")) results.push(await input.searchHistory!("县城样板"));
    return { assistantMessage: "好的", runtimeEntries: input.runtimeEntries };
  } } satisfies ConversationRuntime);
  try {
    const ceo = { cookie: await t.loginCookie(), origin: t.publicOrigin };
    const member = { cookie: await t.memberCookie(), origin: t.publicOrigin };
    await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: member, payload: { message: "县城样板是成员的想法" } });
    await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: ceo, payload: { message: "先做县城样板。" } });
    // 067 归档过的旧对话（界面上已不再有新建对话）：原话仍能检索到。
    await t.sql("UPDATE conversations SET archived_at = now() WHERE owner_id = $1", [TEST_CEO.personId]);
    await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: ceo, payload: { message: "上次说的县城样板是什么？" } });
    const [found] = results as { hits: { snippet: string; archived: boolean }[] }[];
    expect(found.hits.map((hit) => hit.snippet)).toEqual(["先做县城样板。"]);
    expect(found.hits[0].archived).toBe(true);
  } finally {
    await t.close();
  }
});
