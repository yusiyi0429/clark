import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardView, type TMeetingCardView } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent, PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createJobWorker } from "../src/jobs.js";
import { hashSecret } from "../src/session.js";
import { projection, stubWorld, worldEnv } from "./worldFixture.js";

// 会议卡草稿（FR-4.3–4.5）：逐字稿确认后生成一张统一会议卡草稿，按议题分段带出处，修改定到挂点对象的文本组件；主持人或创建人带 draftVersion 编辑。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId; // 测试甲
const HOST = TEST_MEMBER.personId; // 测试乙：主持人
const OWNER = "person-fixture-003"; // 测试丙：参会人
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };

const TURNS = [
  { id: "turn-001", speakerId: CEO, text: "渠道预算这个月先不动，下周再看数据。" },
  { id: "turn-002", speakerId: HOST, text: "接口统一改成 v2，验收标准改成十月底前 4 家客户上线。" },
  { id: "turn-003", speakerId: OWNER, text: "好，我月底前把渠道看板接到 v2。" },
];
const ACCEPTANCE = "obj-po-1#target/acc-1";

/** 假模型：两段、一条修改、一条行动项；target 可换成别的。 */
function cardAgent(target = ACCEPTANCE) {
  const calls: PostMeetingAgentInput[] = [];
  const agent: PostMeetingAgent = {
    async generate(input) {
      calls.push(input);
      return { candidate: {
        summary: "接口统一切到 v2，渠道预算下周再定。",
        sections: [
          { heading: "接口切换", body: "已定：接口统一改成 v2，测试丙月底前把渠道看板接到 v2。", turnIds: ["turn-002", "turn-003"] },
          { heading: "渠道预算", body: "未定：渠道预算这个月先不动，下周看数据再定。", turnIds: ["turn-001"] },
        ],
        objectChanges: [{ targetRef: target, after: { text: "十月底前 4 家客户上线" }, basisSections: [1] }],
        actionItems: [{ text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSections: [1] }],
      } };
    },
  };
  return { agent, calls };
}
const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

