import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingWorldResponse, type TMeetingWorldResponse, type TPostMeetingCandidate, type TWorldAnchor } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import type { DecisionLayeringAgent } from "../src/meetingDecisionAgent.js";
import type { ImpactAgent } from "../src/impactAgent.js";
import { createJobWorker } from "../src/jobs.js";
import { createMeetingDecisionService, meetingDecisionJobs } from "../src/meetingDecisions.js";
import { meetingInterpretationContext } from "../src/meetingContext.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { personDisplayNames } from "../src/people.js";
import { WorldClient } from "../src/worldClient.js";
import { createMeetingEventWorld } from "../src/worldMeetingEvent.js";
import { hashSecret } from "../src/session.js";
import { projection, stubWorld, withWorld, worldEnv } from "./worldFixture.js";

// 会议入本体（B 方案，D-58）：建会、逐条确认都不写；主持人或创建人整卡确认后写一条整场会议事件，修改另记一条并指回前次；选了不写入不发请求。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const HOST = TEST_MEMBER.personId; // 测试乙：主持人
const OWNER = "person-fixture-003"; // 测试丙
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };
const FEISHU = "https://tokenking.feishu.cn";

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

/**
 * 假本体：按外部引用列对象、取对象；记事件按幂等键去重（同键重放回原回执）；取事件返回挂在这个对象上的事件。
 * failing() 为 true 时记事件返回 503；beforeCommit 在每次记事件（prepare 之后、提交之前）先跑。
 */
