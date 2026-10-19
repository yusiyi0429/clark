import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ImpactCardView, MeetingDecisionView, type TPostMeetingCandidate } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { DecisionLayeringAgent, DecisionLayeringInput } from "../src/meetingDecisionAgent.js";
import type { ImpactAgent, ImpactAnalysisInput } from "../src/impactAgent.js";
import { createMeetingDecisionService } from "../src/meetingDecisions.js";
import { meetingInterpretationContext } from "../src/meetingContext.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { personDisplayNames } from "../src/people.js";
import type { FeishuNotice } from "../src/feishu/notify.js";
import type { DecisionEventInput, DecisionWorldSync } from "../src/worldDecisionEvents.js";
import { hashSecret } from "../src/session.js";

// 会后分层确认与影响卡：主持人确认三到五条、提醒与 Agent 代判、更正卡、战略项跟着 CEO、原文可见范围。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const HOST = TEST_MEMBER.personId; // 测试乙：主持人
const OWNER = "person-fixture-003"; // 测试丙
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };

const TURNS = [
  { id: "turn-001", speakerId: CEO, text: "渠道预算这个月先不动，下周再看数据。" },
  { id: "turn-002", speakerId: HOST, text: "接口统一改成 v2，测试丙那边月底前切过去。" },
  { id: "turn-003", speakerId: OWNER, text: "好，我月底前把渠道看板接到 v2。" },
  { id: "turn-004", speakerId: OWNER, text: "东南亚要不要整体撤出，这件事得请 CEO 拍板。" },
];

const CANDIDATE: TPostMeetingCandidate = {
  summary: "接口统一切到 v2，渠道预算暂不调整，东南亚去留交 CEO",
  items: [
    { kind: "decision", text: "接口统一改成 v2", turnId: "turn-002", quote: "接口统一改成 v2" },
    { kind: "todo", text: "渠道看板接到 v2", turnId: "turn-003", quote: "我月底前把渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30" },
    { kind: "decision", text: "渠道预算这个月先不动", turnId: "turn-001", quote: "渠道预算这个月先不动" },
    { kind: "strategic", text: "是否整体撤出东南亚", turnId: "turn-004", quote: "东南亚要不要整体撤出", title: "是否整体撤出东南亚市场",
      brief: "测试丙提出东南亚业务是否整体撤出，需要 CEO 拍板。", judgmentKind: "company_direction" },
  ],
};

const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };
const outcomeInputs: PostMeetingAgentInput[] = [];
const outcomeAgent: PostMeetingAgent = { async generate(input) { outcomeInputs.push(input); return { candidate: structuredClone(CANDIDATE) }; } };

/** 分层：两条合法的，外加一条指向不存在的条目、一条指向战略项（都应被丢掉）。 */
function fakeLayering(): DecisionLayeringAgent & { inputs: DecisionLayeringInput[] } {
  const agent = {
    inputs: [] as DecisionLayeringInput[],
    async layer(input: DecisionLayeringInput) {
      agent.inputs.push(input);
      return { decisions: [
        { statement: "接口统一改成 v2，月底前切换", itemIds: ["item-1", "item-2"], affects: [OWNER], why: "测试丙的渠道看板要改接口", recommendation: "confirmed" as const, recommendationReason: "主持人点名并给了时间" },
        { statement: "渠道预算这个月先不动", itemIds: ["item-3"], affects: [], why: "预算", recommendation: "not_decided" as const, recommendationReason: "CEO 说下周再看数据" },
        { statement: "不存在的条目", itemIds: ["item-9"], affects: [], why: "x", recommendation: "confirmed" as const, recommendationReason: "x" },
        { statement: "东南亚", itemIds: ["item-4"], affects: [], why: "x", recommendation: "confirmed" as const, recommendationReason: "x" },
      ] };
    },
  };
  return agent;
}