/** 假本体：挂点 PO 带一个验收组件、一个结果组件和一个没有文字的引用组件；版本和文字可以改。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [
      { id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" },
      { id: "out-1", type: "outcome", text: "首批客户用上 v2" },
      { id: "ref-1", type: "reference", refs: [] },
    ] }],
  };
  const other = { ...po, object_id: "obj-other", title: "别的目标", blocks: [{ id: "target", components: [{ id: "x", type: "outcome", text: "别的" }] }] };
  const calls = stubWorld((call) => {
    const object = [po, other].find((item) => call.url.pathname === `/v1/world/objects/${item.object_id}`);
    return object ? projection(object) : { items: [], next_cursor: null };
  });
  return { po, calls };
}

async function setup(agent: PostMeetingAgent) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, ...worldEnv }, undefined, { preflightAgent, outcomeAgent: agent });
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: { actionType: string; actionId: string }[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  const meetingId = created.json().cards[0].objectRef.id as string;
  // 建会时挂到本月 PO（本体编号）。
  await t.pool.query("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([{ kind: "po", id: "obj-po-1", title: "十月交付" }])]);
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)]);
  const ownerLogin = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  const owner = String(ownerLogin.headers["set-cookie"]).split(";")[0];
  const tasksBefore = await taskCount(t, meetingId);
  const imported = await t.app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS } });
  expect(imported.statusCode).toBe(200);
  return { t, ceo, host: await t.memberCookie(), owner, meetingId, tasksBefore };
}
const taskCount = async (t: TestApp, meetingId: string) => (await t.sql("SELECT count(*)::int AS n FROM tasks WHERE origin_meeting_id = $1", [meetingId]))[0].n as number;

const getCard = (t: TestApp, cookie: string, meetingId: string) => t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/card`, headers: { cookie } });
const putDraft = (t: TestApp, cookie: string, meetingId: string, payload: unknown) =>
  t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/card/draft`, headers: { cookie, origin: t.publicOrigin }, payload });
const viewOf = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingCardView> => {
  const res = await getCard(t, cookie, meetingId);
  expect(res.statusCode).toBe(200);
  return res.json();
};

afterEach(() => vi.unstubAllGlobals());

describe("会议卡草稿", () => {
  it("逐字稿确认后生成草稿：按议题分段带出处，行动项留在天枢，不出逐条条目、不分层、不推执行事项", async () => {
    ontology();
    const { agent, calls } = cardAgent();
    const { t, host, meetingId, tasksBefore } = await setup(agent);
    try {
      // 模型拿到挂点对象里有文字的组件作候选目标。
      expect(calls[0].targetOptions).toEqual([
        { targetRef: ACCEPTANCE, title: "十月交付 · acceptance_criterion", componentType: "acceptance_criterion", text: "十月底前 3 家客户上线" },
        { targetRef: "obj-po-1#target/out-1", title: "十月交付 · outcome", componentType: "outcome", text: "首批客户用上 v2" },
      ]);
      const view = await viewOf(t, host, meetingId);
      expect(Value.Check(MeetingCardView, view)).toBe(true);
      expect(view).toMatchObject({ draftVersion: 1, draftStatus: "draft_ready", canEdit: true, confirmed: null, sync: null });
      const draft = view.draft!;
      expect(draft).toMatchObject({ schemaVersion: "meeting-card.v1", meetingId, title: "接口切换会", occurredAt: "2026-06-01T02:00:00.000Z",
        summary: "接口统一切到 v2，渠道预算下周再定。", relatedObjectRefs: ["obj-po-1"] });
      expect(draft.sections.map((section) => section.id)).toEqual(["sec-1", "sec-2"]);
      expect(draft.sections.map((section) => section.sourceRefs)).toEqual([
        [{ sourceId: "src-1", locator: "turn-002..turn-003" }], [{ sourceId: "src-1", locator: "turn-001" }],
      ]);
      expect(draft.sources).toHaveLength(1);
      expect(draft.sources[0]).toMatchObject({ id: "src-1", title: "接口切换会", sourceVersion: null, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(draft.participants.map((person) => person.name)).toEqual(["测试甲", "测试乙", "测试丙"]);
      expect(view.actionItems).toEqual([{ id: "act-1", text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSectionIds: ["sec-1"], taskId: null }]);

      // 会后整理只记进度：没有逐条条目和摘要，没有分层任务、主持人条目，也没有推成执行事项（确认后才推）。
      const row = (await t.sql("SELECT status, outcome FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.outcome).toMatchObject({ status: "ready", items: [], summary: "" });
      const worker = createJobWorker({ pool: t.pool, handlers: t.app.meetingFollowThrough.jobs().handlers });
      while (await worker.tick() > 0);
      expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.decisions_sync'"))[0].n).toBe(0);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_decisions WHERE meeting_id = $1", [meetingId]))[0].n).toBe(0);
      expect(await taskCount(t, meetingId)).toBe(tasksBefore);
    } finally {
      await t.close();
    }
  });

  it("修改定到目标组件：targetRef、组件当前文字、对象版本由服务填", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      const view = await viewOf(t, host, meetingId);
      expect(view.draft!.objectChanges).toEqual([{ id: "chg-1", targetRef: ACCEPTANCE, targetTitle: "十月交付 · acceptance_criterion", expectedVersion: 5,
        before: { text: "十月底前 3 家客户上线" }, after: { text: "十月底前 4 家客户上线" }, basisSectionIds: ["sec-1"], stale: false }]);
      expect(view.targetOptions.map((option) => option.targetRef)).toEqual([ACCEPTANCE, "obj-po-1#target/out-1"]);
    } finally {
      await t.close();
    }
  });

  it("目标不在候选里就是未定", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent("obj-other#target/x").agent);
    try {
      const change = (await viewOf(t, host, meetingId)).draft!.objectChanges[0];
      expect(change).toMatchObject({ targetRef: null, targetTitle: null, before: null, expectedVersion: null, after: { text: "十月底前 4 家客户上线" } });
    } finally {
      await t.close();
    }
  });

  it("存草稿：整份替换、版本加一，服务重读 before 和版本、忽略前端传的 stale 和 taskId；旧版本 409 带最新视图", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      const view = await viewOf(t, host, meetingId);
      const draft = structuredClone(view.draft!);
      draft.sections[1].body = "已定：渠道预算这个月不动。";
      draft.sections.push({ id: "sec-3", heading: "补充", body: "已定：会后补充的一段。", sourceRefs: [] });
      draft.objectChanges[0] = { ...draft.objectChanges[0], before: { text: "乱写" }, expectedVersion: 1, targetTitle: "乱写", stale: true, basisSectionIds: ["sec-3"] };
      const saved = await putDraft(t, host, meetingId, { draftVersion: 1, draft, actionItems: [{ ...view.actionItems[0], taskId: "task-x", text: "看板接到 v2" }] });
      expect(saved.statusCode).toBe(200);
      const next: TMeetingCardView = saved.json();
      expect(next.draftVersion).toBe(2);
      expect(next.draft!.sections.map((section) => section.body)).toEqual([draft.sections[0].body, "已定：渠道预算这个月不动。", "已定：会后补充的一段。"]);
      expect(next.draft!.objectChanges[0]).toMatchObject({ before: { text: "十月底前 3 家客户上线" }, expectedVersion: 5, targetTitle: "十月交付 · acceptance_criterion",
        stale: false, basisSectionIds: ["sec-3"] });
      expect(next.actionItems[0]).toMatchObject({ text: "看板接到 v2", taskId: null });

      // 草稿版本过期不让存：409，带最新视图。
      const stale = await putDraft(t, host, meetingId, { draftVersion: 1, draft });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "DRAFT_CHANGED", view: { draftVersion: 2 } });
    } finally {
      await t.close();
    }
  });

  it("出处指到不存在的来源、目标不在候选里、负责人不是参会人都拒收，fieldErrors 指到字段", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      const view = await viewOf(t, host, meetingId);
      const badSource = structuredClone(view.draft!);
      badSource.sections[0].sourceRefs[0].sourceId = "src-9";
      const res = await putDraft(t, host, meetingId, { draftVersion: 1, draft: badSource });
      expect(res.statusCode).toBe(400);
      expect(res.json().fieldErrors).toHaveProperty(["sections[0].sourceRefs[0].sourceId"]);

      const badTarget = structuredClone(view.draft!);
      badTarget.objectChanges[0].targetRef = "obj-other#target/x";
      const target = await putDraft(t, host, meetingId, { draftVersion: 1, draft: badTarget });
      expect(target.statusCode).toBe(400);
      expect(target.json()).toMatchObject({ code: "INVALID_TARGET", fieldErrors: { "objectChanges[0].targetRef": expect.any(String) } });

      const badOwner = await putDraft(t, host, meetingId, { draftVersion: 1, draft: view.draft, actionItems: [{ ...view.actionItems[0], ownerPersonId: "nobody", dueDate: "2026-02-30" }] });
      expect(badOwner.statusCode).toBe(400);
      expect(Object.keys(badOwner.json().fieldErrors).sort()).toEqual(["actionItems[0].dueDate", "actionItems[0].ownerPersonId"]);

      const empty = structuredClone(view.draft!);
      empty.sections[0].heading = "  ";
      expect((await putDraft(t, host, meetingId, { draftVersion: 1, draft: empty })).json().fieldErrors).toHaveProperty(["sections[0].heading"]);
      expect((await viewOf(t, host, meetingId)).draftVersion).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("目标变了刷新差异：读卡时重读 before、更新版本、标 stale、草稿版本加一；本体读不到时照常返回", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      expect((await viewOf(t, host, meetingId)).draftVersion).toBe(1);
      world.po.object_version = 6;
      world.po.version = 6;
      world.po.blocks[0].components[0].text = "十月底前 5 家客户上线";
      const view = await viewOf(t, host, meetingId);
      expect(view.draftVersion).toBe(2);
      expect(view.draft!.objectChanges[0]).toMatchObject({ before: { text: "十月底前 5 家客户上线" }, expectedVersion: 6, stale: true });
      // 再读不再加版本。
      expect((await viewOf(t, host, meetingId)).draftVersion).toBe(2);

      vi.unstubAllGlobals();
      stubWorld(() => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "down" } }), { status: 503 }));
      const down = await viewOf(t, host, meetingId);
      expect(down).toMatchObject({ draftVersion: 2, targetOptions: [] });
      expect(down.draft!.objectChanges[0]).toMatchObject({ expectedVersion: 6, stale: true });
    } finally {
      await t.close();
    }
  });

  it("改挂点时草稿的 relatedObjectRefs 跟着改，草稿版本加一", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      const res = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: host, origin: t.publicOrigin }, payload: { anchors: null } });
      expect(res.statusCode).toBe(200);
      const view = await viewOf(t, host, meetingId);
      expect(view.draft!.relatedObjectRefs).toEqual([]);
      expect(view.draftVersion).toBe(2);
    } finally {
      await t.close();
    }
  });

  it("只有主持人或创建人能改：参会人 PUT 404、GET 能读但不能改；没参会的人 404", async () => {
    ontology();
    const { t, ceo, owner, meetingId } = await setup(cardAgent().agent);
    try {
      const view = await viewOf(t, owner, meetingId);
      expect(view).toMatchObject({ canEdit: false, targetOptions: [] });
      expect((await putDraft(t, owner, meetingId, { draftVersion: 1, draft: view.draft })).statusCode).toBe(404);
      // CEO 能读，不能改（不是主持人也不是创建人）。
      expect((await viewOf(t, ceo, meetingId)).canEdit).toBe(false);
      expect((await putDraft(t, ceo, meetingId, { draftVersion: 1, draft: view.draft })).statusCode).toBe(404);
      // 飞书参会名单里没有测试丙：他就不算参会人。
      await t.pool.query("UPDATE meetings SET attendees_actual = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([HOST, CEO])]);
      expect((await getCard(t, owner, meetingId)).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