function ontology({ failing = () => false, beforeCommit }: { failing?: () => boolean; beforeCommit?: () => Promise<void> } = {}) {
  const recorded: { eventId: string; body: { idempotency_key: string; params: { subject_refs: string[] } } }[] = [];
  const calls = stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/world/objects") {
      const external = call.url.searchParams.get("external_id");
      return { items: [MISSION_HEAD, UNIT_HEAD].filter((item) => item.external_refs[0].id === external), next_cursor: null };
    }
    if (path === "/v1/actions/prepare") return { expected_versions: [] };
    if (path === "/v1/actions") {
      await beforeCommit?.();
      if (failing()) return new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "down" } }), { status: 503 });
      const event = recorded.find((item) => item.body.idempotency_key === call.body.idempotency_key)
        ?? recorded[recorded.push({ eventId: `ev-${recorded.length + 1}`, body: call.body }) - 1];
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    const events = path.match(/^\/v1\/world\/objects\/([^/]+)\/events$/);
    if (events) {
      return { events: recorded.filter((item) => item.body.params.subject_refs.some((ref) => ref.startsWith(`${decodeURIComponent(events[1])}@`)))
        .map((item) => ({ event_id: item.eventId })) };
    }
    const object = [MISSION_HEAD, UNIT_HEAD].find((item) => path === `/v1/world/objects/${item.object_id}`);
    return object ? projection(object) : { items: [], next_cursor: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writes = () => calls.filter((call) => call.url.pathname === "/v1/actions").map((call) => call.body as any);
  return { calls, writes };
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
  // 整卡确认（记录）现在还按旧格式会议的逐条条目算（Task 3 改成会议卡）：写成旧会议的样子。
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

/** 会后服务（时钟可拨）：会议事件经 WorldClient 写进假本体；run() 把排队的任务跑完。 */
function serviceFor(t: TestApp, clock = { now: new Date("2026-06-01T12:00:00+08:00") }) {
  const peopleDirectory = loadPeopleDirectory(t.env);
  const q = t.pool.query.bind(t.pool);
  const meetingWorld = createMeetingEventWorld({ q, client: new WorldClient(q, worldEnv), feishuWebOrigin: FEISHU });
  const service = createMeetingDecisionService({ pool: t.pool, peopleDirectory, layering, impact, meetingWorld, now: () => clock.now,
    context: () => meetingInterpretationContext(q, clock.now, personDisplayNames(peopleDirectory)) });
  const worker = createJobWorker({ pool: t.pool, handlers: meetingDecisionJobs(service).handlers });
  const run = async () => { while (await worker.tick() > 0); };
  return { service, run, clock };
}

/** 主持人把两条办掉：第一条对，第二条其实没定。 */
async function hostReviews(t: TestApp, service: ReturnType<typeof serviceFor>["service"], meetingId: string) {
  await service.sync(meetingId);
  const [first, second] = (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows as { id: string }[];
  await service.review(meetingId, first.id, HOST, { verdict: "confirmed" });
  await service.review(meetingId, second.id, HOST, { verdict: "not_decided" });
  return { first, second };
}

/** 会议页单独取的「这场会在本体里」（不进会议卡）。 */
const worldOf = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingWorldResponse> =>
  (await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world`, headers: { cookie } })).json();
const putAnchors = (t: TestApp, cookie: string, meetingId: string, anchors: unknown) => t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`,
  headers: { cookie, origin: t.publicOrigin }, payload: { anchors } });
const MISSION: TWorldAnchor = { kind: "mission", id: "m-v2", title: "接口全量切到 v2" };
const UNIT: TWorldAnchor = { kind: "unit", id: "agents", title: "智能体" };

afterEach(() => vi.unstubAllGlobals());

describe("会议入本体：整卡确认后写一条整场会议事件", () => {
  it("建会不写本体：建会、纪要、主持人逐条确认之后跑任务，本体一次都没被写；整卡确认后才写", async () => {
    const world = ontology();
    const { t, meetingId } = await setup(worldEnv);
    try {
      const followThrough = t.app.meetingFollowThrough;
      const worker = createJobWorker({ pool: t.pool, handlers: followThrough.jobs().handlers });
      const run = async () => { while (await worker.tick() > 0); };
      await run();
      const [first, second] = (await t.pool.query("SELECT id FROM meeting_decisions WHERE tier = 'host' ORDER BY ordinal")).rows as { id: string }[];
      await followThrough.decisions.review(meetingId, first.id, HOST, { verdict: "confirmed" });
      await followThrough.decisions.review(meetingId, second.id, HOST, { verdict: "not_decided" });
      await run();
      expect((await t.pool.query("SELECT impact_status FROM meeting_decisions WHERE id = $1", [first.id])).rows[0].impact_status).toBe("done");
      expect(world.calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);

      // 对照：本体是通的，整卡确认后写一条。
      await followThrough.decisions.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1`]);
    } finally {
      await t.close();
    }
  });

  it("确认后写一条整场事件：category meeting、幂等键 v1、正文是整份记录、带写入声明和妙记链接；读回核对后才算已写入", async () => {
    const world = ontology();
    const { t, ceo, host, owner, meetingId } = await setup();
    try {
      const { service, run } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      await run();
      // 确认前改挂点：只存，不写。
      expect((await putAnchors(t, host, meetingId, [{ kind: "mission", id: "m-v2" }])).statusCode).toBe(200);
      await run();
      expect(world.writes()).toEqual([]);
      expect((await worldOf(t, host, meetingId)).world.record).toEqual({ status: "pending", version: 0, eventId: null, confirmedAt: null });
      await t.pool.query("UPDATE meetings SET minute_token = 'obcnminute1' WHERE id = $1", [meetingId]);

      // 只有主持人或创建人能确认（这场会没记创建人，按主持人算）。
      expect(await service.confirmRecord(meetingId, OWNER, { writeToWorld: true })).toMatchObject({ error: { status: 404 } });
      expect(await service.confirmRecord(meetingId, CEO, { writeToWorld: true })).toMatchObject({ error: { status: 404 } });
      const confirmed = await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      expect(confirmed).toMatchObject({ world: { record: { status: "pending", version: 1, eventId: null, confirmedAt: "2026-06-01T04:00:00.000Z" } } });
      expect((await t.pool.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync' AND status = 'pending'")).rows[0].n).toBe(1);
      await run();

      expect(world.writes()).toHaveLength(1);
      const body = world.writes()[0];
      expect(body).toEqual({
        action_type: "world_record_event", contract_version: "tkos.world/0.3", target: null, expected_versions: [],
        idempotency_key: `tianshu-meeting:${meetingId}:v1`, reason: expect.any(String),
        params: {
          category: "meeting", subject_refs: ["obj-mission-v2@3"], occurred_at: "2026-06-01T10:00:00+08:00",
          content: { text: expect.any(String), artifacts: [`${FEISHU}/minutes/obcnminute1`] },
          declaration: { scene: "obj-mission-v2@3", trigger: "天枢会议记录确认", human_acceptance: { required: false } },
        },
      });
      expect(body.params.content.text.split("\n")).toEqual([
        "会议：接口切换会", "时间：2026-06-01 10:00–11:00（北京时间）", "主持人：测试乙", "参会人：测试甲、测试乙、测试丙",
        "", "摘要：", CANDIDATE.summary,
        "", "决定：", "1. 接口统一改成 v2，月底前切换",
        "", "分歧：", "1. 渠道预算下周看数据再定",
        "", "待办：", "1. 渠道看板接到 v2（测试丙，2026-06-30 前）",
        "", "确认：测试乙 2026-06-01 12:00（北京时间）", `天枢会议：${meetingId}`, "确认版本：v1",
      ]);
      expect(body.params.content.text).not.toContain(TURNS[0].text);
      // 读回：写完按挂点对象取事件，带 since。
      const readBack = world.calls.find((call) => call.url.pathname === "/v1/world/objects/obj-mission-v2/events")!;
      expect(readBack.url.searchParams.get("since")).toBe("2026-06-01T10:00:00+08:00");

      // 主持人、CEO 看得到记录状态；参会人看不到。
      const hostView = await worldOf(t, host, meetingId);
      expect(Value.Check(MeetingWorldResponse, hostView)).toBe(true);
      expect(hostView.world).toMatchObject({ excluded: false, anchors: [MISSION], record: { status: "committed", version: 1, eventId: "ev-1" } });
      expect((await worldOf(t, ceo, meetingId)).world.record).toMatchObject({ status: "committed", eventId: "ev-1" });
      expect((await worldOf(t, owner, meetingId)).world).toMatchObject({ record: null, at: null, canEdit: false, anchors: [MISSION] });
      // 逐条决定不再各写一条事件。
      expect(world.writes()).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("修改另记一条并指回前次：原样再确认不写；改了挂点显示修改待确认，再确认记 v2，refs 指回第一条，写明改了什么、原因、确认人和时间", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup();
    try {
      const { service, run, clock } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      const first = world.writes()[0];
      expect(first.params).toMatchObject({ subject_refs: ["obj-unit-07@2"] });
      expect(first.params.content).not.toHaveProperty("refs");
      expect(first.params.content.artifacts).toEqual([]);

      // 什么都没改，再确认一次：不写、不升版本，只刷新确认时刻。
      clock.now = new Date("2026-06-01T12:30:00+08:00");
      expect(await service.confirmRecord(meetingId, HOST, { writeToWorld: true })).toMatchObject({ world: { record: { status: "committed", version: 1, eventId: "ev-1",
        confirmedAt: "2026-06-01T04:30:00.000Z" } } });
      await run();
      expect(world.writes()).toHaveLength(1);

      // 确认后改挂点：修改待确认，不写。
      expect((await putAnchors(t, host, meetingId, [{ kind: "mission", id: "m-v2" }])).statusCode).toBe(200);
      await run();
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "edit_pending", version: 1, eventId: "ev-1" });
      expect(world.writes()).toHaveLength(1);

      clock.now = new Date("2026-06-02T09:00:00+08:00");
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true, reason: "挂错了对象" });
      await run();
      expect(world.writes()).toHaveLength(2);
      const second = world.writes()[1];
      expect(second.idempotency_key).toBe(`tianshu-meeting:${meetingId}:v2`);
      expect(second.params).toMatchObject({ category: "meeting", subject_refs: ["obj-mission-v2@3"], content: { refs: ["event:ev-1"] } });
      expect(second.params).not.toHaveProperty("supersedes_event_id");
      const lines = second.params.content.text.split("\n");
      expect(lines.slice(0, 4)).toEqual(["修改：第 2 版，接前次事件 ev-1", "改了：挂点", "原因：挂错了对象", ""]);
      expect(lines).toContain("会议：接口切换会");
      expect(lines.slice(-3)).toEqual(["确认：测试乙 2026-06-02 09:00（北京时间）", `天枢会议：${meetingId}`, "确认版本：v2"]);
      expect((await worldOf(t, host, meetingId)).world).toMatchObject({ anchors: [MISSION], record: { status: "committed", version: 2, eventId: "ev-2" } });
    } finally {
      await t.close();
    }
  });

  it("写入失败后原样再确认：按同一版重试", async () => {
    let failing = true;
    const world = ontology({ failing: () => failing });
    const { t, host, meetingId } = await setup();
    try {
      const { service, run } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "failed", version: 1, eventId: null });

      failing = false;
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1`, `tianshu-meeting:${meetingId}:v1`]);
      // 重试是原样重放第一次的请求（台账里的那份）。
      expect(world.writes()[1]).toEqual(world.writes()[0]);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 1, eventId: "ev-1" });
    } finally {
      await t.close();
    }
  });

  it("写的时候又确认了一版：写进去的那条照样接到链上，新版 refs 指回它、和它比改了什么", async () => {
    let interleave: (() => Promise<void>) | null = null;
    const world = ontology({ beforeCommit: async () => { const run = interleave; interleave = null; await run?.(); } });
    const { t, host, meetingId } = await setup();
    try {
      const { service, run } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      expect((await putAnchors(t, host, meetingId, [{ kind: "mission", id: "m-v2" }])).statusCode).toBe(200);
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      // v2 提交前，主持人又把挂点改回自动、再确认一次（v3）。
      interleave = async () => {
        expect((await putAnchors(t, host, meetingId, null)).statusCode).toBe(200);
        expect(await service.confirmRecord(meetingId, HOST, { writeToWorld: true, reason: "挂回单元" })).toMatchObject({ world: { record: { version: 3 } } });
      };
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([1, 2, 3].map((version) => `tianshu-meeting:${meetingId}:v${version}`));
      const third = world.writes()[2];
      expect(third.params.content.refs).toEqual(["event:ev-2"]);
      expect(third.params.content.text.split("\n").slice(0, 3)).toEqual(["修改：第 3 版，接前次事件 ev-2", "改了：挂点", "原因：挂回单元"]);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 3, eventId: "ev-3" });
    } finally {
      await t.close();
    }
  });

  it("正文超过 3000 字不让确认（不截断），本体不收请求；选不写入照样能确认", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup();
    try {
      const { service, run } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      await t.pool.query("UPDATE meetings SET outcome = jsonb_set(outcome, '{summary}', to_jsonb($2::text)) WHERE id = $1", [meetingId, "长".repeat(3000)]);
      expect(await service.confirmRecord(meetingId, HOST, { writeToWorld: true })).toMatchObject({ error: { status: 400, code: "RECORD_TOO_LONG" } });
      await run();
      expect(world.calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
      expect((await worldOf(t, host, meetingId)).world.record).toEqual({ status: "pending", version: 0, eventId: null, confirmedAt: null });
      expect(await service.confirmRecord(meetingId, HOST, { writeToWorld: false })).toMatchObject({ world: { record: { status: "excluded", version: 0 } } });
    } finally {
      await t.close();
    }
  });

  it("选了不写入不发请求：只留天枢记录；写过的再选不写入也不追加，原事件保留", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup();
    try {
      const { service, run } = serviceFor(t);
      await hostReviews(t, service, meetingId);
      const excluded = await service.confirmRecord(meetingId, HOST, { writeToWorld: false });
      expect(excluded).toMatchObject({ world: { excluded: true, excludedBy: "测试乙", record: { status: "excluded", version: 0, eventId: null } } });
      await run();
      expect(world.calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "excluded" });

      // 改成写入：这是第一次真写，版本是 v1。
      await service.confirmRecord(meetingId, HOST, { writeToWorld: true });
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1`]);

      // 已写入后再选不写入：不追加，原事件留着。
      await service.confirmRecord(meetingId, HOST, { writeToWorld: false });
      await run();
      expect(world.writes()).toHaveLength(1);
      expect((await worldOf(t, host, meetingId)).world).toMatchObject({ excluded: true, record: { status: "excluded", version: 1, eventId: "ev-1" } });
    } finally {
      await t.close();
    }
  });

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

describe("会议事件写本体（WorldClient）", () => {
  const MEETING_ID = "m1m1m1m1-0000-4000-8000-000000000001";
  const LTO = { object_id: "lto-1", object_type: "LongTermGoal", title: "E&O 长期目标", revision_id: "r1", object_version: 4, version: 4, lifecycle: {}, contract_version: "tkos.world/0.3" };
  const unit = { object_id: "unit-07", object_type: "ResponsibilityUnit", title: "Agents", revision_id: "r1", object_version: 2, version: 2, lifecycle: {}, contract_version: "tkos.world/0.3" };

  it("挂点按组回退：LTO 按本体编号取，对不上的组跳过；写完读回找到才返回；读回找不到报 READBACK_MISMATCH；没有妙记时不带原文链接", async () => {
    await withWorld(async (client, db) => {
      await db.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code) VALUES ('agents', 1, '智能体', 'test', '', '07')");
      let events = 0;
      let readable = true;
      const calls = stubWorld((call) => {
        const path = call.url.pathname;
        if (path === "/v1/world/objects") return { items: call.url.searchParams.get("external_id") === "capability:07" ? [unit] : [], next_cursor: null };
        if (path === "/v1/world/objects/unit-07") return projection(unit);
        if (path === "/v1/world/objects/lto-1") return projection(LTO);
        if (path === "/v1/world/objects/lto-missing") return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no" } }), { status: 404 });
        if (path.endsWith("/events")) return { events: readable ? [{ event_id: `ev-${events}` }] : [] };
        if (path === "/v1/actions/prepare") return { expected_versions: [] };
        if (path === "/v1/actions") return { receipt_id: `r${++events}`, status: "committed", result: { event_id: `ev-${events}` } };
        throw new Error(`unexpected ${path}`);
      });
      const world = createMeetingEventWorld({ q: (sql, params) => db.pool.query(sql, params), client, feishuWebOrigin: "https://tokenking.feishu.cn/" });
      const write = (anchorGroups: TWorldAnchor[][], extra: { minuteToken?: string | null; previousEventId?: string | null; version?: number } = {}) => world.write({
        meetingId: MEETING_ID, version: extra.version ?? 1, text: "会议：接口切换会", occurredAt: new Date("2026-10-19T14:00:00+08:00"), anchorGroups,
        previousEventId: extra.previousEventId ?? null, minuteToken: extra.minuteToken === undefined ? "obcn1" : extra.minuteToken,
      });

      // LTO 用本体编号直接取（不落到公司）。
      expect(await write([[{ kind: "lto", id: "lto-1", title: "选时的标题" }]])).toEqual({ eventId: "ev-1", anchors: [{ kind: "lto", id: "lto-1", title: "E&O 长期目标" }] });
      expect(calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body).toMatchObject({
        idempotency_key: `tianshu-meeting:${MEETING_ID}:v1`,
        params: { category: "meeting", subject_refs: ["lto-1@4"], occurred_at: "2026-10-19T14:00:00+08:00",
          content: { text: "会议：接口切换会", artifacts: ["https://tokenking.feishu.cn/minutes/obcn1"] }, declaration: { scene: "lto-1@4" } },
      });
      // 第一组在本体里没有：退到单元；有前次事件时 content.refs 指回它。
      expect(await write([[{ kind: "lto", id: "lto-missing", title: "没了" }], [{ kind: "unit", id: "agents", title: "智能体" }]], { previousEventId: "ev-1", version: 2, minuteToken: null }))
        .toEqual({ eventId: "ev-2", anchors: [{ kind: "unit", id: "agents", title: "Agents" }] });
      const second = calls.filter((call) => call.url.pathname === "/v1/actions").at(-1)!.body;
      expect(second.params).toMatchObject({ subject_refs: ["unit-07@2"], content: { refs: ["event:ev-1"], artifacts: [] } });

      readable = false;
      await expect(write([[{ kind: "unit", id: "agents", title: "智能体" }]], { version: 3 })).rejects.toMatchObject({ code: "READBACK_MISMATCH" });
      // 一组都对不上：不发写请求。
      const before = calls.length;
      await expect(write([[{ kind: "mission", id: "missing", title: "不存在" }]], { version: 4 })).rejects.toMatchObject({ code: "NO_ANCHOR" });
      expect(calls.slice(before).filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
    });
  });
});