/** 影响分析：给测试丙一张卡（落到他的执行事项），外加一张查无此人的、一张重复的（都应被丢掉）。 */
function fakeImpact(): ImpactAgent & { inputs: ImpactAnalysisInput[] } {
  const agent = {
    inputs: [] as ImpactAnalysisInput[],
    async analyze(input: ImpactAnalysisInput) {
      agent.inputs.push(input);
      const owner = input.people.find((person) => person.personId === OWNER);
      const task = owner?.tasks[0];
      if (!task) return { cards: [] };
      const card = {
        personId: OWNER, targets: [{ type: "task" as const, id: task.id }, { type: "acceptance" as const, id: task.id, index: 9 }],
        title: "渠道看板要切到 v2 接口", impact: `会上确认接口统一改成 v2，你在做的「${task.title}」要跟着切。`,
        action: { kind: "do" as const, text: "月底前把渠道看板接到 v2", due: "2026-06-31" }, why: "旧接口月底下线。", confidence: "high" as const,
      };
      return { cards: [card, { ...card, personId: "nobody" }, { ...card, title: "重复" }] };
    },
    async answer() { return "月底验收要按 v2 接口验，旧接口的截图不算。"; },
  };
  return agent;
}

async function newApp(layering = fakeLayering(), impact = fakeImpact()): Promise<TestApp> {
  return createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent, meetingFollowThroughAgents: { layering, impact } });
}

type CardAction = { actionType: string; actionId: string; itemId?: string };

async function readyMeeting(t: TestApp): Promise<{ ceo: string; meetingId: string }> {
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: CardAction[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  expect(created.statusCode).toBe(200);
  const meetingId = created.json().cards[0].objectRef.id as string;
  const imported = await t.app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS } });
  expect(imported.statusCode).toBe(200);
  expect(imported.json().cards[0].payload.outcome.status).toBe("ready");
  return { ceo, meetingId };
}

async function ownerCookie(t: TestApp): Promise<string> {
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)]);
  const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  return String(login.headers["set-cookie"]).split(";")[0];
}

