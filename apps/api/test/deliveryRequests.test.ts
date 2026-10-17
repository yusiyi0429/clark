import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TPrepareRequestQuestionResponse, TRequestView } from "@warmap/contracts";
import { hashSecret } from "../src/session.js";
import type { RequestAgent } from "../src/delivery/requestAgent.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

// ⑨ 传话：发起人（CEO 测试甲）发给测试乙、测试丙；测试丁不是接收人。
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "8642" } as const;
const FOURTH = { personId: "person-fixture-004", loginId: "ceshid", passcode: "9753" } as const;
const SCREENSHOT_QUESTION = "截图是直接贴进表格，还是存云盘、贴链接？";

/** 假 Agent：第一次起草问一处歧义；查答案时只认「截图」这一类问题；起草回答固定一句。 */
const agent: RequestAgent = {
  async draft(input) {
    const answered = input.clarifications.find((item) => item.question === SCREENSHOT_QUESTION)?.answer;
    return {
      title: "填备案信息表",
      body: `财务在收集备案信息。请在备案信息表里填产品介绍和截图。${answered ? `截图：${answered}。` : ""}`,
      recipientIds: [TEST_MEMBER.personId, THIRD.personId, "person-not-in-directory"],
      questions: answered ? [] : [SCREENSHOT_QUESTION],
    };
  },
  async lookup(input) {
    const hit = input.question.includes("截图") ? input.answered.find((item) => item.question.includes("截图")) : undefined;
    return { match: hit ? "question" : "none", quote: null, questionId: hit?.questionId ?? null, question: `备案信息表：${input.question}` };
  },
  async answer() { return { answer: "存云盘，贴链接" }; },
};

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "warmap-requests-test-"));
  const seed = join(dir, "people.json");
  await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: THIRD.personId, displayName: "测试丙", roles: ["dri", "participant"] },
    { personId: FOURTH.personId, displayName: "测试丁", roles: ["dri", "participant"] },
  ] }));
  t = await createTestApp({ companyPeopleSeed: seed }, undefined, { requestAgent: agent });
  for (const who of [THIRD, FOURTH]) {
    await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [who.personId, who.loginId, hashSecret(who.passcode)]);
  }
  const app = t.app, origin = t.publicOrigin;
  const login = async (who: { loginId: string; passcode: string }) => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { loginId: who.loginId, passcode: who.passcode } });
    expect(res.statusCode).toBe(200);
    return (res.headers["set-cookie"] as string).split(";")[0];
  };
  const cookies = { ceo: await t.loginCookie(), b: await t.memberCookie(), c: await login(THIRD), d: await login(FOURTH) };
  type Who = keyof typeof cookies;
  const call = (who: Who, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie: cookies[who], origin }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const get = async (who: Who, id: string) => call(who, "GET", `/api/requests/${id}`);
  const view = async (who: Who, id: string) => {
    const res = await get(who, id);
    expect(res.statusCode).toBe(200);
    return (res.json() as { request: TRequestView }).request;
  };
  const act = (who: Who, request: TRequestView, actionType: string, input?: unknown, itemId?: string) => {
    const action = request.actions.find((candidate) => candidate.actionType === actionType && (itemId === undefined || candidate.itemId === itemId));
    expect(action, `${who} 应能 ${actionType}`).toBeDefined();
    return call(who, "POST", "/api/requests/actions/execute", { actionId: action!.actionId, ...(input === undefined ? {} : { input }) });
  };
  /** 起草 → 回答歧义 → 发给乙和丙；返回发出时的视图。 */
  const sendToBoth = async () => {
    const first = (await call("ceo", "POST", "/api/requests/draft", { prompt: "让乙和丙把备案信息表里产品那部分填了" })).json() as { request: TRequestView };
    const second = (await call("ceo", "POST", "/api/requests/draft", { prompt: first.request.prompt, requestId: first.request.id,
      clarifications: [{ question: SCREENSHOT_QUESTION, answer: "存云盘，贴链接" }] })).json() as { request: TRequestView };
    const sent = await act("ceo", second.request, "request.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId] });
    expect(sent.statusCode).toBe(200);
    return (sent.json() as { request: TRequestView }).request;
  };
  const notifications = async (who: Who) =>
    ((await call(who, "GET", "/api/me/notifications")).json() as { notifications: { kind: string; objectId: string; readAt: string | null; text: string }[] }).notifications;
  return { call, get, view, act, sendToBoth, notifications };
}

