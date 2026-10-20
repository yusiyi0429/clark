import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TPostMeetingCandidate, TWorldAnchor } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { DecisionLayeringAgent } from "../src/meetingDecisionAgent.js";
import type { ImpactAgent } from "../src/impactAgent.js";
import { createMeetingDecisionService } from "../src/meetingDecisions.js";
import { meetingInterpretationContext } from "../src/meetingContext.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { personDisplayNames } from "../src/people.js";
import { hashSecret } from "../src/session.js";
import { projection, stubWorld } from "./worldFixture.js";

// 会议入本体：改挂点、旧会议的逐条决定。整卡确认和写会议事件见 meetingCardConfirm.test.ts。
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
    { kind: "open", text: "渠道预算下周看数据再定", turnId: "turn-001", quote: "下周再看数据" },
  ],
};
const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };
const outcomeAgent: PostMeetingAgent = { async generate() { return { candidate: structuredClone(CANDIDATE) }; } };
const layering: DecisionLayeringAgent = { async layer() { return { decisions: [
  { statement: "接口统一改成 v2，月底前切换", itemIds: ["item-1", "item-2"], affects: [OWNER], why: "看板要改接口", recommendation: "confirmed" as const, recommendationReason: "主持人点名" },
  { statement: "渠道预算这个月先不动", itemIds: ["item-3"], affects: [], why: "预算", recommendation: "not_decided" as const, recommendationReason: "下周再看" },
] }; } };
/** 影响分析：给测试丙一张卡，落到他手上的第一个执行事项。 */
const impact: ImpactAgent = {
  async analyze(input) {
    const task = input.people.find((person) => person.personId === OWNER)?.tasks[0];
    return { cards: task ? [{ personId: OWNER, targets: [{ type: "task" as const, id: task.id }], title: "渠道看板要切到 v2 接口", impact: "你的看板要跟着切。",
      action: { kind: "do" as const, text: "月底前切到 v2", due: null }, why: "旧接口下线。", confidence: "high" as const }] : [] };
  },
  async answer() { return "按 v2 验。"; },
};

/** 本体里的对象：本月 Mission（mission:v2-202606）和主持人负责的单元（capability:07）。 */
const head = (object_id: string, object_type: string, title: string, version: number, externalId: string) => ({
  object_id, object_type, title, revision_id: `${object_id}-r${version}`, object_version: version, version, lifecycle: { status: "active" },
  contract_version: "tkos.world/0.3", external_refs: [{ system: "tianshu", id: externalId }],
});
const MISSION_HEAD = head("obj-mission-v2", "Mission", "接口全量切到 v2", 3, "mission:v2-202606");
const UNIT_HEAD = head("obj-unit-07", "ResponsibilityUnit", "Agents", 2, "capability:07");

/** 假本体：按外部引用列对象、取对象（挂点选项和挂点对象用）。 */
function ontology() {
  stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/world/objects") {
      const external = call.url.searchParams.get("external_id");
      return { items: [MISSION_HEAD, UNIT_HEAD].filter((item) => item.external_refs[0].id === external), next_cursor: null };
    }
    const object = [MISSION_HEAD, UNIT_HEAD].find((item) => path === `/v1/world/objects/${item.object_id}`);
    return object ? projection(object) : { items: [], next_cursor: null };
  });
}

type CardAction = { actionType: string; actionId: string; itemId?: string };

