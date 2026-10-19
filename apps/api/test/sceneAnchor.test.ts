import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { createObjectMaterial, editObjectMaterial } from "../src/objectMaterials.js";
import { ANCHOR_REF_ENTRY, createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { ANCHOR_BUDGET_BYTES, composeTurnContext, injectTurnContext } from "../src/turnContext.js";
import { planCompaction, summaryPromptFor } from "../src/conversationCompaction.js";
import type { AnchorView } from "../src/conversationAnchor.js";
import { createTestApp, testEnv, type TestApp } from "./helpers.js";

/**
 * 场景锚点（PR #12 Anchor 层移植到 main）：每轮带上本人所在页面与聚焦的卡，read_anchor 按当前权限展开；
 * 默认焦点只有一个来源（锚点聚焦的卡），三层取用的默认范围与 anchor.range 一致。
 */
type RunInput = Parameters<ConversationRuntime["run"]>[0];
const recorder = (turns: RunInput[], check?: (input: RunInput) => Promise<void>): ConversationRuntime => ({
  async run(input) {
    turns.push(input);
    await check?.(input);
    return { assistantMessage: "已理解", runtimeEntries: [] };
  },
});

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

describe("场景锚点：HTTP 入口", () => {
  it("首页聚焦本人选中的卡：目录来自同一份首页投影，原话不变；旧版本标 stale，不在页面上的 404", async () => {
    const turns: RunInput[] = [];
    t = await createTestApp({}, recorder(turns));
    const cookie = await t.loginCookie();
    const issue = await t.createIssue();
    const cards = (await t.app.inject({ url: "/api/cards/home", headers: { cookie } })).json().cards as { id: string; title: string }[];
    const post = (anchorSelection?: { cardId: string; version: number }) => t!.app.inject({ method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie, origin: t!.publicOrigin }, payload: { message: "解释当前项", ...(anchorSelection ? { anchorSelection } : {}) } });

    expect((await post({ cardId: issue.id, version: issue.version })).statusCode).toBe(200);
    const anchor = turns[0].anchor!;
    expect(anchor.view).toMatchObject({ scene: "公司首页", focus: { handle: "A1", title: issue.title }, period: expect.any(String), range: expect.any(String) });
    expect(anchor.view.focus).not.toHaveProperty("stale");
    expect(anchor.view.items[0].title).toBe(issue.title);
    expect(cards.map((card) => card.title)).toContain(issue.title);
    expect(turns[0].message).toBe("解释当前项");
    expect(await anchor.read({ handle: "A1" })).toMatchObject({ title: issue.title, meaning: "当前页面内容" });
    expect(JSON.stringify(await anchor.read({ handle: "A1" }))).not.toContain(issue.objectRef.id);

    expect((await post({ cardId: issue.id, version: issue.version + 5 })).statusCode).toBe(200);
    expect(turns[1].anchor!.view.focus).toMatchObject({ title: issue.title, stale: true });

    const missing = await post({ cardId: "issue:11111111-1111-4111-8111-111111111111", version: 1 });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("ANCHOR_NOT_FOUND");
    expect(turns).toHaveLength(2);

    // 没有选中项：首页不聚焦。
    expect((await post()).statusCode).toBe(200);
    expect(turns[2].anchor!.view.focus).toBeUndefined();
    const history = (await t.app.inject({ url: "/api/conversations/global/messages", headers: { cookie } })).json();
    expect(history.messages[0].content).toBe("解释当前项");
  });

  it("目录只含本人能看的页面项，分页取全；成员看不到 CEO 首页的议题", async () => {
    let ceoItems = 0;
    let checkedMember = false;
    const turns: RunInput[] = [];
    t = await createTestApp({}, recorder(turns, async (input) => {
      expect(input.anchor!.view.items.length).toBeLessThanOrEqual(12);
      expect(Buffer.byteLength(JSON.stringify(input.anchor!.view))).toBeLessThanOrEqual(ANCHOR_BUDGET_BYTES);
      if (input.viewer.role === "member") {
        expect(input.anchor!.view.scene).toBe("我的工作台");
        expect(JSON.stringify(input.anchor!.view)).not.toContain("CEO独有议题");
        expect(await input.anchor!.read({ handle: "A999" })).toMatchObject({ unavailable: true });
        checkedMember = true;
        return;
      }
      let page = await input.anchor!.read({}) as { items: unknown[]; cursor?: string };
      ceoItems = page.items.length;
      while (page.cursor) {
        page = await input.anchor!.read({ cursor: page.cursor }) as typeof page;
        ceoItems += page.items.length;
      }
      expect(await input.anchor!.read({ cursor: "bogus:index:1" })).toMatchObject({ unavailable: true });
    }));
    const ceo = await t.loginCookie();
    const member = await t.memberCookie();
    for (let index = 0; index < 14; index++) await t.createIssue({ title: `CEO独有议题${index}` });
    for (const cookie of [ceo, member]) expect((await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie, origin: t.publicOrigin }, payload: { message: "当前页面有什么" } })).statusCode).toBe(200);
    const cards = (await t.app.inject({ url: "/api/cards/home", headers: { cookie: ceo } })).json().cards;
    expect(ceoItems).toBe(cards.length);
    expect(turns[0].anchor!.view.more).toBe(true);
    expect(checkedMember).toBe(true);
  });

  it("成员工作台的锚点带上本人参与的战场，展开能读到本月目标状态", async () => {
    let seen = false;
    t = await createTestApp({}, recorder([], async (input) => {
      const item = input.anchor!.view.items.find((entry) => entry.title === "成员独有战场")!;
      expect(item).toMatchObject({ kind: "battlefield" });
      expect(JSON.stringify(await input.anchor!.read({ handle: item.handle }))).toContain("monthTargetState");
      seen = true;
    }));
    const ceo = await t.loginCookie();
    expect((await t.app.inject({ method: "POST", url: "/api/config/battlefields", headers: { cookie: ceo, origin: t.publicOrigin },
      payload: { code: "99", sortOrder: 990, name: "成员独有战场", ownerId: "person-fixture-002", sixMonthOutcome: "长期方向" } })).statusCode).toBe(201);
    const member = await t.memberCookie();
    expect((await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie: member, origin: t.publicOrigin },
      payload: { message: "解释我的目标" } })).statusCode).toBe(200);
    expect(seen).toBe(true);
  });

  it("正在看的材料在本轮里被改了：展开给最新内容并标 changed，不当成本轮开始时那一版", async () => {
    let changeMaterial: () => Promise<unknown> = async () => undefined;
    let checked = false;
    t = await createTestApp({}, recorder([], async (input) => {
      expect(input.anchor!.view).toMatchObject({ scene: "议题详情", focus: { handle: "A1" } });
      expect(await input.anchor!.read({ handle: "A1" })).not.toHaveProperty("changed");
      await changeMaterial();
      const expanded = await input.anchor!.read({ handle: "A1" }) as { changed?: boolean; viewingMaterial?: string };
      expect(expanded.changed).toBe(true);
      expect(expanded.viewingMaterial).toContain("当前材料");
      checked = true;
    }));
    const cookie = await t.loginCookie();
    const issue = await t.createIssue();
    const ref = { objectType: "issue" as const, objectId: issue.objectRef.id };
    const viewer = { personId: "person-fixture-001", role: "ceo" as const, displayName: "测试甲" };
    const material = await createObjectMaterial(t.pool, ref, viewer, "当前材料", "原版", "创建", null);
    changeMaterial = () => editObjectMaterial(t!.pool, ref, material.id, viewer, 1, [{ find: "原版", replace: "新版" }], "更新", null);
    expect((await t.app.inject({ method: "POST", url: `/api/conversations/issue:${ref.objectId}/messages`, headers: { cookie, origin: t.publicOrigin },
      payload: { message: "解释这份材料", viewingMaterialId: material.id } })).statusCode).toBe(200);
    expect(checked).toBe(true);
  });

  it("默认焦点只有一个来源：首页聚焦战场卡时，三层取用默认按这个战场读，anchor.range 写的也是它", async () => {
    const turns: RunInput[] = [];
    let readScope: string | undefined;
    t = await createTestApp({}, recorder(turns, async (input) => {
      readScope = (await input.companyMap!.readMissionCards({}) as { scope: string }).scope;
    }));
    const cookie = await t.loginCookie();
    const cards = (await t.app.inject({ url: "/api/cards/home", headers: { cookie } })).json().cards as { id: string; version: number; kind: string; title: string }[];
    const battlefield = cards.find((card) => card.kind === "battlefield")!;
    expect((await t.app.inject({ method: "POST", url: "/api/conversations/global/messages", headers: { cookie, origin: t.publicOrigin },
      payload: { message: "这个战场本月怎么样", anchorSelection: { cardId: battlefield.id, version: battlefield.version } } })).statusCode).toBe(200);
    const turn = turns[0];
    expect(turn.anchor!.view.focus).toMatchObject({ title: battlefield.title });
    expect(turn.anchor!.view.range).toContain(battlefield.title);
    expect(readScope).toBe(turn.anchor!.view.range);
    expect(turn).not.toHaveProperty("focus");
  });
});

