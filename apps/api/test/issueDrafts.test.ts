import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ConversationHistory, ConversationSseEvent, IssueDraftResponse, type TConversationHistory, type TIssueDraftView } from "@warmap/contracts";
import type { ConversationRuntime } from "../src/conversations.js";
import type { ProposeIssueArgs } from "../src/issueDrafts.js";
import { createTestApp, type TestApp } from "./helpers.js";

/**
 * 一号位深聊转议题（已定设计第 2 节）：经过对话路由的完整几轮。假运行时代替首页 Agent 调 propose_issue。
 * 拒绝过的话题不再提；接受后相关那段对话复制进议题页、首页留一行可点的留痕、个人记忆改挂到议题上。
 */
type Turn = Parameters<ConversationRuntime["run"]>[0];
type Script = (input: Turn) => Promise<unknown>;

const DRAFT: ProposeIssueArgs = {
  topic: "渠道预算转向", turns: 3, title: "渠道预算是否转向华南", whyNow: "华南渠道窗口六月关闭，五月底前要定",
  formedIdeas: ["华东存量客户续约不能断"], options: [{ label: "六月前转向华南", tradeoff: "抢到窗口，但华东续约投入减少" }, { label: "维持华东", tradeoff: "保住续约，放弃华南窗口" }],
  openQuestions: ["华南转化样本够不够"],
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}