describe("送达通道 ⑨ 传话", () => {
  it("发出去的就是预览的那一版：歧义没回答不能发，旧版本的发送令牌作废，重放不重复送达", async () => {
    const { call, view, act, notifications } = await setup();
    const drafted = await call("ceo", "POST", "/api/requests/draft", { prompt: "让乙和丙把备案信息表里产品那部分填了" });
    expect(drafted.statusCode).toBe(200);
    const v1 = (drafted.json() as { request: TRequestView; steps: { label: string; status: string }[] });
    expect(v1.steps.map((item) => [item.label, item.status])).toEqual([["起草请求", "done"], ["查歧义", "done"], ["等你确认", "current"]]);
    expect(v1.request).toMatchObject({ status: "draft", version: 1, clarifications: [{ question: SCREENSHOT_QUESTION, answer: null }] });
    // 不在人员目录里的候选被丢掉，发起人自己不在可选名单里。
    expect(v1.request.candidates.map((person) => person.personId)).toEqual([TEST_MEMBER.personId, THIRD.personId]);
    expect(v1.request.directory.map((person) => person.personId)).not.toContain(TEST_CEO.personId);

    const pending = await act("ceo", v1.request, "request.send", { recipientIds: [TEST_MEMBER.personId] });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ code: "REQUEST_CLARIFICATION_PENDING" });

    const v2 = ((await call("ceo", "POST", "/api/requests/draft", { prompt: v1.request.prompt, requestId: v1.request.id,
      clarifications: [{ question: SCREENSHOT_QUESTION, answer: "存云盘，贴链接" }] })).json() as { request: TRequestView }).request;
    expect(v2).toMatchObject({ id: v1.request.id, version: 2, clarifications: [{ question: SCREENSHOT_QUESTION, answer: "存云盘，贴链接" }] });
    expect(v2.body).toContain("截图：存云盘，贴链接");

    const stale = await act("ceo", v1.request, "request.send", { recipientIds: [TEST_MEMBER.personId] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
    const outsider = await act("ceo", v2, "request.send", { recipientIds: ["person-not-in-directory"] });
    expect(outsider.statusCode).toBe(400);

    const sent = await act("ceo", v2, "request.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId] });
    expect(sent.statusCode).toBe(200);
    const replay = await act("ceo", v2, "request.send", { recipientIds: [TEST_MEMBER.personId, THIRD.personId] });
    expect(replay.statusCode).toBe(200);

    const received = await view("b", v2.id);
    expect({ title: received.title, body: received.body, version: received.version }).toEqual({ title: v2.title, body: v2.body, version: v2.version });
    expect(received.status).toBe("open");
    expect(received.recipients.map((person) => [person.displayName, person.status])).toEqual([["测试乙", "pending"], ["测试丙", "pending"]]);
    expect(received.actions.map((action) => action.actionType).sort()).toEqual(["request.ask", "request.mark_done"]);
    const inbox = (await notifications("c")).filter((item) => item.kind === "request_received");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].text).toBe("测试甲请你：填备案信息表");
  });

  it("问过的直接答；回答补进说明后所有接收人都看得到", async () => {
    const { call, view, act, sendToBoth, notifications } = await setup();
    const sent = await sendToBoth();

    const first = await call("b", "POST", `/api/requests/${sent.id}/questions/prepare`, { question: "截图放哪" });
    expect(first.statusCode).toBe(200);
    const prepared = first.json() as TPrepareRequestQuestionResponse;
    expect(prepared.answer).toBeNull();
    expect(prepared.steps.map((item) => [item.label, item.status])).toEqual([["定位待办", "done"], ["查有没有人问过", "done"], ["整理问题", "done"], ["等你确认", "current"]]);
    expect(prepared.question).toBe("备案信息表：截图放哪");
    // 准备阶段不写库：确认前发起人收不到任何问题。
    expect(await call("ceo", "GET", `/api/requests/${sent.id}`).then((res) => (res.json() as { request: TRequestView }).request.questions)).toHaveLength(0);

    const asked = await act("b", await view("b", sent.id), "request.ask", { question: prepared.question });
    expect(asked.statusCode).toBe(200);
    const atInitiator = await view("ceo", sent.id);
    const question = atInitiator.questions[0];
    expect(question).toMatchObject({ askerName: "测试乙", question: "备案信息表：截图放哪", answer: null, mergedIntoBody: false });

    const draft = await call("ceo", "POST", `/api/requests/${sent.id}/questions/${question.id}/answer-draft`);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ answer: "存云盘，贴链接", steps: [{ label: "读问题" }, { label: "起草回答" }, { label: "等你确认", status: "current" }] });
    // 起草不等于发出：接收人还看不到答案，也看不到草稿。
    const beforeConfirm = await view("b", sent.id);
    expect(beforeConfirm.questions[0]).toMatchObject({ answer: null, answerDraft: null });
    expect((await view("ceo", sent.id)).questions[0].answerDraft).toBe("存云盘，贴链接");

    const answered = await act("ceo", await view("ceo", sent.id), "request.answer", { answer: "存云盘，贴链接，链接贴在表格最后一栏" }, question.id);
    expect(answered.statusCode).toBe(200);
    expect((answered.json() as { request: TRequestView }).request.version).toBe(sent.version + 1);
    for (const who of ["b", "c"] as const) {
      const seen = await view(who, sent.id);
      expect(seen.body).toContain("**补充 · 备案信息表：截图放哪**\n存云盘，贴链接，链接贴在表格最后一栏");
      expect(seen.questions[0]).toMatchObject({ answer: "存云盘，贴链接，链接贴在表格最后一栏", mergedIntoBody: true });
    }
    expect((await notifications("b")).map((item) => item.kind)).toContain("request_answered");

    // 丙问同一类问题：第二步就停下，直接给出库里那条答案，不再发给发起人。
    const again = (await call("c", "POST", `/api/requests/${sent.id}/questions/prepare`, { question: "截图要怎么交" })).json() as TPrepareRequestQuestionResponse;
    expect(again.answer).toEqual({ source: "question", text: "存云盘，贴链接，链接贴在表格最后一栏", questionId: question.id });
    expect(again.steps.map((item) => item.status)).toEqual(["done", "done", "pending", "pending"]);
    expect(again.steps[1].result).toBe("已有人问过，测试甲答过");
    expect((await view("ceo", sent.id)).questions).toHaveLength(1);
  });

  it("标记完成：本人那一行变完成并通知发起人，全部完成后请求关闭，重放不重复通知", async () => {
    const { view, act, sendToBoth, notifications, call } = await setup();
    const sent = await sendToBoth();
    const done = await act("b", await view("b", sent.id), "request.mark_done");
    expect(done.statusCode).toBe(200);
    const afterOne = (done.json() as { request: TRequestView }).request;
    expect(afterOne.status).toBe("open");
    expect(afterOne.viewer.myStatus).toBe("done");
    expect(afterOne.recipients.find((person) => person.personId === TEST_MEMBER.personId)).toMatchObject({ status: "done", doneByName: "测试乙" });
    expect(afterOne.actions).toEqual([]);

    const bView = await view("c", sent.id);
    expect(await act("c", bView, "request.mark_done").then((res) => res.statusCode)).toBe(200);
    expect(await act("c", bView, "request.mark_done").then((res) => res.statusCode)).toBe(200);
    const closed = await view("ceo", sent.id);
    expect(closed.status).toBe("done");
    // CEO 的通知栏不读 /api/me/notifications：通知照样落库，发出的列表用 unread 标出来。
    const doneNotices = await t!.sql("SELECT actor_id, read_at FROM notifications WHERE person_id = $1 AND kind = 'request_done' ORDER BY actor_id", [TEST_CEO.personId]);
    expect(doneNotices.map((row) => row.actor_id)).toEqual([TEST_MEMBER.personId, THIRD.personId]);
    // 发起人打开过这条请求，相关通知就算看过了。
    expect(doneNotices.every((row) => row.read_at !== null)).toBe(true);
    const sentBox = (await call("ceo", "GET", "/api/me/requests?box=sent")).json() as { items: { id: string; status: string; recipientsDone: number; unread: boolean }[] };
    expect(sentBox.items).toEqual([expect.objectContaining({ id: sent.id, status: "done", recipientsDone: 2, unread: false })]);
    // 成员发起时走成员通知列表：乙发给丙，丙完成后乙收到「完成了」。
    const own = ((await call("b", "POST", "/api/requests/draft", { prompt: "让丙把截图补上" })).json() as { request: TRequestView }).request;
    const ownV2 = ((await call("b", "POST", "/api/requests/draft", { prompt: own.prompt, requestId: own.id,
      clarifications: [{ question: SCREENSHOT_QUESTION, answer: "直接贴进表格" }] })).json() as { request: TRequestView }).request;
    expect((await act("b", ownV2, "request.send", { recipientIds: [THIRD.personId] })).statusCode).toBe(200);
    expect((await act("c", await view("c", own.id), "request.mark_done")).statusCode).toBe(200);
    const unreadSent = (await call("b", "GET", "/api/me/requests?box=sent")).json() as { items: { id: string; unread: boolean }[] };
    expect(unreadSent.items).toEqual([expect.objectContaining({ id: own.id, unread: true })]);
    expect((await notifications("b")).filter((item) => item.kind === "request_done").map((item) => item.text)).toEqual(["测试丙完成了：填备案信息表"]);
  });

  it("非接收人看不到这条请求，也不能借别人的令牌操作", async () => {
    const { call, get, view, act } = await setup();
    const draft = ((await call("ceo", "POST", "/api/requests/draft", { prompt: "让乙把备案信息表填了" })).json() as { request: TRequestView }).request;
    // 草稿只有发起人看得到。
    expect((await get("b", draft.id)).statusCode).toBe(404);
    const v2 = ((await call("ceo", "POST", "/api/requests/draft", { prompt: draft.prompt, requestId: draft.id,
      clarifications: [{ question: SCREENSHOT_QUESTION, answer: "直接贴进表格" }] })).json() as { request: TRequestView }).request;
    expect((await act("ceo", v2, "request.send", { recipientIds: [TEST_MEMBER.personId] })).statusCode).toBe(200);

    expect((await get("b", draft.id)).statusCode).toBe(200);
    expect((await get("d", draft.id)).statusCode).toBe(404);
    expect((await call("d", "POST", `/api/requests/${draft.id}/questions/prepare`, { question: "截图放哪" })).statusCode).toBe(404);
    expect(((await call("d", "GET", "/api/me/requests?box=inbox")).json() as { items: unknown[] }).items).toEqual([]);
    expect(((await call("b", "GET", "/api/me/requests?box=inbox")).json() as { items: { id: string; myStatus: string }[] }).items)
      .toEqual([expect.objectContaining({ id: draft.id, myStatus: "pending" })]);

    const markDone = (await view("b", draft.id)).actions.find((action) => action.actionType === "request.mark_done")!;
    const stolen = await call("d", "POST", "/api/requests/actions/execute", { actionId: markDone.actionId });
    expect(stolen.statusCode).toBe(404);
    expect((await view("b", draft.id)).viewer.myStatus).toBe("pending");
  });
});
