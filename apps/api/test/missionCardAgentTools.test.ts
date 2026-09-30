import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { TEST_MEMBER } from "./helpers.js";
import { call, executionFixture } from "./executionFixture.js";

const rpc = (id: number, method: string, params: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function stream(content: AssistantMessage["content"]) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => events.push({ type: "done", reason: content[0].type === "toolCall" ? "toolUse" : "stop",
    message: { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content,
      stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage } }));
  return events;
}

describe("Mission card private Agent tools", () => {
  it("personal MCP rereads card permissions, rejects stale text, and preserves annotations plus revisions without group messages", async () => {
    const f = await executionFixture();
    try {
      const token = async (cookie: string) => (await call(f, cookie, "POST", "/api/me/tokens",
        { name: "任务卡工具", client: "codex", expiresInDays: null })).json().token as string;
      const memberToken = await token(f.member), thirdToken = await token(f.third);
      const invoke = async (bearer: string, name: string, args: Record<string, unknown>) => {
        const reply = await f.t.app.inject({ method: "POST", url: "/mcp/me",
          headers: { authorization: `Bearer ${bearer}`, accept: "application/json, text/event-stream" },
          payload: rpc(1, "tools/call", { name, arguments: args }) });
        const result = reply.json().result;
        return { isError: result.isError, value: JSON.parse(result.content[0].text) };
      };
      const original = await invoke(memberToken, "get_mission_card", { cardId: f.card });
      expect(original.isError).toBe(false);
      expect(original.value.editable).toBe(true);
      expect(original.value.missions[0]).toMatchObject({ id: "execution-one", version: 1, outcome: "目标" });
      expect(JSON.stringify(original.value)).not.toMatch(/"(?:actions|actionId|secret|signature)"/);
      expect((await invoke(thirdToken, "get_mission_card", { cardId: f.card })).value.code).toBe("MISSION_CARD_NOT_FOUND");
      // Visibility alone grants comment access; it must not grant the ability to rewrite a colleague's promise.
      await f.t.sql("UPDATE personal_mission_cards SET member_ids=member_ids || $2::jsonb WHERE id=$1", [f.card, '["person-fixture-003"]']);
      expect((await invoke(thirdToken, "get_mission_card", { cardId: f.card })).value.editable).toBe(false);
      const edit = { cardId: f.card, missionId: "execution-one", field: "outcome", sourceVersion: 1,
        sourceText: "目标", proposed: "交付可复核的界面与权限证据", reason: "用户明确补充验收结果", clientId: randomUUID() };
      const denied = await invoke(thirdToken, "edit_mission_card", edit);
      expect(denied.isError).toBe(true);
      expect(denied.value.code).toBe("MISSION_CARD_READ_ONLY");

      const people = loadCompanyMemory(f.t.env).searchPeople(undefined);
      const annotation = await createMissionCardAnnotation(f.t.pool, people, f.t.env.sessionSecret,
        { personId: TEST_MEMBER.personId, role: "member" }, f.card,
        { clientId: randomUUID(), missionId: "execution-one", field: "outcome", sourceVersion: 1, sourceText: "目标",
          quote: "目标", prefix: "", suffix: "", startOffset: 0, body: "补充界面与权限证据" }, () => new Date("2026-10-10T02:00:00Z"));
      expect("annotation" in annotation).toBe(true);
      const annotationId = "annotation" in annotation ? annotation.annotation.id : undefined;
      const saved = await invoke(memberToken, "edit_mission_card", { ...edit, annotationId });
      expect(saved.isError).toBe(false);
      expect(saved.value.revision).toMatchObject({ before: "目标", after: edit.proposed, beforeVersion: 1,
        afterVersion: 2, source: "agent", annotationId });
      const replay = await invoke(memberToken, "edit_mission_card", { ...edit, annotationId });
      expect(replay.value.revision.id).toBe(saved.value.revision.id);
      const current = await invoke(memberToken, "get_mission_card", { cardId: f.card });
      expect(current.value.missions[0]).toMatchObject({ outcome: edit.proposed, version: 2 });
      expect(current.value.annotations[0]).toMatchObject({ sourceText: "目标", body: "补充界面与权限证据" });
      expect(current.value.revisions).toHaveLength(1);
      expect((await f.t.sql("SELECT count(*) AS n FROM mission_card_feedback WHERE card_id=$1", [f.card]))[0].n).toBe("0");
      expect((await invoke(memberToken, "edit_mission_card", { ...edit, clientId: randomUUID() })).value.code).toBe("SOURCE_VERSION_CONFLICT");
      expect((await invoke(memberToken, "edit_mission_card", { ...edit, sourceVersion: 2, clientId: randomUUID() })).value.code).toBe("SOURCE_TEXT_CONFLICT");
      expect((await invoke(memberToken, "edit_mission_card", { ...edit, missionId: "foreign-mission", clientId: randomUUID() })).isError).toBe(true);
      await f.t.sql("UPDATE personal_mission_cards SET member_ids='[]'::jsonb WHERE id=$1", [f.card]);
      expect((await invoke(memberToken, "get_mission_card", { cardId: f.card })).value.code).toBe("MISSION_CARD_NOT_FOUND");
      expect((await invoke(memberToken, "edit_mission_card", { ...edit, clientId: randomUUID() })).isError).toBe(true);
    } finally { await f.t.close(); }
  });

  it("private runtime scopes tools to this card and immediately applies a clear edit, then saves an ambiguity question", async () => {
    const f = await executionFixture();
    const contexts: Context[] = [];
    const events: ConversationRuntimeEvent[] = [];
    let callIndex = 0;
    const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(f.t.env), materialPool: f.t.pool,
      missionCardSecret: f.t.env.sessionSecret, now: () => new Date("2026-10-10T02:00:00Z"),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test", modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push(context); callIndex++;
        if (callIndex === 1) return stream([{ type: "toolCall", id: "read-current", name: "read_mission_card", arguments: {} }]);
        if (callIndex === 2) return stream([{ type: "toolCall", id: "edit-current", name: "edit_mission_card", arguments: {
          missionId: "execution-one", field: "outcome", sourceVersion: 1, sourceText: "目标", proposed: "验证两种身份的权限闭环",
          reason: "用户已明确修改结果", clientId: randomUUID(),
        } }]);
        if (callIndex === 3) return stream([{ type: "toolCall", id: "stale-current", name: "edit_mission_card", arguments: {
          missionId: "execution-one", field: "outcome", sourceVersion: 1, sourceText: "目标", proposed: "不能覆盖新正文",
          reason: "检查版本冲突", clientId: randomUUID(),
        } }]);
        if (callIndex === 4) return stream([{ type: "toolCall", id: "clarify-current", name: "ask_mission_card_question", arguments: {
          missionId: "execution-one", field: "outcome", sourceVersion: 2, sourceText: "验证两种身份的权限闭环",
          quote: "权限闭环", body: "这段还需要明确怎么验证", question: "以哪种证据验证？", options: ["界面走查记录", "权限测试结果"],
          clientId: randomUUID(),
        } }]);
        return stream([{ type: "text", text: "已改任务结果，证据方式等待你的选择。" }]);
      } });
    try {
      const run = (scope: `mission-card:${string}` | "global") => runtime.run({ scope,
        viewer: { personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member" }, message: "改为验证两种身份的权限闭环，再确认怎么验证",
        currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: (event) => { events.push(event); } });
      await run(`mission-card:${f.card}`);
      expect(contexts[0].systemPrompt).toContain("确定需要修改且明确怎么改时立即执行");
      expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read_mission_card", "edit_mission_card", "ask_mission_card_question"]));
      const editSchema = contexts[0].tools?.find((tool) => tool.name === "edit_mission_card")?.parameters as { properties: Record<string, unknown> };
      expect(editSchema.properties).not.toHaveProperty("cardId");
      expect(JSON.stringify(contexts[2].messages.findLast((item) => item.role === "toolResult"))).toContain("afterVersion");
      expect(JSON.stringify(contexts[3].messages.findLast((item) => item.role === "toolResult"))).toContain("SOURCE_VERSION_CONFLICT");
      expect(events.filter((event) => event.type === "tool" && event.phase === "completed"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "edit_mission_card", toolCallId: "edit-current", isError: false }),
          expect.objectContaining({ name: "edit_mission_card", toolCallId: "stale-current", isError: true }),
          expect.objectContaining({ name: "ask_mission_card_question", isError: false }),
        ]));
      expect((await f.t.sql("SELECT outcome,version FROM missions WHERE id='execution-one'"))[0]).toMatchObject({ outcome: "验证两种身份的权限闭环", version: 2 });
      expect((await f.t.sql("SELECT status,question,body FROM mission_card_annotations WHERE card_id=$1", [f.card]))[0])
        .toMatchObject({ status: "needs_clarification", question: "以哪种证据验证？", body: "这段还需要明确怎么验证" });
      expect((await f.t.sql("SELECT count(*) AS n FROM mission_card_feedback WHERE card_id=$1", [f.card]))[0].n).toBe("0");
      await run("global");
      expect(contexts.at(-1)?.tools?.map((tool) => tool.name)).not.toContain("edit_mission_card");
      expect(contexts.at(-1)?.systemPrompt).not.toContain("确定需要修改且明确怎么改时立即执行");
    } finally { await runtime.close?.(); await f.t.close(); }
  }, 20_000);
});
