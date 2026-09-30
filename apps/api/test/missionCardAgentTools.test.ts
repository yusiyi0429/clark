import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { createMissionCardAnnotation } from "../src/missionCardAnnotations.js";
import { readMissionCardForAgent } from "../src/mcpMissionCards.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import type { ConversationRuntimeEvent } from "../src/conversations.js";
import { TEST_MEMBER } from "./helpers.js";
import { call, executionFixture } from "./executionFixture.js";

const rpc = (id: number, method: string, params: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });
async function editableFixture() {
  const fixture = await executionFixture("open");
  await fixture.t.sql("UPDATE mission_rounds SET closes_at=NULL WHERE id=$1", [fixture.round]);
  return fixture;
}
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function stream(content: AssistantMessage["content"], waitFor?: Promise<void>) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(async () => { if (waitFor) await waitFor; events.push({ type: "done", reason: content[0].type === "toolCall" ? "toolUse" : "stop",
    message: { role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content,
      stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(), usage } }); });
  return events;
}

describe("Mission card private Agent tools", () => {
  it("personal MCP rereads card permissions, rejects stale text, and preserves annotations plus revisions without group messages", async () => {
    const f = await editableFixture();
    try {
      const token = async (cookie: string) => (await call(f, cookie, "POST", "/api/me/tokens",
        { name: "任务卡工具", client: "codex", expiresInDays: null })).json().token as string;
      const memberToken = await token(f.member), thirdToken = await token(f.third), ceoToken = await token(f.ceo);
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
      expect(original.value).toMatchObject({ round: 1, ownerConfirmedAt: null });
      expect(original.value.missions[0]).toMatchObject({ id: "execution-one", version: 1, outcome: "目标" });
      expect(JSON.stringify(original.value)).not.toMatch(/"(?:actions|actionId|secret|signature)"/);
      expect((await invoke(thirdToken, "get_mission_card", { cardId: f.card })).value.code).toBe("MISSION_CARD_NOT_FOUND");
      // Visibility alone grants comment access; it must not grant the ability to rewrite a colleague's promise.
      await f.t.sql("UPDATE personal_mission_cards SET member_ids=member_ids || $2::jsonb WHERE id=$1", [f.card, '["person-fixture-003"]']);
      expect((await invoke(thirdToken, "get_mission_card", { cardId: f.card })).value.editable).toBe(false);
      const edit = { cardId: f.card, missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 1,
        sourceText: "目标", proposed: "交付可复核的界面与权限证据", reason: "用户明确补充验收结果", clientId: randomUUID() };
      const denied = await invoke(thirdToken, "edit_mission_card", edit);
      expect(denied.isError).toBe(true);
      expect(denied.value.code).toBe("MISSION_CARD_READ_ONLY");

      const people = loadCompanyMemory(f.t.env).searchPeople(undefined);
      const annotation = await createMissionCardAnnotation(f.t.pool, people, f.t.env.sessionSecret,
        { personId: TEST_MEMBER.personId, role: "member" }, f.card,
        { clientId: randomUUID(), missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 1, sourceText: "目标",
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
      const retained = await createMissionCardAnnotation(f.t.pool, people, f.t.env.sessionSecret,
        { personId: TEST_MEMBER.personId, role: "member" }, f.card,
        { clientId: randomUUID(), missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 2,
          sourceText: edit.proposed, quote: edit.proposed, prefix: "", suffix: "", startOffset: 0, body: "这条想法先留作审核备注" },
        () => new Date("2026-10-10T02:00:00Z"));
      expect("annotation" in retained).toBe(true);
      const retainedId = "annotation" in retained ? retained.annotation.id : "";
      const resolved = await call(f, f.member, "POST", `/api/mission-cards/${f.card}/annotations/${retainedId}/resolve`,
        { reason: "目前证据不足，保留备注供最后依赖核对" });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().annotation).toMatchObject({ status: "no_change", body: "这条想法先留作审核备注" });
      const overwritten = await invoke(memberToken, "edit_mission_card", { ...edit, sourceVersion: 2, sourceText: edit.proposed,
        proposed: "不能把已明确保留的备注悄悄改成已采纳", annotationId: retainedId, clientId: randomUUID() });
      expect(overwritten.value.code).toBe("ANNOTATION_ALREADY_PROCESSED");
      expect((await f.t.sql("SELECT body,status,note FROM mission_card_annotations WHERE id=$1", [retainedId]))[0])
        .toMatchObject({ body: "这条想法先留作审核备注", status: "no_change", note: expect.stringContaining("目前证据不足") });
      await f.t.sql("UPDATE personal_mission_cards SET owner_confirmed_at=$2 WHERE id=$1", [f.card, "2026-10-10T02:00:00Z"]);
      const frozen = await invoke(memberToken, "get_mission_card", { cardId: f.card });
      expect(frozen.value).toMatchObject({ editable: false, ownerConfirmedAt: "2026-10-10T02:00:00.000Z", round: 1 });
      expect(frozen.value.annotations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: annotationId, sourceText: "目标", body: "补充界面与权限证据", status: "applied" }),
        expect.objectContaining({ id: retainedId, body: "这条想法先留作审核备注", status: "no_change", note: expect.stringContaining("目前证据不足") }),
      ]));
      expect(frozen.value.revisions[0].id).toBe(saved.value.revision.id);
      const afterConfirmation = { ...edit, sourceVersion: 2, sourceText: edit.proposed,
        proposed: "确认后不能悄悄改承诺", clientId: randomUUID() };
      for (const bearer of [memberToken, ceoToken]) {
        expect((await invoke(bearer, "edit_mission_card", afterConfirmation)).value.code).toBe("OWNER_CONFIRMED");
      }
      expect((await invoke(memberToken, "edit_mission_card", { ...afterConfirmation, sourceRound: undefined })).value.code).toBe("INVALID_INPUT");
      expect((await f.t.sql("SELECT outcome,version FROM missions WHERE id='execution-one'"))[0]).toMatchObject({ outcome: edit.proposed, version: 2 });
      expect(await f.t.sql("SELECT id FROM mission_card_revisions WHERE card_id=$1", [f.card])).toHaveLength(1);
      await f.t.sql("UPDATE personal_mission_cards SET member_ids='[]'::jsonb WHERE id=$1", [f.card]);
      expect((await invoke(memberToken, "get_mission_card", { cardId: f.card })).value.code).toBe("MISSION_CARD_NOT_FOUND");
      expect((await invoke(memberToken, "edit_mission_card", { ...edit, clientId: randomUUID() })).isError).toBe(true);
    } finally { await f.t.close(); }
  });

  it("private runtime scopes tools to this card and immediately applies a clear edit, then saves an ambiguity question", async () => {
    const f = await editableFixture();
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
          missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 1, sourceText: "目标", proposed: "验证两种身份的权限闭环",
          reason: "用户已明确修改结果", clientId: randomUUID(),
        } }]);
        if (callIndex === 3) return stream([{ type: "toolCall", id: "stale-current", name: "edit_mission_card", arguments: {
          missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 1, sourceText: "目标", proposed: "不能覆盖新正文",
          reason: "检查版本冲突", clientId: randomUUID(),
        } }]);
        if (callIndex === 4) return stream([{ type: "toolCall", id: "clarify-current", name: "ask_mission_card_question", arguments: {
          missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 2, sourceText: "验证两种身份的权限闭环",
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
      expect(editSchema).toMatchObject({ required: expect.arrayContaining(["sourceRound", "sourceVersion", "sourceText"]) });
      expect(contexts[0].systemPrompt).toContain("本人已确认或已开始汇总时只读");
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

  it("拒绝关闭并重新开放审核前生成的晚到私聊改写，即使Mission原文与版本都没变", async () => {
    const f = await editableFixture();
    let release!: () => void, ready!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const drafting = new Promise<void>((resolve) => { ready = resolve; });
    const events: ConversationRuntimeEvent[] = [];
    const contexts: Context[] = [];
    let calls = 0;
    const runtime = await createPiConversationRuntime({ companyMemory: loadCompanyMemory(f.t.env), materialPool: f.t.pool,
      missionCardSecret: f.t.env.sessionSecret, now: () => new Date("2026-10-10T02:00:00Z"),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test", modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push(context); calls++;
        if (calls === 1) return stream([{ type: "toolCall", id: "read-window-one", name: "read_mission_card", arguments: {} }]);
        if (calls === 2) {
          ready();
          return stream([{ type: "toolCall", id: "late-window-one", name: "edit_mission_card", arguments: {
            missionId: "execution-one", field: "outcome", sourceRound: 1, sourceVersion: 1, sourceText: "目标",
            proposed: "上一审核中生成的晚到改法", reason: "用户此前的明确要求", clientId: randomUUID(),
          } }], pending);
        }
        return stream([{ type: "text", text: "审核已重新开放，需要重新核对本次改法。" }]);
      } });
    const run = runtime.run({ scope: `mission-card:${f.card}`,
      viewer: { personId: TEST_MEMBER.personId, displayName: "测试乙", role: "member" }, message: "调整结果表述",
      currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(),
      signal: new AbortController().signal, emit: (event) => { events.push(event); } });
    try {
      await drafting;
      const read = contexts[1].messages.findLast((item) => item.role === "toolResult");
      const readText = read?.role === "toolResult" ? read.content.find((item) => item.type === "text") : undefined;
      expect(readText?.type === "text" && JSON.parse(readText.text)).toMatchObject({ round: 1, editable: true });
      const act = async (actionType: string) => {
        const page = (await call(f, f.ceo, "GET", `/api/mission-cards/${f.card}`)).json().cards[0];
        const action = page.actions.find((item: { actionType: string }) => item.actionType === actionType);
        expect(action).toBeDefined();
        const response = await call(f, f.ceo, "POST", "/api/mission-rounds/actions/execute", { actionId: action.actionId, viewCardId: f.card });
        expect(response.statusCode).toBe(200);
        return response.json().cards[0];
      };
      await act("mission-round.close");
      const closedRead = await readMissionCardForAgent(f.t.pool.query.bind(f.t.pool), loadCompanyMemory(f.t.env).searchPeople(undefined),
        f.t.env.sessionSecret, { personId: TEST_MEMBER.personId, role: "member" }, f.card, new Date("2026-10-10T02:00:00Z"));
      expect(closedRead).toMatchObject({ editable: false, round: 1, reviewContext: { phase: "reviewing",
        snapshotAt: "2026-10-10T02:00:00.000Z", takenAt: "2026-10-10T02:00:00.000Z" }, annotations: [], revisions: [] });
      const reopened = await act("mission-round.reopen");
      expect(reopened.payload.round.round).toBe(2);
      release(); await run;
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool", phase: "completed",
        name: "edit_mission_card", toolCallId: "late-window-one", isError: true })]));
      expect(JSON.stringify(contexts[2].messages.findLast((item) => item.role === "toolResult"))).toContain("ROUND_CHANGED");
      expect((await f.t.sql("SELECT outcome,version FROM missions WHERE id='execution-one'"))[0]).toMatchObject({ outcome: "目标", version: 1 });
      expect(await f.t.sql("SELECT id FROM mission_card_revisions WHERE card_id=$1", [f.card])).toEqual([]);
      expect(await f.t.sql("SELECT id FROM mission_card_feedback WHERE card_id=$1", [f.card])).toEqual([]);
    } finally { release(); await run.catch(() => undefined); await runtime.close?.(); await f.t.close(); }
  }, 20_000);
});