describe("composeTurnContext / injectTurnContext", () => {
  const view = (items: number, summary = "摘要"): AnchorView => ({ scene: "公司首页", focus: { handle: "A1", title: "聚焦项" }, summary: "当前可见",
    items: Array.from({ length: items }, (_, index) => ({ handle: `A${index + 1}`, kind: "issue", title: `第${index + 1}项`, state: "pending", meaning: "当前页面内容" as const, summary })),
    more: false });

  it("anchor 在最前、本人原话在最后，没有值的段不出现", () => {
    const packed = JSON.parse(composeTurnContext({ anchor: view(2), message: "原话", parts: { currentObject: null, references: [], personalMemory: undefined, answerMode: "快答" } }));
    expect(Object.keys(packed)).toEqual(["anchor", "currentObject", "references", "answerMode", "message"]);
    expect(packed.message).toBe("原话");
    expect(JSON.parse(composeTurnContext({ message: "没有锚点", parts: {} }))).toEqual({ message: "没有锚点" });
  });

  it("锚点超出预算时只留聚焦项并标 more，其余用 read_anchor 展开", () => {
    const packed = JSON.parse(composeTurnContext({ anchor: view(12, "长".repeat(400)), message: "原话", parts: {} }));
    expect(packed.anchor.items.map((item: { handle: string }) => item.handle)).toEqual(["A1"]);
    expect(packed.anchor.more).toBe(true);
  });

  it("只换本次请求的副本：本轮用户消息换成带锚点的那份，本轮 / 上一轮的 read_anchor 结果按调用 id 换回正文；别的系统提示放行，找不到本轮消息就不发", () => {
    const marker = (id: string) => ({ role: "toolResult" as const, toolCallId: id, toolName: "read_anchor", content: [{ type: "text" as const, text: "（标记）" }], isError: false, timestamp: 1 });
    const context: Context = { systemPrompt: "主对话", messages: [
      { role: "user", content: "上一轮", timestamp: 1 }, marker("old"),
      { role: "user", content: [{ type: "text", text: "存下的那条" }], timestamp: 2 }, marker("now"),
    ] };
    const body = (text: string) => ({ toolName: "read_anchor", content: [{ type: "text" as const, text }] });
    const turn = { systemPrompt: "主对话", prompt: "存下的那条", live: "带锚点的那条", toolResults: new Map([["now", body("本轮正文")]]), resumed: new Map([["old", body("读回的正文")]]) };
    const sent = injectTurnContext(context, turn);
    expect(sent.messages.map((entry) => JSON.stringify(entry.content))).toEqual([
      JSON.stringify("上一轮"), JSON.stringify([{ type: "text", text: "读回的正文" }]),
      JSON.stringify([{ type: "text", text: "带锚点的那条" }]), JSON.stringify([{ type: "text", text: "本轮正文" }]),
    ]);
    expect(JSON.stringify(context.messages)).not.toContain("正文");
    expect(JSON.stringify(injectTurnContext({ ...context, systemPrompt: "主对话\nCurrent working directory: /app" }, turn).messages)).toContain("带锚点的那条");
    expect(injectTurnContext({ ...context, systemPrompt: "后台压缩" }, turn)).toEqual({ ...context, systemPrompt: "后台压缩" });
    expect(() => injectTurnContext({ ...context, messages: context.messages.slice(0, 2) }, turn)).toThrow(expect.objectContaining({ code: "TURN_CONTEXT_MISSING" }));
  });
});