async function setup(env: Parameters<typeof createTestApp>[0] = {}) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, ...env }, undefined, { preflightAgent, outcomeAgent, meetingFollowThroughAgents: { layering, impact } });
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: CardAction[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  const meetingId = created.json().cards[0].objectRef.id as string;
  await t.app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS } });
  // 旧格式会议（逐条条目）。
  await seedLegacyOutcome(t.pool, meetingId, CANDIDATE);
  // 测试丙的执行事项挂在本月 Mission 下；主持人负责「智能体」单元。
  await t.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code, owner_id) VALUES ('agents', 1, '智能体', 'test', '', '07', $1)", [HOST]);
  await t.pool.query(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title)
    VALUES ('m-v2', 1, 'v2-202606', '2026-06', '接口全量切到 v2', $1, 'agents', '月底前全部切到 v2', 'test://m', 'test', 1, '测试')`, [OWNER]);
  await t.pool.query("UPDATE tasks SET mission_id = 'm-v2', step_order = 1 WHERE owner_id = $1", [OWNER]);
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)]);
  const ownerLogin = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  const owner = String(ownerLogin.headers["set-cookie"]).split(";")[0];
  return { t, ceo, host: await t.memberCookie(), owner, meetingId };
}

/** 会后服务（时钟固定）。 */
function serviceFor(t: TestApp, clock = { now: new Date("2026-06-01T12:00:00+08:00") }) {
  const peopleDirectory = loadPeopleDirectory(t.env);
  const q = t.pool.query.bind(t.pool);
  const service = createMeetingDecisionService({ pool: t.pool, peopleDirectory, layering, impact, now: () => clock.now,
    context: () => meetingInterpretationContext(q, clock.now, personDisplayNames(peopleDirectory)) });
  return { service };
}

const putAnchors = (t: TestApp, cookie: string, meetingId: string, anchors: unknown) => t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`,
  headers: { cookie, origin: t.publicOrigin }, payload: { anchors } });
const MISSION: TWorldAnchor = { kind: "mission", id: "m-v2", title: "接口全量切到 v2" };
const UNIT: TWorldAnchor = { kind: "unit", id: "agents", title: "智能体" };

afterEach(() => vi.unstubAllGlobals());

describe("会议入本体：挂点与旧会议的逐条决定", () => {
  it("改挂点：只能挑本月选项，主持人和 CEO 能改，参会人不能；null 回到主持人的单元", async () => {
    ontology();
    const { t, host, owner, meetingId } = await setup();
    try {
      const options = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world-anchor-options`, headers: { cookie: host } });
      expect(options.json().options).toEqual([MISSION, UNIT]);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world-anchor-options`, headers: { cookie: owner } })).statusCode).toBe(404);
      expect((await putAnchors(t, host, meetingId, [{ kind: "mission", id: "nope" }])).statusCode).toBe(400);
      expect((await putAnchors(t, owner, meetingId, [{ kind: "unit", id: "agents" }])).statusCode).toBe(404);
      expect((await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-excluded`, headers: { cookie: host, origin: t.publicOrigin },
        payload: { excluded: true } })).statusCode).toBe(404);

      const edited = await putAnchors(t, host, meetingId, [{ kind: "unit", id: "agents" }, { kind: "mission", id: "m-v2" }]);
      expect(edited.json().world).toMatchObject({ edited: true, anchors: [UNIT, MISSION], record: { status: "pending" } });
      expect((await putAnchors(t, host, meetingId, null)).json().world).toMatchObject({ edited: false, anchors: [UNIT] });
    } finally {
      await t.close();
    }
  });

  it("代判后的条目留在主持人的通知栏，直到主持人点过", async () => {
    const { t, host, meetingId } = await setup();
    try {
      const { service } = serviceFor(t);
      await service.sync(meetingId);
      await t.pool.query("UPDATE meeting_decisions SET status = 'agent_judged', judged_at = now() WHERE tier = 'host'");
      const mine = (await t.app.inject({ method: "GET", url: "/api/me/meeting-decisions", headers: { cookie: host } })).json().groups;
      expect(mine[0].decisions.map((d: { status: string; recommendation: string }) => [d.status, d.recommendation]))
        .toEqual([["agent_judged", "confirmed"], ["agent_judged", "not_decided"]]);
      const first = mine[0].decisions[0];
      await service.review(meetingId, first.id, HOST, { verdict: "confirmed" });
      expect((await t.app.inject({ method: "GET", url: "/api/me/meeting-decisions", headers: { cookie: host } })).json().groups[0].decisions).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});
