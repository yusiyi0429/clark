import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { AskAnswerRecord, ConversationCard, ConversationSseEvent, type TAskUserInput, type TConversationCard } from "@warmap/contracts";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { createTestApp, testEnv, type TestApp } from "./helpers.js";

/**
 * Agent 向本人提问（askUser.ts）：提问卡挂在回答后面、这一轮停住；本人按卡作答，答案作为下一条消息发回来，
 * 原文由服务端按卡重写，问答记录存在那条消息上。
 */
const QUESTIONS: TAskUserInput["questions"] = [
  { question: "这次复盘的重点放在哪？", options: [{ label: "交付进度", recommended: true }, { label: "客户反馈", detail: "要补访谈记录" }] },
  { question: "计划外的事要不要写进去？", options: [{ label: "写" }, { label: "不写", recommended: true }] },
  { question: "下个月还做不做？", options: [{ label: "继续" }, { label: "停" }] },
];

function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

describe("对话里 Agent 提问 → 本人作答 → 继续", () => {
  it("提问卡挂在回答后面、步骤停在「等你回答」；作答按卡重写原文并存下问答记录，同一张卡只能答一次", async () => {
    const turns: Parameters<ConversationRuntime["run"]>[0][] = [];
    const runtime: ConversationRuntime = { async run(input) {
      turns.push(input);
      if (turns.length === 1) {
        input.ask!(QUESTIONS);
        input.emit({ type: "message", delta: "先定三件事。" });
        return { assistantMessage: "先定三件事。", runtimeEntries: input.runtimeEntries };
      }
      input.emit({ type: "message", delta: "好" });
      return { assistantMessage: "好", runtimeEntries: input.runtimeEntries };
    } };
    t = await createTestApp({}, runtime);
    const member = await t.memberCookie();
    const post = (payload: Record<string, unknown>) => t!.app.inject({ method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie: member, origin: t!.publicOrigin, accept: "text/event-stream" }, payload });
    const history = async () => (await t!.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: member } })).json()
      .messages as Record<string, unknown>[];

    const first = await post({ message: "帮我把这个月的复盘过一遍" });
    expect(first.statusCode).toBe(200);
    const events = parseSse(first.body);
    for (const event of events) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
    expect(events.filter((event) => event.type === "step")).toEqual([expect.objectContaining({ id: "ask", label: "等你回答", status: "active", result: "3 个问题" })]);
    const asked = (await history()).at(-1)!;
    const card = (asked.cards as TConversationCard[])[0] as Extract<TConversationCard, { kind: "questions" }>;
    expect(Value.Check(ConversationCard, card)).toBe(true);
    expect(card).toEqual({ kind: "questions", askId: expect.any(String), questions: QUESTIONS.map((question, index) => ({ id: `q${index + 1}`, ...question })) });

    // 第一题采纳推荐，第二题自己写，第三题跳过。
    const answered = await post({ message: "（本地预览）", answers: { askId: card.askId, items: [{ questionId: "q1", option: 0 }, { questionId: "q2", text: " 只写跟客户相关的 " }] } });
    expect(answered.statusCode).toBe(200);
    const text = "（回答你上一轮的提问）\n1. 这次复盘的重点放在哪？\n答：交付进度（采纳推荐）\n2. 计划外的事要不要写进去？\n答：只写跟客户相关的（自己写的）\n3. 下个月还做不做？\n答：跳过";
    expect(turns[1].message).toBe(text);
    const messages = await history();
    const reply = messages.at(-2)!;
    expect(Value.Check(AskAnswerRecord, reply.answers)).toBe(true);
    expect(reply).toMatchObject({ role: "user", content: text, answers: { askId: card.askId, items: [
      { questionId: "q1", question: "这次复盘的重点放在哪？", kind: "option", answer: "交付进度", recommended: true },
      { questionId: "q2", question: "计划外的事要不要写进去？", kind: "other", answer: "只写跟客户相关的" },
      { questionId: "q3", question: "下个月还做不做？", kind: "skipped" },
    ] } });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "好" });

    const again = await post({ message: "再答一次", answers: { askId: card.askId, items: [{ questionId: "q1", option: 1 }] } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("ASK_ANSWERED");
    expect(turns).toHaveLength(2);
  });

  it("对不上的作答退回：别人的卡、不存在的卡、越界的选项、选了又写", async () => {
    const runtime: ConversationRuntime = { async run(input) {
      input.ask!(QUESTIONS.slice(0, 1));
      return { assistantMessage: "", runtimeEntries: input.runtimeEntries };
    } };
    t = await createTestApp({}, runtime);
    const member = await t.memberCookie();
    const ceo = await t.loginCookie();
    const post = (cookie: string, payload: Record<string, unknown>) => t!.app.inject({ method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie, origin: t!.publicOrigin, accept: "text/event-stream" }, payload });
    expect((await post(member, { message: "问我" })).statusCode).toBe(200);
    const card = ((await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: member } })).json()
      .messages.at(-1).cards as TConversationCard[])[0] as Extract<TConversationCard, { kind: "questions" }>;
    // 停在提问上、没有正文的回答也存下（空正文），卡照样挂着。
    expect(card.kind).toBe("questions");

    const code = async (cookie: string, items: unknown[], askId = card.askId) => {
      const response = await post(cookie, { message: "答", answers: { askId, items } });
      return [response.statusCode, response.json().code];
    };
    expect((await post(ceo, { message: "开个头" })).statusCode).toBe(200);
    expect(await code(ceo, [{ questionId: "q1", option: 0 }])).toEqual([404, "ASK_NOT_FOUND"]);
    expect(await code(member, [{ questionId: "q1", option: 0 }], randomUUID())).toEqual([404, "ASK_NOT_FOUND"]);
    expect(await code(member, [{ questionId: "q1", option: 3 }])).toEqual([400, "ASK_ANSWER_INVALID"]);
    expect(await code(member, [{ questionId: "q9", option: 0 }])).toEqual([400, "ASK_ANSWER_INVALID"]);
    expect(await code(member, [{ questionId: "q1", option: 0, text: "都要" }])).toEqual([400, "ASK_ANSWER_INVALID"]);
  });
});