async function setup() {
  let script: Script = async () => undefined;
  const turns: Turn[] = [];
  const results: unknown[] = [];
  const runtime: ConversationRuntime = { async run(input) {
    turns.push(input);
    results.push(await script(input));
    input.emit({ type: "message", delta: "好的" });
    return { assistantMessage: "好的", runtimeEntries: input.runtimeEntries };
  } };
  const t: TestApp = await createTestApp({}, runtime);
  cleanup = () => t.close();
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const send = async (cookie: string, scope: string, message: string, next: Script = async () => undefined, extra: Record<string, unknown> = {}) => {
    script = next;
    const response = await t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
      headers: { cookie, origin: t.publicOrigin }, payload: { message, ...extra } });
    expect(response.statusCode).toBe(200);
    const events = parseSse(response.body);
    for (const event of events) expect(Value.Check(ConversationSseEvent, event)).toBe(true);
    return { events, turn: turns.at(-1)!, result: results.at(-1) as Record<string, unknown> | undefined };
  };
  const history = async (cookie: string, scope: string) => {
    const response = await t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as TConversationHistory;
    // createdAt 的 date-time 格式测试环境没注册，只校验其余字段。
    expect([...Value.Errors(ConversationHistory, body)].filter((error) => !error.message.includes("Unknown format"))).toEqual([]);
    return body.messages;
  };
  const draft = async (cookie: string, id: string, action?: "accept" | "decline", payload?: unknown) => {
    const response = await t.app.inject({ method: action ? "POST" : "GET", url: `/api/issue-drafts/${id}${action ? `/${action}` : ""}`,
      headers: { cookie, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, view: response.statusCode === 200 ? (response.json() as { draft: TIssueDraftView }).draft : null, body: response.json() as Record<string, unknown> };
  };
  return { t, ceo, member, send, history, draft };
}

describe("一号位深聊转议题", () => {
  it("连续聊够几轮才提；接受后这段对话带进议题页、首页留痕可点、记忆改挂到议题；首页再提时知道议题聊到哪", async () => {
    const { t, ceo, member, send, history, draft } = await setup();
    // 成员的首页没有这个能力。
    expect((await send(member, "global", "随便聊聊")).turn.issueSuggest).toBeUndefined();

    await send(ceo, "global", "华南渠道值不值得投？");
    const early = await send(ceo, "global", "华东续约怎么办？", (input) => input.issueSuggest!.propose({ ...DRAFT, turns: 2 }));
    expect(early.result).toMatchObject({ proposed: false, reason: "too_early" });
    const third = await send(ceo, "global", "那预算到底转不转？", (input) => input.issueSuggest!.propose(DRAFT));
    expect(third.result).toMatchObject({ proposed: true });
    const draftId = (third.result as { draftId: string }).draftId;
    // 建议卡的块随正文流给界面，也存进这条回答。
    expect(third.events.some((event) => event.type === "message" && String(event.delta).includes("```issue-suggest"))).toBe(true);
    const home = await history(ceo, "global");
    expect(home.at(-1)!.content).toBe(`好的\n\n\`\`\`issue-suggest\n${JSON.stringify({ draftId })}\n\`\`\``);

    // 只有 CEO 能看、能点。
    expect((await draft(member, draftId)).status).toBe(403);
    const proposed = await draft(ceo, draftId);
    expect(Value.Check(IssueDraftResponse, { draft: proposed.view })).toBe(true);
    expect(proposed.view).toMatchObject({ status: "proposed", turns: 3, matchedIssue: null, draft: { title: DRAFT.title } });

    // 这段对话里沉淀出的一条个人记忆（主题 anchor）：接受后改挂到议题上。
    const conversationId = (await t.sql("SELECT id FROM conversations WHERE scope = 'global' AND owner_id = 'person-fixture-001'"))[0].id as string;
    const memoryId = randomUUID();
    await t.sql(`INSERT INTO personal_memory_items (id, person_id, kind, title, text, anchors, refs) VALUES ($1, 'person-fixture-001', 'stance', '渠道', '倾向保住华东续约',
      '[{"target":"topic:渠道预算"}]'::jsonb, $2::jsonb)`, [memoryId, JSON.stringify([{ ref: `chat:${conversationId}#${home.at(-2)!.sequence}`, at: new Date().toISOString() }])]);

    const edited = { ...proposed.view!.draft, title: "华南渠道预算要不要转" };
    const accepted = await draft(ceo, draftId, "accept", { mode: "new", draft: edited, location: { level: "company" } });
    expect(accepted.status).toBe(200);
    expect(accepted.view).toMatchObject({ status: "accepted", issue: { title: "华南渠道预算要不要转" } });
    const issueId = accepted.view!.issue!.id;
    expect(accepted.view!.issue!.href).toBe(`/issues/${issueId}`);
    // 重放返回原结果，不再建第二个议题。
    expect((await draft(ceo, draftId, "accept", { mode: "new", draft: edited, location: { level: "company" } })).view!.issue!.id).toBe(issueId);
    expect((await t.sql("SELECT count(*)::int AS n FROM issues WHERE origin = 'ceo'"))[0].n).toBe(1);
    expect((await t.sql("SELECT location FROM issues WHERE id = $1", [issueId]))[0].location).toEqual({ level: "company", relatedBattlefieldIds: [] });
    expect((await t.sql("SELECT file_name FROM object_materials WHERE object_type = 'issue' AND object_id = $1", [issueId]))[0].file_name).toBe("议题初稿.md");

    // 带过去的是这三轮问答（不含之前的、不含建议卡的块），首页这三轮原样保留。
    const carried = await history(ceo, `issue:${issueId}`);
    expect(carried.map((message) => [message.role, message.content, message.kind])).toEqual([
      ["user", "华南渠道值不值得投？", "carried"], ["assistant", "好的", "carried"],
      ["user", "华东续约怎么办？", "carried"], ["assistant", "好的", "carried"],
      ["user", "那预算到底转不转？", "carried"], ["assistant", "好的", "carried"],
    ]);
    const trace = (await history(ceo, "global")).at(-1)!;
    expect(trace).toMatchObject({ role: "assistant", kind: "trace", content: "已转到议题「华南渠道预算要不要转」",
      meta: { issueId, title: "华南渠道预算要不要转", href: `/issues/${issueId}` } });
    const anchors = (await t.sql("SELECT anchors FROM personal_memory_items WHERE id = $1", [memoryId]))[0].anchors as { target: string }[];
    expect(anchors.map((anchor) => anchor.target)).toEqual([`issue:${issueId}`]);

    // 议题页第一轮：模型没见过的那段接进历史；之后不再重复接。
    expect((await send(ceo, `issue:${issueId}`, "接着说")).turn.carriedOver?.map((message) => message.content))
      .toEqual(["华南渠道值不值得投？", "好的", "华东续约怎么办？", "好的", "那预算到底转不转？", "好的"]);
    expect((await send(ceo, `issue:${issueId}`, "再说说华南")).turn.carriedOver).toBeUndefined();

    // 首页再提：知道已经转成议题，能读议题里聊到哪；留痕行不进模型的最近几轮。
    const again = await send(ceo, "global", "渠道那件事后来怎么样了", (input) => input.issueSuggest!.readIssueConversation(issueId));
    expect(again.turn.issueContext?.issueThreads).toEqual([expect.objectContaining({ issueId, title: "华南渠道预算要不要转", turnsInIssue: 2 })]);
    expect(again.turn.recentMessages?.some((message) => message.content.startsWith("已转到议题"))).toBe(false);
    const read = again.result as { messages: { text: string; fromHome?: boolean }[] };
    expect(read.messages.at(-1)!.text).toBe("好的");
    expect(read.messages.map((message) => message.text)).toContain("再说说华南");
    // 同一话题不再提议。
    const repeat = await send(ceo, "global", "渠道预算还要不要议", (input) => input.issueSuggest!.propose(DRAFT));
    expect(repeat.result).toMatchObject({ proposed: false, reason: "transferred" });
  }, 120_000);

  it("选「不用」后同一话题不再提；能对上已有议题时可以接到那个议题", async () => {
    const { t, ceo, send, history, draft } = await setup();
    for (const message of ["第一轮", "第二轮"]) await send(ceo, "global", message);
    const first = await send(ceo, "global", "第三轮", (input) => input.issueSuggest!.propose(DRAFT));
    const draftId = (first.result as { draftId: string }).draftId;
    const declined = await draft(ceo, draftId, "decline");
    expect(declined.view).toMatchObject({ status: "declined" });
    expect((await draft(ceo, draftId, "accept", { mode: "new", draft: DRAFT, location: { level: "company" } })).status).toBe(409);

    // 换个说法再提同一话题：服务端拦下；上下文里也带着拒绝过的话题。
    const again = await send(ceo, "global", "第四轮", (input) => input.issueSuggest!.propose({ ...DRAFT, topic: "渠道预算转向华南", title: "渠道预算转不转向华南" }));
    expect(again.result).toMatchObject({ proposed: false, reason: "declined" });
    expect(again.turn.issueContext?.declinedIssueTopics).toEqual(["渠道预算转向"]);
    expect((await history(ceo, "global")).at(-1)!.content).toBe("好的");

    // 另一个话题，对得上已有议题：接到那个议题，不新建。
    const existing = await t.createIssue({ title: "是否调整定价策略" });
    const pricing = await send(ceo, "global", "定价怎么定", (input) => input.issueSuggest!.propose({ ...DRAFT, topic: "定价策略", title: "定价策略要不要调", matchIssueId: existing.objectRef.id }));
    const pricingId = (pricing.result as { draftId: string }).draftId;
    expect((await draft(ceo, pricingId)).view).toMatchObject({ matchedIssue: { id: existing.objectRef.id, title: "是否调整定价策略" } });
    const joined = await draft(ceo, pricingId, "accept", { mode: "existing", issueId: existing.objectRef.id });
    expect(joined.view).toMatchObject({ status: "accepted", issue: { id: existing.objectRef.id } });
    expect((await t.sql("SELECT count(*)::int AS n FROM issues"))[0].n).toBe(1);
    const carried = await history(ceo, `issue:${existing.objectRef.id}`);
    expect(carried.filter((message) => message.kind === "carried").map((message) => message.content)).toContain("定价怎么定");
  }, 120_000);

  it("跨对象读取发范围标签并随回答存下；改过的范围随请求带给这一轮", async () => {
    const { ceo, send, history } = await setup();
    const read = await send(ceo, "global", "把每个人过去三个月的 Mission 拉出来", (input) => input.companyMap!.readMissionCards({ people: "all", from: "2026-08", to: "2026-10" }));
    const scope = read.events.find((event) => event.type === "scope");
    expect(scope).toMatchObject({ label: "全员 · 8–10 月", params: { people: "all", from: "2026-08", to: "2026-10" } });
    expect(read.events.some((event) => event.type === "step" && event.label === "定范围" && event.result === "全员 · 8–10 月")).toBe(true);
    expect(read.turn.anchor!.view.range).toMatch(/^全员 · /);
    expect((await history(ceo, "global")).at(-1)!.readScope).toMatchObject({ label: "全员 · 8–10 月" });

    const override = { people: ["person-fixture-002"], from: "2026-09", to: "2026-10" };
    const again = await send(ceo, "global", "按「测试乙 · 9–10 月」重新读", (input) => input.companyMap!.readMissionCards({ people: "all" }), { scopeOverride: override });
    expect(again.turn.scopeOverride).toEqual(override);
    expect(again.events.find((event) => event.type === "scope")).toMatchObject({ label: "测试乙 · 9–10 月" });
  }, 120_000);
});
