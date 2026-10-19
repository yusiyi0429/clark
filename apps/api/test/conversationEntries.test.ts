import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationCard, ConversationSseEvent, type TConversationCard, type TRequestView } from "@warmap/contracts";
import { signActionId } from "../src/actionToken.js";
import type { ConversationRuntime } from "../src/conversations.js";
import type { RequestAgent } from "../src/delivery/requestAgent.js";
import type { MonthlyReviewAgents } from "../src/monthlyReviewService.js";
import type { PersonalReviewDraftInput } from "../src/personalReviews.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, testEnv, type TestApp } from "./helpers.js";
import { citedReview } from "./personalReviewFixtures.js";

/**
 * 对话里的一句话入口（conversationEntries.ts）：经过对话路由的完整一轮。
 * 假运行时代替主 Agent 调工具；送达通道与复盘生成用真实服务、假模型。本人是测试乙（成员）。
 */
const JUJIE = "person-fixture-003", RENHAO = "person-fixture-004";
const NOW = new Date("2026-09-30T02:00:00Z"); // 北京时间 9/30 10:00

type Entries = NonNullable<Parameters<ConversationRuntime["run"]>[0]["entries"]>;
type Turn = Parameters<ConversationRuntime["run"]>[0];

const lookups: { question: string; answered: number }[] = [];
const agent: RequestAgent = {
  async draft(input) {
    const answered = input.clarifications.find((item) => item.answer)?.answer;
    return { title: "补上周的周报数据", body: `请补上周的周报数据。${answered ? `交付：${answered}。` : ""}`,
      recipientIds: [RENHAO], questions: answered ? [] : ["数据直接填进周报表，还是另发一个文件？"] };
  },
  async lookup(input) {
    lookups.push({ question: input.question, answered: input.answered.length });
    const hit = input.answered.find((item) => item.question.includes("截图"));
    return { match: hit ? "question" : "none", quote: null, questionId: hit?.questionId ?? null, question: `备案信息表的截图栏：${input.question}` };
  },
  async answer() { return { answer: "贴链接" }; },
};

function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; lookups.length = 0; });

