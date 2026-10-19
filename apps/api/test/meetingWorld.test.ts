import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingWorldView, type TPostMeetingCandidate, type TWorldAnchor } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { DecisionLayeringAgent } from "../src/meetingDecisionAgent.js";
import type { ImpactAgent } from "../src/impactAgent.js";
import { createMeetingDecisionService } from "../src/meetingDecisions.js";
import { meetingInterpretationContext } from "../src/meetingContext.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { personDisplayNames } from "../src/people.js";
import type { DecisionEventInput, DecisionWorldSync } from "../src/worldDecisionEvents.js";
import { createMeetingEventWorld, type MeetingEventWorld, type MeetingEventWrite } from "../src/worldMeetingEvent.js";
import { hashSecret } from "../src/session.js";
import { projection, stubWorld, withWorld } from "./worldFixture.js";

// 会议入本体（回流设计稿 3.1、3.2）：主持人办完后先记会议事件、再记决定事件指回它；挂点、不写进本体（撤回、恢复）、落点与写入状态的可见范围。
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

/** 假本体：决定事件和会议事件各记一份；挂点取第一组非空的（refs = obj:<kind>:<id>@1）。 */
function fakeWorld(fallbackFor: Set<string> = new Set()) {
  const decisions: DecisionEventInput[] = [];
  const meetings: MeetingEventWrite[] = [];
  const world: DecisionWorldSync = {
    async record(input) { decisions.push(input); return { status: "committed", eventId: `dev-${decisions.length}`, fallback: fallbackFor.has(input.decision.id) }; },
    errorCode: () => "WORLD_SYNC_FAILED",
  };
  const meetingWorld: MeetingEventWorld = {
    async resolve(groups) {
      const group = groups.find((item) => item.length);
      return group ? { refs: group.map((anchor) => `obj:${anchor.kind}:${anchor.id}@1`), sceneId: `obj:${group[0].kind}:${group[0].id}`, used: group } : null;
    },
    async write(input) { meetings.push(input); return `mev-${meetings.length}`; },
    errorCode: () => "WORLD_SYNC_FAILED",
  };
  return { world, meetingWorld, decisions, meetings };
}

type CardAction = { actionType: string; actionId: string; itemId?: string };

async function setup() {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED }, undefined, { preflightAgent, outcomeAgent, meetingFollowThroughAgents: { layering, impact } });
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

function serviceFor(t: TestApp, fake: ReturnType<typeof fakeWorld>) {
  const peopleDirectory = loadPeopleDirectory(t.env);
  const clock = new Date("2026-06-01T12:00:00+08:00");
  return createMeetingDecisionService({ pool: t.pool, peopleDirectory, layering, impact, world: fake.world, meetingWorld: fake.meetingWorld, now: () => clock,
    context: () => meetingInterpretationContext(t.pool.query.bind(t.pool), clock, personDisplayNames(peopleDirectory)) });
}