// ───────────── 端到端：真实 Pi 运行时 + 脚本化模型 ─────────────
const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
  ({ role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-light", content, usage, stopReason, timestamp: Date.now() });
function stream(final: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    if (final.stopReason === "error") { events.push({ type: "error", reason: "error", error: final }); return; }
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
const textOf = (entry: Context["messages"][number] | undefined) => !entry || entry.role === "assistant" ? ""
  : typeof entry.content === "string" ? entry.content : entry.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
const count = (text: string, part: string) => text.split(part).length - 1;
function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}

/** 执行事项页：完成标准写得很长，标记放在末尾——锚点目录摘要（280 字节）里看不到，只在页面对象与 read_anchor 展开里。 */
async function taskPage(options: { fail?: () => boolean } = {}) {
  const contexts: Context[] = [];
  const runtime = await createPiConversationRuntime({ peopleDirectory: loadPeopleDirectory(testEnv),
    baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light", recoverySleep: async () => undefined,
    streamSimple: (_model, context) => {
      contexts.push({ systemPrompt: context.systemPrompt, tools: context.tools, messages: structuredClone(context.messages) });
      if (context.messages.at(-1)?.role === "toolResult") {
        if (options.fail?.()) return stream({ ...message([], "error"), errorMessage: "400 invalid_request_error: upstream rejected" });
        return stream(message([{ type: "text", text: "这件事在等对接" }], "stop"));
      }
      return stream(message([{ type: "toolCall", id: `anchor-${contexts.length}`, name: "read_anchor", arguments: { handle: "A1" } }], "toolUse"));
    } });
  t = await createTestApp({}, runtime);
  const member = await t.memberCookie();
  const headers = { cookie: member, origin: t.publicOrigin };
  const created = await t.app.inject({ method: "POST", url: "/api/me/tasks", headers,
    payload: { clientId: randomUUID(), title: "把锚点接进主对话", missionId: null, startDate: "2026-10-10", dueDate: "2026-10-12" } });
  const task = created.json() as { id: string; version: number };
  const setDone = async (tail: string, version: number) => (await t!.app.inject({ method: "PATCH", url: `/api/me/tasks/${task.id}`, headers,
    payload: { version, doneDefinition: `${"先把执行事项页的锚点接上，再看首页。".repeat(12)}${tail}` } })).json() as { version: number };
  const updated = await setDone("卡点：等人豪评审", task.version);
  const ask = (payload: Record<string, unknown>) => t!.app.inject({ method: "POST", url: `/api/conversations/task:${task.id}/messages`,
    headers: { ...headers, accept: "text/event-stream" }, payload });
  return { contexts, task: { ...task, version: updated.version }, ask, setDone, scope: `task:${task.id}` };
}

describe("端到端：在执行事项页发问（锚点临时注入）", () => {
  it("模型拿到这件事项的锚点并用 read_anchor 读回正文；历史行、压缩输入里都没有锚点正文；同页再问时锚点只注入一次、历史引用只记一次", async () => {
    const { contexts, task, ask, scope } = await taskPage();
    const first = await ask({ message: "这件事现在卡在哪" });
    expect(first.statusCode).toBe(200);
    const events = parseSse(first.body);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "step", label: "读当前页面" })]));

    // 发给模型的：本轮用户消息带锚点与页面对象，read_anchor 结果是正文。
    expect(contexts[0].tools?.map((tool) => tool.name)).toContain("read_anchor");
    const pack = JSON.parse(textOf(contexts[0].messages.findLast((entry) => entry.role === "user")));
    expect(pack.anchor).toMatchObject({ scene: "执行事项详情", focus: { handle: "A1", title: "把锚点接进主对话" }, range: expect.stringContaining("10 月") });
    expect(pack.currentObject.payload.task.doneDefinition).toContain("等人豪评审");
    expect(Object.keys(pack).at(-1)).toBe("message");
    expect(pack.message).toBe("这件事现在卡在哪");
    const result = contexts[1].messages.at(-1)!;
    expect(result).toMatchObject({ role: "toolResult", toolName: "read_anchor", isError: false });
    expect(JSON.parse(textOf(result))).toMatchObject({ handle: "A1", title: "把锚点接进主对话" });
    expect(JSON.parse(textOf(result)).text).toContain("等人豪评审");
    expect(textOf(result)).not.toContain(task.id);

    // 存下来的：Pi entries 与 conversation_messages 里都没有锚点正文，只有轻量引用。
    const state = await t!.conversationState(scope);
    const stored = JSON.stringify(state.runtimeEntries);
    for (const body of ["等人豪评审", "把锚点接进主对话"]) {
      expect(stored).not.toContain(body);
      expect(JSON.stringify(state.messages)).not.toContain(body);
    }
    const refs = (state.runtimeEntries as { type?: string; customType?: string; data?: { ref?: { focus?: string } } }[])
      .filter((entry) => entry.type === "custom" && entry.customType === ANCHOR_REF_ENTRY);
    expect(refs.map((entry) => entry.data?.ref?.focus)).toEqual([`task:${task.id}@${task.version}`]);
    expect(stored).toContain(`"anchorRef":{"cardId":"task:${task.id}","version":${task.version}}`);

    // 同一页面再问：这次请求里锚点只有一份，上一轮的锚点与展开正文都不在；历史引用没变就不再记。
    expect((await ask({ message: "那下一步呢" })).statusCode).toBe(200);
    const second = contexts[2].messages.map(textOf).join("\n");
    expect(count(second, "\"scene\":\"执行事项详情\"")).toBe(1);
    expect(count(second, "等人豪评审")).toBe(1);
    const after = await t!.conversationState(scope);
    expect((after.runtimeEntries as { customType?: string }[]).filter((entry) => entry.customType === ANCHOR_REF_ENTRY)).toHaveLength(1);

    // 压缩的输入（后台压缩从存下的 entries 拼）里也没有。
    const plan = planCompaction(after.runtimeEntries, after.piSessionId!, { force: true, keepRecentTokens: 0, minFoldTokens: 0 });
    expect(plan).not.toHaveProperty("skip");
    const summaryInput = summaryPromptFor(plan as Exclude<typeof plan, { skip: string }>);
    expect(summaryInput).toContain("这件事现在卡在哪");
    for (const body of ["等人豪评审", "执行事项详情"]) expect(summaryInput).not.toContain(body);
  });

  it("「继续」：按历史里的引用重新读上一轮展开过的卡，版本变了按当前版本并标 changed，锚点照常注入", async () => {
    let failing = true;
    const { contexts, task, ask, setDone } = await taskPage({ fail: () => failing });
    const first = await ask({ message: "这件事现在卡在哪" });
    const error = parseSse(first.body).find((event) => event.type === "error")!;
    expect(error).toMatchObject({ runId: expect.any(String) });
    expect(contexts.some((context) => JSON.stringify(context.messages).includes("等人豪评审"))).toBe(true);

    await setDone("卡点：改成等 CEO 签字", task.version);
    failing = false;
    const before = contexts.length;
    const resumed = await ask({ message: "继续", resumeRunId: error.runId });
    expect(resumed.statusCode).toBe(200);
    expect(parseSse(resumed.body).at(-1)).toMatchObject({ type: "done", status: "completed" });
    const request = contexts[before];
    const pack = JSON.parse(textOf(request.messages.findLast((entry) => entry.role === "user")));
    expect(pack.anchor.focus).toMatchObject({ title: "把锚点接进主对话", changed: true });
    expect(pack.resume).toEqual(expect.any(String));
    const reread = request.messages.find((entry) => entry.role === "toolResult" && entry.toolName === "read_anchor")!;
    expect(JSON.parse(textOf(reread))).toMatchObject({ changed: true, title: "把锚点接进主对话" });
    expect(JSON.parse(textOf(reread)).text).toContain("改成等 CEO 签字");
    expect(JSON.stringify(request.messages)).not.toContain("等人豪评审");
  });
});