const review = (t: TestApp, cookie: string, meetingId: string, decisionId: string, body: unknown) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/decisions/${decisionId}/review`, headers: { cookie, origin: t.publicOrigin }, payload: body });

describe("会后分层确认与影响卡", () => {
  it("主持人只看几条「会上定了 X」，确认后影响卡经送达通道推给受影响的人；卡上能追问、能点和我无关", async () => {
    const layering = fakeLayering();
    const impact = fakeImpact();
    const t = await newApp(layering, impact);
    try {
      const { ceo, meetingId } = await readyMeeting(t);
      // 解读纪要时带上了公司地图（每个人的 Mission、本月 outcome、长期目标）。
      expect(outcomeInputs.at(-1)?.context).toMatchObject({ period: expect.any(String), company: expect.any(Object), people: expect.any(Array), battlefields: expect.any(Array) });
      // 纪要整理好后排了一次同步（worker 不跑，这里直接调）。
      expect((await t.pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.decisions_sync'")).rows[0].n).toBeGreaterThan(0);
      await t.app.meetingFollowThrough.decisions.sync(meetingId);
      await t.app.meetingFollowThrough.decisions.sync(meetingId);
      expect(layering.inputs).toHaveLength(1);
      // 解读时带上了公司地图，逐字稿带着说话人名字。
      expect(layering.inputs[0].transcript).toContain("[turn-002] 测试乙：接口统一改成 v2");
      expect(layering.inputs[0].strategic.map((item) => item.title)).toEqual(["是否整体撤出东南亚市场"]);

      const host = await t.memberCookie();
      const mine = await t.app.inject({ method: "GET", url: "/api/me/meeting-decisions", headers: { cookie: host } });
      expect(mine.statusCode).toBe(200);
      const [group] = mine.json().groups;
      expect(group.meetingTitle).toBe("接口切换会");
      expect(group.decisions.map((d: { statement: string }) => d.statement)).toEqual(["接口统一改成 v2，月底前切换", "渠道预算这个月先不动"]);
      for (const decision of group.decisions) expect(Value.Check(MeetingDecisionView, decision)).toBe(true);
      expect(group.decisions[0]).toMatchObject({ tier: "host", status: "pending", recommendation: "confirmed", canReview: true, quote: "接口统一改成 v2", speakerName: "测试乙" });

      // CEO 的会议卡也带着分层结果（战略项在前）。
      const ceoCard = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      expect(ceoCard.payload.decisions.map((d: { tier: string }) => d.tier)).toEqual(["strategic", "host", "host"]);

      // 不是主持人不能确认；改一下要写改后的说法。
      expect((await review(t, ceo, meetingId, group.decisions[0].id, { verdict: "confirmed" })).statusCode).toBe(404);
      expect((await review(t, host, meetingId, group.decisions[0].id, { verdict: "edited" })).statusCode).toBe(400);
      const confirmed = await review(t, host, meetingId, group.decisions[0].id, { verdict: "confirmed" });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().decision).toMatchObject({ status: "confirmed", reviewerName: "测试乙" });
      // 其实没定：不往下推。
      expect((await review(t, host, meetingId, group.decisions[1].id, { verdict: "not_decided" })).json().decision.status).toBe("not_decided");
      const jobs = (await t.pool.query("SELECT payload FROM jobs WHERE kind = 'meeting.decision_propagate'")).rows.map((row) => row.payload);
      expect(jobs).toEqual([{ decisionId: group.decisions[0].id, revision: 0 }]);
      expect((await t.app.inject({ method: "GET", url: "/api/me/meeting-decisions", headers: { cookie: host } })).json().groups).toEqual([]);

      await t.app.meetingFollowThrough.decisions.propagate(group.decisions[0].id, 0);
      await t.app.meetingFollowThrough.decisions.propagate(group.decisions[0].id, 0);
      expect(impact.inputs).toHaveLength(1);
      expect(impact.inputs[0].decision).toMatchObject({ statement: "接口统一改成 v2，月底前切换", decidedBy: "host" });
      expect(impact.inputs[0].relatedItems.map((item) => item.text)).toEqual(["接口统一改成 v2", "渠道看板接到 v2"]);

      const cards = (await t.pool.query("SELECT * FROM impact_cards")).rows;
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ person_id: OWNER, status: "delivered", agent_judged: false });
      expect(cards[0].action).toEqual({ kind: "do", text: "月底前把渠道看板接到 v2", due: null });
      expect(cards[0].targets).toHaveLength(1);

      const owner = await ownerCookie(t);
      const inbox = (await t.app.inject({ method: "GET", url: "/api/me/requests?box=inbox", headers: { cookie: owner } })).json().items;
      expect(inbox).toEqual([expect.objectContaining({ kind: "impact", title: "渠道看板要切到 v2 接口", initiatorName: "测试乙", myStatus: "pending", unread: true })]);
      // 拍板的人「发出的」里没有影响卡。
      expect((await t.app.inject({ method: "GET", url: "/api/me/requests?box=sent", headers: { cookie: host } })).json().items).toEqual([]);
      const notifications = (await t.app.inject({ method: "GET", url: "/api/me/notifications", headers: { cookie: owner } })).json();
      expect(JSON.stringify(notifications)).toContain("会后影响你：渠道看板要切到 v2 接口");

      const requestId = inbox[0].id;
      const read = await t.app.inject({ method: "GET", url: `/api/requests/${requestId}/impact`, headers: { cookie: owner } });
      expect(read.statusCode).toBe(200);
      const card = read.json().card;
      expect(Value.Check(ImpactCardView, card)).toBe(true);
      expect(card).toMatchObject({
        status: "delivered", agentJudged: false, superseded: false, correction: null, planWrite: null,
        trigger: { statement: "接口统一改成 v2，月底前切换", decidedBy: "host", meetingTitle: "接口切换会", tier: "host" },
        askWho: [{ personId: HOST, displayName: "测试乙", role: "host" }],
        sources: [{ quote: "接口统一改成 v2", speakerName: "测试乙", turnId: "turn-002" }],
      });
      // 别人读不到这张卡；请求本身对影响卡不提供「问拍板的人」，只有「知道了」。
      expect((await t.app.inject({ method: "GET", url: `/api/requests/${requestId}/impact`, headers: { cookie: host } })).statusCode).toBe(404);
      const request = (await t.app.inject({ method: "GET", url: `/api/requests/${requestId}`, headers: { cookie: owner } })).json().request;
      expect(request.actions.map((a: { actionType: string; label: string }) => `${a.actionType}:${a.label}`)).toEqual(["request.mark_done:知道了"]);

      const asked = await t.app.inject({ method: "POST", url: `/api/impact-cards/${card.id}/ask`, headers: { cookie: owner, origin: t.publicOrigin }, payload: { question: "这对我月底的验收有什么影响？" } });
      expect(asked.statusCode).toBe(200);
      expect(asked.json().steps.map((s: { label: string }) => s.label)).toEqual(["读卡片", "查你手上的事", "回答"]);
      expect(asked.json().card.questions).toEqual([expect.objectContaining({ question: "这对我月底的验收有什么影响？", answer: "月底验收要按 v2 接口验，旧接口的截图不算。" })]);
      // 追问不打扰拍板的人。
      expect((await t.pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'request_asked'")).rows[0].n).toBe(0);

      const irrelevant = await t.app.inject({ method: "POST", url: `/api/impact-cards/${card.id}/irrelevant`, headers: { cookie: owner, origin: t.publicOrigin }, payload: { reason: "我已经切过了" } });
      expect(irrelevant.json().card.status).toBe("irrelevant");
      expect((await t.app.inject({ method: "POST", url: `/api/impact-cards/${card.id}/irrelevant`, headers: { cookie: owner, origin: t.publicOrigin }, payload: {} })).json().card.status).toBe("irrelevant");
      expect((await t.pool.query("SELECT irrelevant_reason FROM impact_cards")).rows[0].irrelevant_reason).toBe("我已经切过了");
      expect((await t.app.inject({ method: "GET", url: "/api/me/requests?box=inbox", headers: { cookie: owner } })).json().items[0].myStatus).toBe("done");
      expect((await t.pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'request_done'")).rows[0].n).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("提醒两次、满一个工作日由 Agent 代判并标出来；主持人改判后给收过卡的人出更正卡，本体记 correction", async () => {
    const t = await newApp();
    try {
      const { meetingId } = await readyMeeting(t);
      const peopleDirectory = loadPeopleDirectory(t.env);
      let clock = new Date("2026-06-05T16:00:00+08:00"); // 周五
      const notices: { notice: FeishuNotice; key: string }[] = [];
      const events: DecisionEventInput[] = [];
      const world: DecisionWorldSync = {
        async record(input) { events.push(input); return { status: "committed", eventId: `event-${events.length}` }; },
        errorCode: () => "WORLD_SYNC_FAILED",
      };
      const impact = fakeImpact();
      const service = createMeetingDecisionService({
        pool: t.pool, peopleDirectory, layering: fakeLayering(), impact, world, now: () => clock,
        context: () => meetingInterpretationContext(t.pool.query.bind(t.pool), clock, personDisplayNames(peopleDirectory)),
        notify: async (notice, key) => { notices.push({ notice, key }); },
      });
      await service.sync(meetingId);
      const decisions = (await t.pool.query("SELECT * FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows;
      expect(decisions.map((d) => d.due_at.toISOString())).toEqual(["2026-06-08T08:00:00.000Z", "2026-06-08T08:00:00.000Z"]); // 周一 16:00

      clock = new Date("2026-06-05T16:05:00+08:00");
      await service.tick();
      const hostNotices = notices.filter((item) => item.notice.personId === HOST);
      expect(hostNotices).toHaveLength(1);
      expect(hostNotices[0].notice.title).toBe("「接口切换会」会后待你确认 2 条");
      expect(hostNotices[0].notice.body).toContain("1. 接口统一改成 v2，月底前切换");
      expect(hostNotices[0].notice.body).toContain("6月8日 16:00 前没确认，按 Agent 的判断生效。");
      expect(hostNotices[0].notice.links).toEqual([{ label: "去确认", path: `/me/meetings/${meetingId}` }]);
      // 战略项提醒 CEO，链接到 CEO 的会议页。
      expect(notices.find((item) => item.notice.personId === CEO)?.notice.links).toEqual([{ label: "去确认", path: `/meetings/${meetingId}` }]);
      await service.tick();
      expect(notices.filter((item) => item.notice.personId === HOST)).toHaveLength(1);

      clock = new Date("2026-06-08T09:31:00+08:00"); // 下一个工作日上午
      await service.tick();
      expect(notices.filter((item) => item.notice.personId === HOST)).toHaveLength(2);
      clock = new Date("2026-06-08T12:00:00+08:00");
      await service.tick();
      expect(notices.filter((item) => item.notice.personId === HOST)).toHaveLength(2);

      clock = new Date("2026-06-08T16:01:00+08:00");
      await service.tick();
      const judged = (await t.pool.query("SELECT tier, status, impact_status FROM meeting_decisions ORDER BY tier DESC, ordinal")).rows;
      // 战略项不代判。
      expect(judged).toEqual([
        { tier: "strategic", status: "pending", impact_status: "none" },
        { tier: "host", status: "agent_judged", impact_status: "pending" },
        { tier: "host", status: "agent_judged", impact_status: "none" },
      ]);
      expect((await t.pool.query("SELECT payload FROM jobs WHERE kind = 'meeting.decision_propagate'")).rows.map((row) => row.payload))
        .toEqual([{ decisionId: decisions[0].id, revision: 0 }]);
      await service.propagate(decisions[0].id, 0);
      expect(impact.inputs[0].decision.decidedBy).toBe("agent");
      const original = (await t.pool.query("SELECT * FROM impact_cards")).rows[0];
      expect(original).toMatchObject({ agent_judged: true, status: "delivered", trigger_revision: 0 });
      expect(events).toEqual([expect.objectContaining({ supersedesEventId: null, withdrawn: false, decision: expect.objectContaining({ decidedBy: "agent", revision: 0 }) })]);
      expect(events[0].targets).toEqual([{ type: "task", id: original.targets[0].id }]);

      const owner = await ownerCookie(t);
      const read = async () => (await t.app.inject({ method: "GET", url: `/api/requests/${original.request_id}/impact`, headers: { cookie: owner } })).json().card;
      expect((await read()).agentJudged).toBe(true);

      // 主持人改判：改一下 → revision 1，给收过卡的测试丙出更正卡，本体记 correction。
      const host = await t.memberCookie();
      const edited = await review(t, host, meetingId, decisions[0].id, { verdict: "edited", statement: "接口统一改成 v2，下月 15 日前切换" });
      expect(edited.json().decision).toMatchObject({ status: "edited", revision: 1, statement: "接口统一改成 v2，下月 15 日前切换", originalStatement: "接口统一改成 v2，月底前切换" });
      await service.propagate(decisions[0].id, 0); // 过期的一版不再推
      await service.propagate(decisions[0].id, 1);
      expect(impact.inputs[1].previous).toEqual({ statement: "接口统一改成 v2，月底前切换" });
      const correction = (await t.pool.query("SELECT * FROM impact_cards WHERE trigger_revision = 1")).rows[0];
      expect(correction).toMatchObject({ person_id: OWNER, correction_of: original.id, agent_judged: false, correction_note: "测试乙把「接口统一改成 v2，月底前切换」改为「接口统一改成 v2，下月 15 日前切换」" });
      expect(await read()).toMatchObject({ superseded: true, agentJudged: false });
      expect(events[1]).toMatchObject({ supersedesEventId: "event-1", correctionNote: correction.correction_note, decision: expect.objectContaining({ decidedBy: "host", revision: 1 }) });

      // 再改成其实没定：给测试丙一张作废卡（知悉即可），本体再记一条 correction。
      await review(t, host, meetingId, decisions[0].id, { verdict: "not_decided" });
      await service.propagate(decisions[0].id, 2);
      expect(impact.inputs).toHaveLength(2);
      const withdrawn = (await t.pool.query("SELECT * FROM impact_cards WHERE trigger_revision = 2")).rows[0];
      expect(withdrawn).toMatchObject({ person_id: OWNER, correction_of: correction.id, correction_note: "测试乙确认会上其实没定「接口统一改成 v2，下月 15 日前切换」" });
      expect(withdrawn.action).toEqual({ kind: "know", text: "知悉即可", due: null });
      expect(events[2]).toMatchObject({ supersedesEventId: "event-2", withdrawn: true });

      // 代判为「其实没定」的那条，主持人后来确认：第一次往下推，不是更正。
      const late = await review(t, host, meetingId, decisions[1].id, { verdict: "confirmed" });
      expect(late.json().decision).toMatchObject({ status: "confirmed", revision: 0 });
      // 影响卡入队的飞书通知随卡一起落在 jobs 里。
      const feishu = (await t.pool.query("SELECT payload FROM jobs WHERE kind = 'feishu.notify' ORDER BY id")).rows.map((row) => row.payload);
      expect(feishu.map((item) => item.title)).toEqual(["渠道看板要切到 v2 接口", "更正 · 渠道看板要切到 v2 接口", "更正 · 「渠道看板要切到 v2 接口」作废"]);
      expect(feishu[0].links).toEqual([{ label: "查看", path: `/me/requests/${original.request_id}` }]);
    } finally {
      await t.close();
    }
  });

  it("战略项跟着 CEO 在会议条目上的确认走，确认后才往下推；原文和完整纪要只给实际参会的人和 CEO", async () => {
    const t = await newApp();
    try {
      const { ceo, meetingId } = await readyMeeting(t);
      await t.app.meetingFollowThrough.decisions.sync(meetingId);
      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      const strategicItem = card.payload.outcome.items.find((item: { kind: string }) => item.kind === "strategic");
      const confirm = (card.actions as CardAction[]).find((a) => a.actionType === "meeting.confirm_item" && a.itemId === strategicItem.id)!;
      expect((await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: { actionId: confirm.actionId, input: {} } })).statusCode).toBe(200);
      await t.app.meetingFollowThrough.decisions.sync(meetingId);
      const strategic = (await t.pool.query("SELECT * FROM meeting_decisions WHERE tier = 'strategic'")).rows[0];
      expect(strategic).toMatchObject({ status: "confirmed", reviewer_id: CEO, statement: "是否整体撤出东南亚市场", impact_status: "pending" });
      expect((await t.pool.query("SELECT payload FROM jobs WHERE kind = 'meeting.decision_propagate'")).rows.map((row) => row.payload))
        .toEqual([{ decisionId: strategic.id, revision: 0 }]);
      // 主持人不能替 CEO 确认战略项。
      const host = await t.memberCookie();
      expect((await review(t, host, meetingId, strategic.id, { verdict: "confirmed" })).statusCode).toBe(409);

      // 飞书参会名单里只有主持人：测试丙（手填的参会人）看不到原文和完整纪要，主持人看得到。
      await t.pool.query("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([HOST])]);
      const hostCard = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: host } })).json();
      expect(hostCard.payload).toMatchObject({ attended: true, outcome: { summary: CANDIDATE.summary } });
      expect(hostCard.payload.transcript.turns).toHaveLength(4);
      expect(hostCard.payload.decisions.filter((d: { canReview: boolean }) => d.canReview)).toHaveLength(2);
      const owner = await ownerCookie(t);
      const ownerCard = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie: owner } })).json();
      expect(ownerCard.payload.attended).toBe(false);
      expect(ownerCard.payload).not.toHaveProperty("transcript");
      expect(ownerCard.payload).not.toHaveProperty("decisions");
      expect(ownerCard.payload.outcome).not.toHaveProperty("summary");
      expect(ownerCard.payload.attendees).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});