async function setup(options: { reviews?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "conversation-entries-test-"));
  const seed = join(dir, "people.json");
  await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: JUJIE, displayName: "唐巨杰", roles: ["dri", "participant"] },
    { personId: RENHAO, displayName: "刘人豪", roles: ["dri", "participant"] },
  ] }));
  let script: (entries: Entries, input: Turn) => Promise<unknown> = async () => undefined;
  const turns: Turn[] = [];
  const results: unknown[] = [];
  const runtime: ConversationRuntime = { async run(input) {
    turns.push(input);
    results.push(await script(input.entries!, input));
    input.emit({ type: "message", delta: "好" });
    return { assistantMessage: "好", runtimeEntries: input.runtimeEntries };
  } };
  const personalCalls: PersonalReviewDraftInput[] = [];
  const reviewAgents: MonthlyReviewAgents = {
    draft: { async generate() { throw new Error("不该起草复盘项"); } },
    assess: { async generate() { return { candidate: { overall: "符合证据", deviations: [], questions: [] } }; } },
    summarize: { async generate() { return { candidate: {} }; } },
    personal: { async generate(input) { personalCalls.push(input); return { candidate: citedReview(input, `第 ${personalCalls.length} 稿：按证据完成承诺`) }; } },
  };
  const t: TestApp = await createTestApp({ companyPeopleSeed: seed, conversationAttachmentStorageDir: dir }, runtime, {
    requestAgent: agent, monthlyNow: () => NOW,
    ...(options.reviews ? { monthlyReviewAgents: reviewAgents, monthlyReviewRetryDelayMs: 0 } : {}),
  });
  cleanup = async () => { await t.monthlyReviews?.idle(); await t.close(); await rm(dir, { recursive: true, force: true }); };
  const member = await t.memberCookie();
  const say = async (message: string, run: typeof script) => {
    script = run;
    const response = await t.app.inject({ method: "POST", url: "/api/conversations/global/messages",
      headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message } });
    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    for (const event of events) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
    const history = (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie: member } })).json();
    const reply = history.messages.at(-1) as { role: string; cards?: TConversationCard[] };
    expect(reply.role).toBe("assistant");
    for (const card of reply.cards ?? []) expect(Value.Check(ConversationCard, card)).toBe(true);
    return { events, steps: events.filter((event) => event.type === "step").map(({ id, label, status, result }) => ({ id, label, status, ...(result ? { result } : {}) })),
      cards: reply.cards ?? [], result: results.at(-1) as Record<string, unknown>, turn: turns.at(-1)! };
  };
  /** 别人发给测试乙的待办（直接落库，sent_at 按给定时间）。 */
  const sendTodo = async (initiator: string, title: string, sentAt: string, body = `${title}。`) => {
    const id = randomUUID();
    await t.sql(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, created_at, sent_at) VALUES ($1, 'relay', $2, $3, $3, $4, 'open', $5, $5)`,
      [id, initiator, title, body, sentAt]);
    await t.sql("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [id, TEST_MEMBER.personId]);
    return id;
  };
  const view = async (id: string) => (await t.app.inject({ method: "GET", url: `/api/requests/${id}`, headers: { cookie: member } })).json().request as TRequestView;
  const act = (action: { actionId: string }, input: unknown) => t.app.inject({ method: "POST", url: "/api/requests/actions/execute",
    headers: { cookie: member, origin: t.publicOrigin }, payload: { actionId: action.actionId, input } });
  return { t, member, say, sendTodo, view, act, personalCalls };
}

describe("帮我问问（⑨）：定位待办 → 查有没有人问过 → 整理问题 → 等你确认", () => {
  it("只对上一件：步骤逐个亮起，预览卡挂在回答后面；不点发送不会发出，点了才问到发起人", async () => {
    const { t, say, sendTodo, view, act } = await setup();
    const form = await sendTodo(JUJIE, "填备案信息表", "2026-09-29T08:20:00Z", "财务在收集备案信息，请填产品介绍和截图。");
    await sendTodo(RENHAO, "更新周报数据表", "2026-09-29T01:00:00Z");
    const turn = await say("昨天居杰拜托我填的那个表，截图要直接贴进表格还是贴链接，你帮我问问",
      (entries) => entries.askAboutTodo({ question: "截图要直接贴进表格还是贴链接" }));
    // 我手上没完成的待办每轮带进上下文：只有标题、发起人、时间、类型。
    expect(turn.turn.openTodos).toEqual([
      { title: "填备案信息表", from: "唐巨杰", sentAt: "9/29 16:20", kind: "传话" },
      { title: "更新周报数据表", from: "刘人豪", sentAt: "9/29 09:00", kind: "传话" },
    ]);
    expect(turn.steps.filter((step) => step.status !== "pending")).toEqual([
      { id: "todo-locate", label: "定位待办", status: "active" },
      { id: "todo-locate", label: "定位待办", status: "done", result: "唐巨杰：填备案信息表" },
      { id: "todo-check", label: "查有没有人问过", status: "active" },
      { id: "todo-check", label: "查有没有人问过", status: "done", result: "没人问过" },
      { id: "todo-organize", label: "整理问题", status: "done" },
      { id: "todo-confirm", label: "等你确认", status: "active" },
    ]);
    expect(turn.result).toMatchObject({ found: "preview", to: "唐巨杰", question: "备案信息表的截图栏：截图要直接贴进表格还是贴链接" });
    expect(turn.cards).toEqual([{ kind: "todo_ask", requestId: form, question: "备案信息表的截图栏：截图要直接贴进表格还是贴链接", href: `/me/requests/${form}` }]);
    expect(await t.sql("SELECT * FROM request_questions")).toEqual([]);
    // 运行记录里「等你确认」留着高亮。
    const [run] = await t.sql("SELECT input_snapshot->'steps' AS steps FROM agent_runs WHERE kind = 'conversation'");
    expect((run.steps as { label: string; status: string }[]).at(-1)).toMatchObject({ label: "等你确认", status: "active" });

    const ask = (await view(form)).actions.find((action) => action.actionType === "request.ask")!;
    expect((await act(ask, { question: (turn.cards[0] as { question: string }).question })).statusCode).toBe(200);
    expect(await t.sql("SELECT asker_id, question FROM request_questions")).toEqual([{ asker_id: TEST_MEMBER.personId, question: "备案信息表的截图栏：截图要直接贴进表格还是贴链接" }]);
    expect(await t.sql("SELECT person_id, kind FROM notifications WHERE kind = 'request_asked'")).toEqual([{ person_id: JUJIE, kind: "request_asked" }]);
  });

  it("已有人问过：停在第二步，直接给库里的答案原文和出处，不再往下整理", async () => {
    const { t, say, sendTodo } = await setup();
    const form = await sendTodo(JUJIE, "填备案信息表", "2026-09-29T08:20:00Z");
    const questionId = randomUUID();
    await t.sql(`INSERT INTO request_questions (id, request_id, asker_id, question, answer, answered_at, fingerprint) VALUES ($1, $2, $3, '截图怎么放？', '存云盘，贴链接', now(), 'fp-1')`,
      [questionId, form, RENHAO]);
    const turn = await say("巨杰昨天那个表，截图贴表格还是贴链接，帮我问问", (entries) => entries.askAboutTodo({ question: "截图贴表格还是贴链接" }));
    expect(lookups).toEqual([{ question: "截图贴表格还是贴链接", answered: 1 }]);
    // 每一步最后的样子。
    expect([...new Map(turn.steps.map((step) => [step.id, step])).values()]).toEqual([
      { id: "todo-locate", label: "定位待办", status: "done", result: "唐巨杰：填备案信息表" },
      { id: "todo-check", label: "查有没有人问过", status: "done", result: "已有人问过，唐巨杰答过" },
      { id: "todo-organize", label: "整理问题", status: "pending" },
      { id: "todo-confirm", label: "等你确认", status: "pending" },
    ]);
    expect(turn.result).toMatchObject({ found: "answered", answer: "存云盘，贴链接", source: "唐巨杰在待办卡上答过" });
    expect(turn.cards).toEqual([{ kind: "todo_answer", requestId: form, href: `/me/requests/${form}`, question: "备案信息表的截图栏：截图贴表格还是贴链接",
      answer: "存云盘，贴链接", source: "question", questionId }]);
  });

  it("对上两件让本人点选；说到的人没发过就如实说没有，不换成别人的", async () => {
    const { say, sendTodo } = await setup();
    const first = await sendTodo(JUJIE, "填备案信息表", "2026-09-29T08:20:00Z");
    const second = await sendTodo(JUJIE, "核对报销表", "2026-09-29T03:00:00Z");
    await sendTodo(RENHAO, "补合同扫描件", "2026-09-29T02:00:00Z");
    const pick = await say("杰哥昨天发的那个表帮我问问截止时间", (entries) => entries.askAboutTodo({ question: "截止时间是哪天" }));
    expect(pick.result).toMatchObject({ found: "choose", total: 2 });
    expect(pick.cards).toEqual([{ kind: "todo_pick", question: "截止时间是哪天", candidates: [
      { requestId: first, title: "填备案信息表", initiatorName: "唐巨杰", sentAt: "2026-09-29T08:20:00.000Z", href: `/me/requests/${first}` },
      { requestId: second, title: "核对报销表", initiatorName: "唐巨杰", sentAt: "2026-09-29T03:00:00.000Z", href: `/me/requests/${second}` },
    ] }]);
    expect(pick.steps.find((step) => step.status !== "pending" && step.id === "todo-locate" && step.result)).toEqual(
      { id: "todo-locate", label: "定位待办", status: "active", result: "对上 2 件，等你选" });
    expect(lookups).toEqual([]);

    const none = await say("昨天测试甲发的表帮我问问", (entries) => entries.askAboutTodo({ question: "截止时间", person: "测试甲" }));
    expect(none.result).toMatchObject({ found: "none", person: "测试甲" });
    expect(none.cards).toEqual([]);
    expect(none.steps.find((step) => step.id === "todo-locate" && step.status === "done")).toMatchObject({ result: "天枢里没有测试甲发来的这件待办" });
  });
});

describe("请同事帮忙：送达服务的起草与预览", () => {
  it("起草 → 查歧义 → 等你确认，预览卡在回答后面；对话里回答歧义后按回答重写，发出仍要本人点", async () => {
    const { t, say, view, member } = await setup();
    const first = await say("让人豪帮我补一下上周的周报数据", (entries) => entries.requestHelp({ prompt: "让人豪帮我补一下上周的周报数据" }));
    expect(first.steps.filter((step) => step.status !== "pending")).toEqual([
      { id: "request-draft", label: "起草请求", status: "active" },
      { id: "request-draft", label: "起草请求", status: "done" },
      { id: "request-clarify", label: "查歧义", status: "done", result: "1 处要你定" },
      { id: "request-confirm", label: "等你确认", status: "active" },
    ]);
    const requestId = first.result.requestId as string;
    expect(first.result).toMatchObject({ drafted: true, suggestedRecipients: ["刘人豪"], questionsForYou: ["数据直接填进周报表，还是另发一个文件？"] });
    expect(first.cards).toEqual([{ kind: "request_draft", requestId, href: `/me/requests/${requestId}` }]);

    const second = await say("直接填进周报表", (entries) => entries.requestHelp({ prompt: "让人豪帮我补一下上周的周报数据", requestId, answers: ["直接填进周报表"] }));
    expect(second.result).toMatchObject({ drafted: true, requestId });
    const draft = await view(requestId);
    expect(draft).toMatchObject({ status: "draft", version: 2, body: "请补上周的周报数据。交付：直接填进周报表。",
      clarifications: [{ question: "数据直接填进周报表，还是另发一个文件？", answer: "直接填进周报表" }] });
    expect(await t.sql("SELECT * FROM request_recipients")).toEqual([]);
    const send = draft.actions.find((action) => action.actionType === "request.send")!;
    const sent = await t.app.inject({ method: "POST", url: "/api/requests/actions/execute", headers: { cookie: member, origin: t.publicOrigin },
      payload: { actionId: send.actionId, input: { recipientIds: [RENHAO] } } });
    expect(sent.statusCode).toBe(200);
    expect(await t.sql("SELECT person_id FROM request_recipients")).toEqual([{ person_id: RENHAO }]);
  });
});

describe("一句话生成复盘", () => {
  async function seedMission(t: TestApp) {
    await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
    await t.sql("INSERT INTO capability_config(id,version,code,name,six_month_outcome) VALUES ('cap-personal',1,'01','能力','能力目标')");
    await t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,boundaries,
      source_ref,source_document_id,source_revision,source_title) VALUES ('mission-member',1,'M1','2026-09','本人承诺',$1,'cap-personal','["growth"]','承诺结果','原因','["验收证据"]','["里程碑"]','边界','test','test',1,'test')`,
    [TEST_MEMBER.personId]);
  }

  it("四步实时显示，重新生成保留本人改过的段落，草稿卡挂在回答后面；没配周复盘生成服务时如实说生成不了", async () => {
    const { t, say, member, personalCalls } = await setup({ reviews: true });
    await seedMission(t);
    await t.monthlyReviews!.open("2026-09");
    await t.monthlyReviews!.idle();
    const [row] = await t.sql("SELECT id, version, status FROM personal_reviews WHERE person_id = $1", [TEST_MEMBER.personId]);
    expect(row.status).toBe("draft");
    // 本人改过「下周期重点」这一栏。
    const update = await t.app.inject({ method: "POST", url: "/api/personal-reviews/actions/execute", headers: { cookie: member, origin: t.publicOrigin },
      payload: { actionId: signActionId(testEnv.sessionSecret, { actionType: "personal-review.update", objectType: "personal-review", objectId: row.id as string, objectVersion: row.version as number }),
        input: { fields: [{ field: "nextFocus", text: "我自己写的下周期重点" }] } } });
    expect(update.statusCode).toBe(200);

    const turn = await say("生成我的 9 月复盘", (entries) => entries.generateReview({ kind: "monthly", period: "9" }));
    expect(personalCalls).toHaveLength(2);
    const labels = ["读 Mission 卡", "读每周复盘", "读采集记录", "起草"];
    for (const label of labels) {
      const seen = turn.steps.filter((step) => step.label === label).map((step) => step.status);
      expect(seen, label).toContain("active");
      expect(seen.at(-1), label).toBe("done");
    }
    // 先后顺序：读完 Mission 卡才开始读每周复盘……
    const firstActive = labels.map((label) => turn.steps.findIndex((step) => step.label === label && step.status === "active"));
    expect([...firstActive].sort((a, b) => a - b)).toEqual(firstActive);
    expect(turn.steps.at(-1)).toMatchObject({ label: "起草", status: "done", result: "保留你改过的 1 段" });
    expect(turn.result).toMatchObject({ generated: true, period: "2026-09", keptYourEdits: 1 });
    expect(turn.cards).toEqual([{ kind: "review", personalReviewId: row.id, href: `/me/reviews/personal/${row.id}` }]);
    const [after] = await t.sql("SELECT status, self_review FROM personal_reviews WHERE id = $1", [row.id]);
    expect(after.status).toBe("draft");
    expect((after.self_review as { nextFocus: { text: string }; overall: { text: string } }).nextFocus.text).toBe("我自己写的下周期重点");
    expect((after.self_review as { overall: { text: string } }).overall.text).toContain("第 2 稿");

    const weekly = await say("帮我写这周复盘", (entries) => entries.generateReview({ kind: "weekly" }));
    expect(weekly.result).toMatchObject({ generated: false, reason: "周复盘生成服务没有配置" });
    expect(weekly.cards).toEqual([]);
  });

  it("这一期还没有个人复盘：如实说，不生成", async () => {
    const { say, personalCalls } = await setup({ reviews: true });
    const turn = await say("生成我的 9 月复盘", (entries) => entries.generateReview({ kind: "monthly" }));
    expect(turn.result).toMatchObject({ generated: false });
    expect(turn.cards).toEqual([]);
    expect(personalCalls).toEqual([]);
  });
});