const memberCard = async (t: TestApp, cookie: string, meetingId: string) =>
  (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${meetingId}`, headers: { cookie } })).json().payload;
const MISSION: TWorldAnchor = { kind: "mission", id: "m-v2", title: "接口全量切到 v2" };

afterEach(() => vi.unstubAllGlobals());

describe("会议入本体", () => {
  it("主持人办完、影响卡推完后先记会议事件（提炼，不带原文），再记决定事件并指回它；落点与状态只给主持人和 CEO 看", async () => {
    const { t, ceo, host, owner, meetingId } = await setup();
    try {
      const fake = fakeWorld();
      const service = serviceFor(t, fake);
      await service.sync(meetingId);
      const [first, second] = (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows as { id: string }[];
      // 主持人还没办：不写。
      await service.syncWorld(meetingId);
      expect(fake.meetings).toEqual([]);

      await service.review(meetingId, first.id, HOST, { verdict: "confirmed" });
      await service.review(meetingId, second.id, HOST, { verdict: "not_decided" });
      await service.propagate(first.id, 0);

      expect(fake.meetings).toHaveLength(1);
      const event = fake.meetings[0];
      expect(event).toMatchObject({ supersedesEventId: null, anchors: { refs: ["obj:mission:m-v2@1"], used: [MISSION] } });
      expect(event.text.split("\n")).toEqual([
        "会议：接口切换会", "时间：2026-06-01 10:00–11:00（北京时间）", "主持人：测试乙", "参会人：测试甲、测试乙、测试丙", `天枢会议：${meetingId}`,
        "挂到：Mission「接口全量切到 v2」", "", "摘要：", CANDIDATE.summary, "", "会上定了：", "1. 接口统一改成 v2，月底前切换（Host 已确认）",
      ]);
      expect(event.text).not.toContain(TURNS[0].text);
      // 决定事件在会议事件之后，指回它；没定的那条不写。
      expect(fake.decisions).toHaveLength(1);
      expect(fake.decisions[0]).toMatchObject({ meetingEventId: "mev-1", fallback: { refs: ["obj:mission:m-v2@1"] }, decision: { id: first.id, decidedBy: "host" } });

      // 主持人：落点和写入状态都看得到，能改。
      const hostView = await memberCard(t, host, meetingId);
      expect(Value.Check(MeetingWorldView, hostView.world)).toBe(true);
      expect(hostView.world).toMatchObject({ excluded: false, status: "committed", anchors: [MISSION], edited: false, canEdit: true });
      const confirmed = hostView.decisions.find((d: { id: string }) => d.id === first.id);
      expect(confirmed).toMatchObject({ world: "committed", anchors: [{ kind: "task", title: "渠道看板接到 v2" }] });
      expect(hostView.decisions.find((d: { id: string }) => d.id === second.id)).toMatchObject({ world: null, anchors: [] });
      // 参会人：只看落点。
      const ownerView = await memberCard(t, owner, meetingId);
      expect(ownerView.world).toMatchObject({ status: null, at: null, canEdit: false, anchors: [MISSION] });
      expect(ownerView.decisions.find((d: { id: string }) => d.id === first.id)).toMatchObject({ world: null, anchors: [{ kind: "task" }] });
      // CEO 卡：看得到状态。
      const ceoCard = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      expect(ceoCard.payload.world).toMatchObject({ status: "committed", canEdit: true });

      // 再跑一次同步：内容没变，不重写。
      await service.syncWorld(meetingId);
      expect(fake.meetings).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("CEO 确认战略项后会议事件记 correction；对不上受影响对象的决定挂到会议挂点上，界面标出来", async () => {
    const { t, ceo, host, meetingId } = await setup();
    try {
      const strategicId = () => t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'strategic'").then((r) => r.rows[0]?.id as string);
      const fake = fakeWorld();
      const service = serviceFor(t, fake);
      await service.sync(meetingId);
      for (const row of (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows) {
        await service.review(meetingId, row.id, HOST, { verdict: "not_decided" });
      }
      // 主持人的条目都没定：会议事件照样写，挂主持人负责的单元。
      await service.syncWorld(meetingId);
      expect(fake.meetings[0].anchors.used).toEqual([{ kind: "unit", id: "agents", title: "智能体" }]);

      const card = (await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json().cards[0];
      const item = card.payload.outcome.items.find((entry: { kind: string }) => entry.kind === "strategic");
      const confirm = (card.actions as CardAction[]).find((a) => a.actionType === "meeting.confirm_item" && a.itemId === item.id)!;
      await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: { actionId: confirm.actionId, input: {} } });
      await service.sync(meetingId);
      const id = await strategicId();
      fake.world.record = async (input) => { fake.decisions.push(input); return { status: "committed", eventId: "dev-s", fallback: true }; };
      await service.propagate(id, 0);

      expect(fake.meetings).toHaveLength(2);
      expect(fake.meetings[1]).toMatchObject({ supersedesEventId: "mev-1", anchors: { used: [MISSION] } });
      expect(fake.meetings[1].text).toContain("1. 是否整体撤出东南亚市场（CEO 已确认）");
      expect(fake.decisions.at(-1)).toMatchObject({ meetingEventId: "mev-2", decision: { decidedBy: "ceo" } });
      const strategic = (await memberCard(t, host, meetingId)).decisions.find((d: { tier: string }) => d.tier === "strategic");
      expect(strategic).toMatchObject({ world: "fallback", anchors: [MISSION] });
    } finally {
      await t.close();
    }
  });

  it("主持人和 CEO 能标不写进本体：已写的记撤回，取消后重新写；别人不能动", async () => {
    const { t, ceo, host, owner, meetingId } = await setup();
    try {
      const fake = fakeWorld();
      const service = serviceFor(t, fake);
      await service.sync(meetingId);
      const [first, second] = (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows as { id: string }[];
      await service.review(meetingId, first.id, HOST, { verdict: "confirmed" });
      await service.review(meetingId, second.id, HOST, { verdict: "not_decided" });
      await service.propagate(first.id, 0);
      expect(fake.decisions).toHaveLength(1);

      const put = (cookie: string, excluded: boolean) => t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-excluded`,
        headers: { cookie, origin: t.publicOrigin }, payload: { excluded } });
      expect((await put(owner, true)).statusCode).toBe(404);
      const excluded = await put(host, true);
      expect(excluded.statusCode).toBe(200);
      expect(excluded.json().world).toMatchObject({ excluded: true, excludedBy: "测试乙", status: "committed" });
      expect((await t.pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync'")).rows[0].n).toBeGreaterThan(0);

      await service.syncWorld(meetingId);
      expect(fake.meetings.at(-1)).toMatchObject({ digest: "withdrawn", supersedesEventId: "mev-1" });
      expect(fake.meetings.at(-1)!.text.split("\n")[0]).toBe("撤回：测试乙标为不写进本体");
      expect(fake.decisions.at(-1)).toMatchObject({ withdrawnBy: "测试乙", supersedesEventId: "dev-1", variant: ":dev-1" });
      const off = await memberCard(t, host, meetingId);
      expect(off.world).toMatchObject({ excluded: true, status: "withdrawn" });
      expect(off.decisions.find((d: { id: string }) => d.id === first.id).world).toBe("off");

      // CEO 取消：会议事件和决定事件各记一条恢复（更正撤回的那条）。
      expect((await put(ceo, false)).json().world).toMatchObject({ excluded: false, excludedBy: null });
      await service.syncWorld(meetingId);
      expect(fake.meetings.at(-1)).toMatchObject({ supersedesEventId: "mev-2" });
      expect(fake.meetings.at(-1)!.digest).not.toBe("withdrawn");
      expect(fake.decisions.at(-1)).toMatchObject({ supersedesEventId: "dev-2", variant: ":dev-2" });
      expect(fake.decisions.at(-1)!.withdrawnBy).toBeUndefined();
      expect((await memberCard(t, host, meetingId)).world.status).toBe("committed");
    } finally {
      await t.close();
    }
  });

  it("改挂点：只能挑本月 Mission 和责任单元；改了以后会议事件记 correction，null 回到自动", async () => {
    const { t, host, owner, meetingId } = await setup();
    try {
      const fake = fakeWorld();
      const service = serviceFor(t, fake);
      await service.sync(meetingId);
      const put = (cookie: string, anchors: unknown) => t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`,
        headers: { cookie, origin: t.publicOrigin }, payload: { anchors } });
      const options = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world-anchor-options`, headers: { cookie: host } });
      expect(options.json().options).toEqual([MISSION, { kind: "unit", id: "agents", title: "智能体" }]);
      expect((await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world-anchor-options`, headers: { cookie: owner } })).statusCode).toBe(404);
      expect((await put(host, [{ kind: "mission", id: "nope" }])).statusCode).toBe(400);
      expect((await put(owner, [{ kind: "unit", id: "agents" }])).statusCode).toBe(404);

      const edited = await put(host, [{ kind: "unit", id: "agents" }, { kind: "mission", id: "m-v2" }]);
      expect(edited.json().world).toMatchObject({ edited: true, anchors: [{ kind: "unit", id: "agents" }, MISSION] });
      for (const row of (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host'")).rows) {
        await service.review(meetingId, row.id, HOST, { verdict: "not_decided" });
      }
      await service.syncWorld(meetingId);
      expect(fake.meetings[0].anchors.refs).toEqual(["obj:unit:agents@1", "obj:mission:m-v2@1"]);

      expect((await put(host, null)).json().world).toMatchObject({ edited: false });
      await service.syncWorld(meetingId);
      expect(fake.meetings[1]).toMatchObject({ supersedesEventId: "mev-1", anchors: { used: [{ kind: "unit", id: "agents" }] } });
    } finally {
      await t.close();
    }
  });

  it("代判后的条目留在主持人的通知栏，直到主持人点过", async () => {
    const { t, host, meetingId } = await setup();
    try {
      const service = serviceFor(t, fakeWorld());
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

describe("会议事件写本体（WorldClient）", () => {
  it("挂点按组回退到本体里对得上的；记 meeting，原文地址带逐字稿摘要；更正带 supersedes、幂等键另起", async () => {
    await withWorld(async (client, db) => {
      await db.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code) VALUES ('agents', 1, '智能体', 'test', '', '07')");
      const unit = { object_id: "unit-07", object_type: "ResponsibilityUnit", title: "Agents", revision_id: "r1", object_version: 2, version: 2, lifecycle: {}, contract_version: "tkos.world/0.3" };
      let events = 0;
      const calls = stubWorld((call) => {
        if (call.url.pathname === "/v1/world/objects") return { items: call.url.searchParams.get("external_id") === "capability:07" ? [unit] : [], next_cursor: null };
        if (call.url.pathname === "/v1/world/objects/unit-07") return projection(unit);
        if (call.url.pathname === "/v1/actions/prepare") return { expected_versions: [] };
        if (call.url.pathname === "/v1/actions") return { receipt_id: `r${++events}`, status: "committed", result: { event_id: `ev-${events}` } };
        throw new Error(`unexpected ${call.url.pathname}`);
      });
      const world = createMeetingEventWorld({ q: (sql, params) => db.pool.query(sql, params), client, publicOrigin: "https://tianshu.test/", now: () => new Date("2026-10-19T18:00:00+08:00") });
      // 第一组的 Mission 在本体里没有（库里也没有）：退到单元。
      const anchors = await world.resolve([[{ kind: "mission", id: "missing", title: "不存在" }], [{ kind: "unit", id: "agents", title: "智能体" }]]);
      expect(anchors).toEqual({ refs: ["unit-07@2"], sceneId: "unit-07", used: [{ kind: "unit", id: "agents", title: "Agents" }] });
      const meeting = { id: "m1m1m1m1-0000-4000-8000-000000000001", title: "接口切换会", scheduled_at: new Date("2026-10-19T14:00:00+08:00") };
      expect(await world.write({ meeting, text: "会议：接口切换会", digest: "abcdef0123456789", transcriptDigest: "0011223344556677", anchors: anchors!, supersedesEventId: null })).toBe("ev-1");
      const body = calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body;
      expect(body).toMatchObject({
        action_type: "world_record_event", idempotency_key: `tianshu:meeting:${meeting.id}:abcdef0123456789`,
        params: { category: "meeting", subject_refs: ["unit-07@2"], occurred_at: "2026-10-19T14:00:00+08:00",
          content: { text: "会议：接口切换会", artifacts: [`https://tianshu.test/meetings/${meeting.id}#sha256=0011223344556677`] },
          declaration: { scene: "unit-07@2", trigger: "天枢会议入本体" } },
      });
      await world.write({ meeting, text: "撤回", digest: "withdrawn", transcriptDigest: "0011223344556677", anchors: anchors!, supersedesEventId: "ev-1" });
      const withdrawal = calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body;
      expect(withdrawal.idempotency_key).toBe(`tianshu:meeting:${meeting.id}:withdrawn:ev-1`);
      expect(withdrawal.params).toMatchObject({ category: "correction", supersedes_event_id: "ev-1" });
      // 一组都对不上：null。
      expect(await world.resolve([[{ kind: "mission", id: "missing", title: "不存在" }]])).toBeNull();
    });
  });
});