const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
  ({ role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage, stopReason, timestamp: Date.now() });
function stream(final: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    final.content.forEach((block, index) => {
      if (block.type === "text") {
        events.push({ type: "text_start", contentIndex: index, partial: final });
        events.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: final });
        events.push({ type: "text_end", contentIndex: index, content: block.text, partial: final });
      } else if (block.type === "toolCall") {
        events.push({ type: "toolcall_start", contentIndex: index, partial: final });
        events.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: final });
      }
    });
    events.push({ type: "done", reason: final.stopReason === "toolUse" ? "toolUse" : "stop", message: final });
  });
  return events;
}

describe("运行时：ask_user 让这一轮停在提问上", () => {
  it("调用后不再请求模型、照常算完成；下一轮作答接在工具结果后面", async () => {
    const contexts: Context[] = [];
    const runtime = await createPiConversationRuntime({ peopleDirectory: loadPeopleDirectory(testEnv),
      baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      streamSimple: (_model, context) => {
        contexts.push({ systemPrompt: context.systemPrompt, tools: context.tools, messages: structuredClone(context.messages) });
        if (contexts.length === 1) return stream(message([{ type: "text", text: "先定一件事。" },
          { type: "toolCall", id: "ask-1", name: "ask_user", arguments: { questions: [{ question: "按哪个口径？",
            options: [{ label: " 合同额 ", recommended: true }, { label: "回款", recommended: true }] }] } }], "toolUse"));
        return stream(message([{ type: "text", text: "按合同额算。" }], "stop"));
      } });
    const cards: unknown[] = [];
    const base = { scope: "global" as const, viewer: { personId: "person-fixture-002", displayName: "测试乙", role: "member" as const },
      currentObject: null, referencesSnapshot: [], signal: new AbortController().signal, emit: () => undefined,
      ask: (questions: TAskUserInput["questions"]) => {
        const card = { kind: "questions" as const, askId: randomUUID(), questions: questions.map((question, index) => ({ id: `q${index + 1}`, ...question })) };
        cards.push(card);
        return card;
      } };
    try {
      const first = await runtime.run({ ...base, message: "这个月业绩怎么算", runtimeEntries: [], piSessionId: randomUUID() });
      expect(contexts).toHaveLength(1);
      expect(contexts[0].systemPrompt).toContain("用 ask_user 提问");
      expect(contexts[0].tools?.map((tool) => tool.name)).toContain("ask_user");
      expect(first.assistantMessage).toBe("先定一件事。");
      // 推荐只认第一个，选项去掉首尾空白。
      expect(cards).toEqual([expect.objectContaining({ questions: [{ id: "q1", question: "按哪个口径？", options: [{ label: "合同额", recommended: true }, { label: "回款" }] }] })]);

      const second = await runtime.run({ ...base, message: "（回答你上一轮的提问）\n1. 按哪个口径？\n答：合同额（采纳推荐）",
        runtimeEntries: first.runtimeEntries, piSessionId: first.piSessionId! });
      expect(second.assistantMessage).toBe("按合同额算。");
      const roles = contexts[1].messages.map((item) => item.role);
      expect(roles.slice(-3)).toEqual(["assistant", "toolResult", "user"]);
      expect(JSON.stringify(contexts[1].messages.at(-2))).toContain("已把 1 个问题交给本人作答");
    } finally { await runtime.close?.(); }
  });
});
