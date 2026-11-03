import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { TConversationHistory, TIssueDraftView } from "@warmap/contracts";
import { issueSuggestBlock } from "../src/issueDrafts.js";
import { TEST_CEO, TEST_MEMBER, createTestApp, type TestApp } from "./helpers.js";

/**
 * 首页走独立 Chat 时的转议题（11/02）：Chat 的 propose_issue 调 POST /internal/issue-drafts；
 * 天枢读首页历史时把建议卡补在那一轮回答末尾；接受时相关那段从 Chat 现读、复制进议题页，不写首页留痕。
 */
const TOKEN = "internal-chat-test";
const CONVERSATION = randomUUID();
const RUNS = Array.from({ length: 6 }, () => randomUUID());
const at = (index: number) => new Date(Date.UTC(2026, 10, 2, 1, index)).toISOString();

type ChatMessage = { position: string; role: "user" | "assistant"; text: string; runId: string; turnAt: string; attachments: [] };
/** Chat 里的这段对话：每一轮一问一答，第 i 轮问「问 i」答「答 i」。 */
const MESSAGES: ChatMessage[] = RUNS.flatMap((runId, index) => [
  { position: String(index * 2 + 1), role: "user" as const, text: `问 ${index}`, runId, turnAt: at(index), attachments: [] as [] },
  { position: String(index * 2 + 2), role: "assistant" as const, text: `答 ${index}`, runId, turnAt: at(index), attachments: [] as [] },
]);

/** 假 Chat：会话列表只有这一段；历史按游标分两页（第一页 5 条）。 */
async function fakeChat() {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED" } });
    if (req.method === "GET" && req.url === "/conversations") return send(200, { conversations: [{ conversationId: CONVERSATION, createdAt: at(0), updatedAt: at(9) }] });
    const page = /^\/conversations\/([^/]+)\/messages\?limit=\d+&cursor=(\d+)$/.exec(req.url ?? "");
    if (req.method === "GET" && page && page[1] === CONVERSATION) {
      const from = Number(page[2]);
      const messages = MESSAGES.filter((message) => Number(message.position) > from).slice(0, 5);
      const more = MESSAGES.some((message) => Number(message.position) > Number(messages.at(-1)?.position ?? Infinity));
      return send(200, { messages, runs: RUNS.map((runId) => ({ runId, status: "completed" })), nextCursor: more ? messages.at(-1)!.position : null });
    }
    send(404, { error: { code: "NOT_FOUND" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const BODY = {
  conversationId: CONVERSATION, explicit: false, topic: "渠道预算转向", turns: 3, title: "渠道预算是否转向华南", whyNow: "华南渠道窗口六月关闭，五月底前要定",
  formedIdeas: ["华东存量客户续约不能断"], options: [{ label: "六月前转向华南", tradeoff: "抢到窗口，但华东续约投入减少" }], openQuestions: ["华南转化样本够不够"],
};

/** 接受时提交的初稿（界面上改过的那份）。 */
const content = (title: string) => ({ title, whyNow: BODY.whyNow, formedIdeas: BODY.formedIdeas, options: BODY.options, openQuestions: BODY.openQuestions });

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function setup() {
  const chat = await fakeChat();
  const t: TestApp = await createTestApp({ internalChatToken: TOKEN, chatServiceUrl: chat.url });
  cleanup = async () => { await t.close(); await chat.close(); };
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const propose = async (body: Record<string, unknown>, person: string = TEST_CEO.personId, role = "ceo") => {
    const response = await t.app.inject({ method: "POST", url: "/internal/issue-drafts", payload: body,
      headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": person, "x-viewer-role": role } });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  const history = async (cookie: string, scope = "global") => {
    const response = await t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    return (response.json() as TConversationHistory).messages;
  };
  const draft = async (id: string, action: "accept" | "decline", payload?: unknown) => {
    const response = await t.app.inject({ method: "POST", url: `/api/issue-drafts/${id}/${action}`, headers: { cookie: ceo, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, view: response.statusCode === 200 ? (response.json() as { draft: TIssueDraftView }).draft : null, body: response.body };
  };
  return { t, ceo, member, propose, history, draft };
}

describe("首页走 Chat 时的转议题", () => {
  it("内部接口：轮数不够不提、明说要转时第一轮就提、一轮一条、同一话题的卡没处理不再提、说过不用的不再提、转过的不再提；只有 CEO 视角", async () => {
    const { t, propose, draft } = await setup();
    expect(await propose({ ...BODY, runId: RUNS[0], turns: 2 })).toMatchObject({ status: 200, body: { proposed: false, reason: "too_early" } });
    // 成员视角 403；请求体不对 400。
    expect((await propose({ ...BODY, runId: RUNS[0] }, TEST_MEMBER.personId, "member")).status).toBe(403);
    expect((await propose({ ...BODY, runId: "run-1" })).status).toBe(400);
    expect((await propose({ ...BODY, runId: RUNS[0], whyNow: undefined })).status).toBe(400);

    const [battlefield] = await t.sql("SELECT id, name FROM battlefield_config ORDER BY sort_order, code, id LIMIT 1");
    const first = await propose({ ...BODY, runId: RUNS[0], turns: 1, explicit: true, level: "battlefield", battlefieldName: battlefield.name });
    expect(first).toMatchObject({ status: 200, body: { proposed: true } });
    const draftId = first.body.draftId as string;
    expect((await t.sql("SELECT conversation_id, chat_conversation_id, run_id, start_sequence, turns, suggested_location FROM issue_drafts WHERE id = $1", [draftId]))[0])
      .toEqual({ conversation_id: null, chat_conversation_id: CONVERSATION, run_id: RUNS[0], start_sequence: null, turns: 1,
        suggested_location: { level: "battlefield", battlefieldId: battlefield.id } });
    // 同一轮再调拿回原来那条；同一段对话里同一话题的卡还没处理，下一轮不再提。
    expect((await propose({ ...BODY, runId: RUNS[0], explicit: true })).body).toMatchObject({ proposed: true, draftId });
    expect((await propose({ ...BODY, runId: RUNS[1] })).body).toMatchObject({ proposed: false, reason: "pending" });

    // 「不用」之后换个说法也不再提。
    expect((await draft(draftId, "decline")).view).toMatchObject({ status: "declined" });
    expect((await propose({ ...BODY, runId: RUNS[2], topic: "渠道预算转向华南", title: "渠道预算转不转向华南" })).body).toMatchObject({ proposed: false, reason: "declined" });

    // 转成议题之后同一话题不再提，并告诉 Chat 转到了哪个议题。
    const pricing = await propose({ ...BODY, runId: RUNS[3], topic: "定价策略", title: "定价策略要不要调", level: "company" });
    expect(pricing.body).toMatchObject({ proposed: true });
    const accepted = await draft(pricing.body.draftId as string, "accept", { mode: "new", draft: content("定价策略要不要调"), location: { level: "company" } });
    expect(accepted.status).toBe(200);
    expect((await propose({ ...BODY, runId: RUNS[4], topic: "定价策略", title: "定价策略要不要调" })).body)
      .toMatchObject({ proposed: false, reason: "transferred", issue: { id: accepted.view!.issue!.id, title: "定价策略要不要调" } });
  }, 120_000);

  it("一号位的首页历史里，建议卡补在那一轮的回答末尾；成员的不补", async () => {
    const { propose, history, ceo, member } = await setup();
    const { body } = await propose({ ...BODY, runId: RUNS[2] });
    const draftId = body.draftId as string;
    const home = await history(ceo);
    expect(home.map((message) => message.content)).toEqual(MESSAGES.map((message) =>
      (message.runId === RUNS[2] && message.role === "assistant" ? `${message.text}\n\n${issueSuggestBlock(draftId)}` : message.text)));
    expect((await history(member)).some((message) => message.content.includes("```issue-suggest"))).toBe(false);
  }, 120_000);

  it("接受：相关那几轮从 Chat 读来带进议题页，不写首页留痕；之后同一段对话再转，不越过已转出的那几轮", async () => {
    const { t, propose, history, ceo, draft } = await setup();
    const { body } = await propose({ ...BODY, runId: RUNS[3] });
    const accepted = await draft(body.draftId as string, "accept", { mode: "new", draft: content(BODY.title), location: { level: "company" } });
    expect(accepted.view).toMatchObject({ status: "accepted", issue: { title: BODY.title } });
    const issueId = accepted.view!.issue!.id;
    expect((await t.sql("SELECT file_name FROM object_materials WHERE object_type = 'issue' AND object_id = $1", [issueId]))[0].file_name).toBe("议题初稿.md");

    // 带过去的是第 1–3 轮（往前数 3 轮提问，到建议那一轮的回答为止），时间是 Chat 那一轮开始的时间。
    const carried = await history(ceo, `issue:${issueId}`);
    expect(carried.map((message) => [message.role, message.content, message.kind, message.runId, message.createdAt])).toEqual(
      MESSAGES.slice(2, 8).map((message) => [message.role, message.text, "carried", message.runId, message.turnAt]));
    expect((await t.sql("SELECT meta FROM conversation_messages WHERE run_id = $1 AND role = 'user'", [RUNS[3]]))[0].meta)
      .toEqual({ carriedFrom: { chatConversationId: CONVERSATION, runId: RUNS[3], position: "7" } });
    // 首页在 Chat 那边：天枢不建首页对话、不写留痕。
    expect(await t.sql("SELECT id FROM conversations WHERE scope = 'global'")).toEqual([]);
    expect((await t.sql("SELECT count(*)::int AS n FROM conversation_messages WHERE kind = 'trace'"))[0].n).toBe(0);
    // 首页历史里那张卡还在（卡自己画成「已转到议题」）。
    expect((await history(ceo)).find((message) => message.runId === RUNS[3] && message.role === "assistant")!.content).toContain("```issue-suggest");

    // 同一段对话里再转一件事接到这个议题：只带第 4、5 轮，不越过已经转出去的第 3 轮。
    const next = await propose({ ...BODY, runId: RUNS[5], topic: "华东续约", title: "华东续约怎么保", turns: 5 });
    expect((await draft(next.body.draftId as string, "accept", { mode: "existing", issueId })).status).toBe(200);
    expect((await history(ceo, `issue:${issueId}`)).slice(6).map((message) => message.content)).toEqual(["问 4", "答 4", "问 5", "答 5"]);
  }, 120_000);
});

describe("一号位打字确认转议题（Chat 的 decide_issue_draft）", () => {
  async function setupDecide() {
    const base = await setup();
    const decide = async (body: Record<string, unknown>, person: string = TEST_CEO.personId, role = "ceo") => {
      const response = await base.t.app.inject({ method: "POST", url: "/internal/issue-drafts/decide", payload: { conversationId: CONVERSATION, ...body },
        headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": person, "x-viewer-role": role } });
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    };
    const view = async (id: string) => ((await base.t.app.inject({ method: "GET", url: `/api/issue-drafts/${id}`, headers: { cookie: base.ceo } })).json() as { draft: TIssueDraftView }).draft;
    return { ...base, decide, view };
  }
  const locationOf = async (t: TestApp, issue: unknown) => (await t.sql("SELECT location FROM issues WHERE id = $1", [(issue as { id: string }).id]))[0].location;

  it("打字确认：和卡上点「开议题」一样建议题、带过去相关那几轮、存初稿材料；卡随之画成已转；再说确认或不用都拿回同一个议题", async () => {
    const { t, propose, history, ceo, decide, view } = await setupDecide();
    // 没有建议时 404；成员视角 403。
    expect(await decide({ decision: "accept" })).toMatchObject({ status: 404, body: { code: "NO_PENDING_DRAFT" } });
    expect((await decide({ decision: "accept" }, TEST_MEMBER.personId, "member")).status).toBe(403);

    const { body } = await propose({ ...BODY, runId: RUNS[3] });
    const draftId = body.draftId as string;
    const accepted = await decide({ decision: "accept", title: "渠道预算六月前转不转华南" });
    expect(accepted).toMatchObject({ status: 200, body: { decision: "accepted", draftId, issue: { title: "渠道预算六月前转不转华南" },
      note: "议题已建成；回答里一句话告诉一号位议题已经建好，可以去议题里接着聊" } });
    const issue = accepted.body.issue as { id: string; title: string; href: string };
    expect(issue.href).toBe(`/issues/${issue.id}`);
    expect(await locationOf(t, issue)).toMatchObject({ level: "company" });
    expect((await t.sql("SELECT file_name FROM object_materials WHERE object_type = 'issue' AND object_id = $1", [issue.id]))[0].file_name).toBe("议题初稿.md");
    expect((await history(ceo, `issue:${issue.id}`)).map((message) => [message.role, message.content, message.kind]))
      .toEqual(MESSAGES.slice(2, 8).map((message) => [message.role, message.text, "carried"]));
    // 首页那一轮的卡还在，按建议的状态画成「已转到议题」。
    expect((await history(ceo)).find((message) => message.runId === RUNS[3] && message.role === "assistant")!.content).toContain(issueSuggestBlock(draftId));
    expect(await view(draftId)).toMatchObject({ status: "accepted", issue: { id: issue.id, title: issue.title } });

    for (const decision of ["accept", "decline"]) {
      expect(await decide({ decision })).toMatchObject({ status: 200, body: { decision: "already_accepted", draftId, issue } });
    }
    expect((await t.sql("SELECT count(*)::int AS n FROM issues WHERE title = $1", [issue.title]))[0].n).toBe(1);
  }, 120_000);

  it("挂在哪：说了战场名按战场名找、说全局就挂全局、说的战场对不上 400；接到已有议题只在建议对上了已有议题时", async () => {
    const { t, propose, decide } = await setupDecide();
    const [battlefield] = await t.sql("SELECT id, name FROM battlefield_config ORDER BY sort_order, code, id LIMIT 1");

    await propose({ ...BODY, runId: RUNS[0], topic: "定价策略", title: "定价策略要不要调", explicit: true, level: "company" });
    expect(await decide({ decision: "accept", battlefieldName: "不存在的战场" })).toMatchObject({ status: 400, body: { code: "BATTLEFIELD_NOT_FOUND" } });
    expect(await decide({ decision: "accept", mode: "existing" })).toMatchObject({ status: 400, body: { code: "NO_MATCHED_ISSUE" } });
    const named = await decide({ decision: "accept", level: "battlefield", battlefieldName: battlefield.name });
    expect(named).toMatchObject({ status: 200, body: { decision: "accepted", issue: { title: "定价策略要不要调" } } });
    expect(await locationOf(t, named.body.issue)).toEqual({ level: "battlefield", battlefieldId: battlefield.id });

    // 建议挂在战场，一号位说放全局。
    await propose({ ...BODY, runId: RUNS[1], topic: "华东续约", title: "华东续约怎么保", explicit: true, level: "battlefield", battlefieldName: battlefield.name });
    const company = await decide({ decision: "accept", level: "company" });
    expect(company).toMatchObject({ status: 200, body: { decision: "accepted" } });
    expect(await locationOf(t, company.body.issue)).toMatchObject({ level: "company" });

    // 建议对上了已有议题：接到那个议题，不新建。
    const namedIssue = (named.body.issue as { id: string }).id;
    expect((await propose({ ...BODY, runId: RUNS[2], topic: "试点城市", title: "试点城市选哪几个", explicit: true, matchIssueId: namedIssue })).body).toMatchObject({ proposed: true });
    expect(await decide({ decision: "accept", mode: "existing" })).toMatchObject({ status: 200, body: { decision: "accepted", issue: { id: namedIssue } } });
  }, 120_000);

  it("打字说不用：记进不用名单、同一话题不再提；之后再说确认是 404", async () => {
    const { t, propose, decide, view } = await setupDecide();
    const { body } = await propose({ ...BODY, runId: RUNS[3] });
    const draftId = body.draftId as string;
    expect(await decide({ decision: "decline" })).toEqual({ status: 200, body: { decision: "declined", draftId, note: "这个话题记为不用转议题；一句话回应即可" } });
    expect(await view(draftId)).toMatchObject({ status: "declined", issue: null });
    expect((await t.sql("SELECT topic FROM issue_suggestion_declines WHERE draft_id = $1", [draftId]))[0].topic).toBe(BODY.topic);
    expect(await decide({ decision: "accept" })).toMatchObject({ status: 404, body: { code: "NO_PENDING_DRAFT" } });
    expect((await decide({ decision: "decline" })).body).toMatchObject({ decision: "declined", draftId });
    expect((await propose({ ...BODY, runId: RUNS[4] })).body).toMatchObject({ proposed: false, reason: "declined" });
  }, 120_000);
});
