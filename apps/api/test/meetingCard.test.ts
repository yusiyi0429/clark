import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardView, type TMeetingCardView } from "@warmap/contracts";
import { createTestApp, preflightCandidate, seedLegacyOutcome, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import { runOutcome, type PostMeetingAgent, type PostMeetingAgentInput } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createJobWorker } from "../src/jobs.js";
import { buildCardDraft, prepareCardGeneration, stripEmphasis } from "../src/meetingCard.js";
import { hashSecret } from "../src/session.js";
import { signActionId } from "../src/actionToken.js";
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

/** 假模型：两段、一条决策、一条行动项（会后整理不拟对象修改，给空数组）。 */
function cardAgent() {
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
        decisions: [{ text: "接口统一改成 v2", ownerPersonId: OWNER, basisSections: [1] }],
        objectChanges: [],
        actionItems: [{ text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSections: [1] }],
      } };
    },
  };
  return { agent, calls };
}
/** 10/28 之前的会议卡上那处修改（当时由模型拟、服务填目标）：直接放进草稿，草稿版本不动；存草稿、读卡刷新这些照旧要处理它。 */
const legacyChange = (t: TestApp, meetingId: string) => t.pool.query("UPDATE meeting_cards SET draft = jsonb_set(draft, '{objectChanges}', $2::jsonb) WHERE meeting_id = $1",
  [meetingId, JSON.stringify([{ id: "chg-1", targetRef: ACCEPTANCE, targetTitle: "十月交付 · 验收标准", expectedVersion: 5,
    before: { text: "十月底前 3 家客户上线" }, after: { text: "十月底前 4 家客户上线" }, basisSectionIds: ["sec-1"], stale: false }])]);
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

async function setup(agent: PostMeetingAgent, options: { createdBy?: string; feishu?: boolean } = {}) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, ...worldEnv,
    ...(options.feishu ? { feishu: { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 } } : {}) }, undefined, { preflightAgent, outcomeAgent: agent });
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: { actionType: string; actionId: string }[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  const meetingId = created.json().cards[0].objectRef.id as string;
  // 建会时挂到本月 PO（本体编号）。
  await t.pool.query("UPDATE meetings SET world_anchors = $2::jsonb, created_by = $3 WHERE id = $1",
    [meetingId, JSON.stringify([{ kind: "po", id: "obj-po-1", title: "十月交付" }]), options.createdBy ?? null]);
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
        { targetRef: ACCEPTANCE, title: "十月交付 · 验收标准", componentType: "acceptance_criterion", text: "十月底前 3 家客户上线" },
        { targetRef: "obj-po-1#target/out-1", title: "十月交付 · 结果", componentType: "outcome", text: "首批客户用上 v2" },
      ]);
      const view = await viewOf(t, host, meetingId);
      expect(Value.Check(MeetingCardView, view)).toBe(true);
      expect(view).toMatchObject({ draftVersion: 1, draftStatus: "draft_ready", canEdit: true, confirmed: null, sync: null });
      const draft = view.draft!;
      // 服务导入的逐字稿没有记下实际开始：occurredAt 为 null，不拿预约时间顶。
      expect(draft).toMatchObject({ schemaVersion: "meeting-card.v1", meetingId, title: "接口切换会", occurredAt: null,
        summary: "接口统一切到 v2，渠道预算下周再定。", relatedObjectRefs: ["obj-po-1"] });
      expect(draft.sections.map((section) => section.id)).toEqual(["sec-1", "sec-2"]);
      expect(draft.sections.map((section) => section.sourceRefs)).toEqual([
        [{ sourceId: "src-1", locator: "turn-002..turn-003" }], [{ sourceId: "src-1", locator: "turn-001" }],
      ]);
      expect(draft.sources).toHaveLength(1);
      expect(draft.sources[0]).toMatchObject({ id: "src-1", title: "接口切换会", sourceVersion: null, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(draft.participants.map((person) => person.name)).toEqual(["测试甲", "测试乙", "测试丙"]);
      // 会后整理不拟对象修改（斯一 10/28 第 7 条）。
      expect(draft.objectChanges).toEqual([]);
      const pending = { status: "pending", by: null, at: null, reason: null };
      expect(view.actionItems).toEqual([{ id: "act-1", text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSectionIds: ["sec-1"], taskId: null, review: pending }]);
      // 决策单列：一句话、责任人（这场会的人）、出处段落，待确认。
      expect(view.decisions).toEqual([{ id: "dec-1", text: "接口统一改成 v2", ownerPersonId: OWNER, basisSectionIds: ["sec-1"], review: pending }]);
      expect(view).toMatchObject({ hostId: HOST, writeToWorld: true });

      // 会后整理只记进度：没有逐条条目和摘要，没有分层任务、主持人条目，也没有推成执行事项（确认后才推）。
      const row = (await t.sql("SELECT status, outcome FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(row.outcome).toMatchObject({ status: "ready", items: [], summary: "" });
      const worker = createJobWorker({ pool: t.pool, handlers: t.app.meetingFollowThrough.jobs().handlers });
      while (await worker.tick() > 0);
      // 生成只排一次 48 小时后的冻结（没有分层、提醒、代判）：跑完能跑的之后队列里只剩它。
      expect(await t.sql("SELECT kind FROM jobs WHERE status <> 'done'")).toEqual([{ kind: "meeting.card_freeze" }]);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_decisions WHERE meeting_id = $1", [meetingId]))[0].n).toBe(0);
      expect(await taskCount(t, meetingId)).toBe(tasksBefore);
    } finally {
      await t.close();
    }
  });

  it("模型给了修改也丢掉；能编辑的人照样拿到挂点对象里有文字的组件", async () => {
    ontology();
    const { agent } = cardAgent();
    const { t, host, meetingId } = await setup(agent);
    try {
      const { candidate } = await agent.generate({} as PostMeetingAgentInput);
      const built = buildCardDraft(t.pool, await prepareCardGeneration(t.pool, meetingId), { ...(candidate as object),
        objectChanges: [{ targetRef: ACCEPTANCE, after: { text: "十月底前 4 家客户上线" }, basisSections: [1] }] });
      expect(built!.draft.objectChanges).toEqual([]);
      expect((await viewOf(t, host, meetingId)).targetOptions.map((option) => option.targetRef)).toEqual([ACCEPTANCE, "obj-po-1#target/out-1"]);
    } finally {
      await t.close();
    }
  });

  it("实际开始取飞书妙记或录音记下的开始时刻", async () => {
    ontology();
    const { agent } = cardAgent();
    const { t, meetingId } = await setup(agent);
    try {
      await t.pool.query("UPDATE meetings SET transcript = jsonb_set(transcript, '{source}', $2::jsonb) WHERE id = $1", [meetingId, JSON.stringify({
        format: "feishu_minutes", fileName: "minutes.txt", sizeBytes: 10, sha256: "x", parserVersion: "1", timeAnchor: "2026-06-01T10:02:10+08:00" })]);
      const { candidate } = await agent.generate({} as PostMeetingAgentInput);
      const built = buildCardDraft(t.pool, await prepareCardGeneration(t.pool, meetingId), candidate);
      expect(built!.draft.occurredAt).toBe("2026-06-01T02:02:10.000Z");
    } finally {
      await t.close();
    }
  });

  it("出处保留逐句引用：连续的发言并成一处，隔开的各算一处，不合成一个大区间", async () => {
    ontology();
    const { agent } = cardAgent();
    const { t, meetingId } = await setup(agent);
    try {
      const { candidate } = await agent.generate({} as PostMeetingAgentInput);
      const sections = [
        { heading: "接口切换", body: "已定：接口统一改成 v2。", turnIds: ["turn-003", "turn-001"] },
        { heading: "渠道预算", body: "未定：下周再定。", turnIds: ["turn-001", "turn-002", "turn-002"] },
      ];
      const built = buildCardDraft(t.pool, await prepareCardGeneration(t.pool, meetingId), { ...(candidate as object), sections });
      expect(built!.draft.sections.map((section) => section.sourceRefs)).toEqual([
        [{ sourceId: "src-1", locator: "turn-001" }, { sourceId: "src-1", locator: "turn-003" }],
        [{ sourceId: "src-1", locator: "turn-001..turn-002" }],
      ]);
    } finally {
      await t.close();
    }
  });

  it("摘要和正文去掉 Markdown 加粗记号，单个星号、下划线和列表符号不动", async () => {
    expect(stripEmphasis("- **会后记录改为自动获取**：本周跑通。\n- __接口__切到 v2")).toBe("- 会后记录改为自动获取：本周跑通。\n- 接口切到 v2");
    expect(stripEmphasis("3 * 4 = 12，字段 owner_person_id、snake__case__name 照旧，** 不成对 **")).toBe("3 * 4 = 12，字段 owner_person_id、snake__case__name 照旧，** 不成对 **");
    ontology();
    const { agent } = cardAgent();
    const { t, meetingId } = await setup(agent);
    try {
      const { candidate } = await agent.generate({} as PostMeetingAgentInput);
      const built = buildCardDraft(t.pool, await prepareCardGeneration(t.pool, meetingId), { ...(candidate as object),
        summary: "- **接口**：统一切到 v2", sections: [{ heading: "接口切换", body: "已定：- **接口**统一改成 v2", turnIds: ["turn-002"] }] });
      expect(built!.draft.summary).toBe("- 接口：统一切到 v2");
      expect(built!.draft.sections[0].body).toBe("已定：- 接口统一改成 v2");
    } finally {
      await t.close();
    }
  });

  it("存草稿：整份替换、版本加一，服务重读 before 和版本、忽略前端传的 stale 和 taskId；目标保存前变了标 stale；旧版本 409 带最新视图", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      await legacyChange(t, meetingId);
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
      expect(next.draft!.objectChanges[0]).toMatchObject({ before: { text: "十月底前 3 家客户上线" }, expectedVersion: 5, targetTitle: "十月交付 · 验收标准",
        stale: false, basisSectionIds: ["sec-3"] });
      expect(next.actionItems[0]).toMatchObject({ text: "看板接到 v2", taskId: null });

      // 主持人看的还是 v5 的差异，对象这时被改成 v6：保存按新版本重读原内容，并标 stale 让他重看，不悄悄挪基准。
      world.po.object_version = 6;
      world.po.version = 6;
      world.po.blocks[0].components[0].text = "十月底前 5 家客户上线";
      const resaved = await putDraft(t, host, meetingId, { draftVersion: 2, draft: next.draft, actionItems: next.actionItems });
      expect(resaved.statusCode).toBe(200);
      expect(resaved.json().draft.objectChanges[0]).toMatchObject({ before: { text: "十月底前 5 家客户上线" }, expectedVersion: 6, stale: true });

      // 草稿版本过期不让存：409，带最新视图。
      const stale = await putDraft(t, host, meetingId, { draftVersion: 1, draft });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "DRAFT_CHANGED", view: { draftVersion: 3 } });
    } finally {
      await t.close();
    }
  });

  it("出处指到不存在的来源、目标不在候选里、负责人不是参会人都拒收，fieldErrors 指到字段", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      await legacyChange(t, meetingId);
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
      await legacyChange(t, meetingId);
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

  it("改挂点时草稿的 relatedObjectRefs 跟着改，草稿版本加一；挂点没变不动", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      const same = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: host, origin: t.publicOrigin }, payload: { anchors: [{ kind: "po", id: "obj-po-1" }] } });
      expect(same.statusCode).toBe(200);
      expect((await viewOf(t, host, meetingId)).draftVersion).toBe(1);
      const res = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: host, origin: t.publicOrigin }, payload: { anchors: null } });
      expect(res.statusCode).toBe(200);
      const view = await viewOf(t, host, meetingId);
      expect(view.draft!.relatedObjectRefs).toEqual([]);
      expect(view.draftVersion).toBe(2);
    } finally {
      await t.close();
    }
  });

  it("草稿生成后改挂点：指向不再挂着的对象的修改成目标未定，照常能存", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      await legacyChange(t, meetingId);
      const res = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: host, origin: t.publicOrigin }, payload: { anchors: null } });
      expect(res.statusCode).toBe(200);
      const view = await viewOf(t, host, meetingId);
      expect(view.draft!.objectChanges[0]).toMatchObject({ id: "chg-1", targetRef: null, targetTitle: null, expectedVersion: null, before: null, stale: false,
        after: { text: "十月底前 4 家客户上线" } });
      const draft = structuredClone(view.draft!);
      draft.summary = "改过的摘要";
      const saved = await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as TMeetingCardView).draft!.objectChanges[0]).toMatchObject({ targetRef: null, stale: false });
    } finally {
      await t.close();
    }
  });

  it("目标组件被删了：存草稿时这条成目标未定，不拒收", async () => {
    const world = ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      await legacyChange(t, meetingId);
      const view = await viewOf(t, host, meetingId);
      world.po.blocks[0].components.splice(0, 1);
      const saved = await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft: view.draft });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as TMeetingCardView).draft!.objectChanges[0]).toMatchObject({ targetRef: null, targetTitle: null, expectedVersion: null, before: null, stale: false });
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

// 会后只有会议卡一个入口（FR-5.1、FR-5.2、拍板 4、11）：不再逐条确认，没有 CEO 分流和代判；草稿好了给主持人和创建人各提醒一次。
describe("会后待确认入口", () => {
  const PER_ITEM = ["meeting.confirm_item", "meeting.dismiss_item", "meeting.revoke_effect"];
  const meetingActions = async (t: TestApp, cookie: string, meetingId: string) =>
    ((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie } })).json().cards[0].actions as { actionType: string }[])
      .map((action) => action.actionType);
  const pendingNotices = (t: TestApp, meetingId: string) =>
    t.sql("SELECT person_id, object_type FROM notifications WHERE kind = 'meeting_card_pending' AND object_id = $1 ORDER BY person_id", [meetingId]);
  const myCards = async (t: TestApp, cookie: string) => {
    const res = await t.app.inject({ method: "GET", url: "/api/me/meeting-cards", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json() as { meetings: { meetingId: string; status: string }[]; confirms: { meetingId: string; kind: string; id: string; text: string }[] };
  };

  it("新会议不再给逐条动作；旧会议照旧显示条目，也不再给", async () => {
    ontology();
    const { t, ceo, meetingId } = await setup(cardAgent().agent);
    try {
      expect((await meetingActions(t, ceo, meetingId)).filter((type) => PER_ITEM.includes(type))).toEqual([]);
      // 写成旧格式会议（逐条条目，没有会议卡）：条目还在，确认、忽略、撤回都没有，签好的动作也不受理。
      await seedLegacyOutcome(t.pool, meetingId, { summary: "接口切换", items: [
        { kind: "decision", text: "接口统一改成 v2", turnId: "turn-002", quote: "接口统一改成 v2" },
        { kind: "todo", text: "渠道看板接到 v2", turnId: "turn-003", quote: "我月底前把渠道看板接到 v2", ownerPersonId: OWNER },
      ] });
      const legacy = (await t.sql("SELECT version, outcome FROM meetings WHERE id = $1", [meetingId]))[0];
      expect(legacy.outcome.items).toHaveLength(2);
      expect((await meetingActions(t, ceo, meetingId)).filter((type) => PER_ITEM.includes(type))).toEqual([]);
      const executed = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
        actionId: signActionId(t.env.sessionSecret, { actionType: "meeting.confirm_item", objectType: "meeting", objectId: meetingId,
          objectVersion: legacy.version, itemId: legacy.outcome.items[0].id }),
        input: {},
      } });
      expect(executed.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("记录正文不用确认：草稿好了不提醒主持人和创建人，只排一次 48 小时后的冻结，再存草稿、重新生成都不多排，不推飞书", async () => {
    ontology();
    const { agent } = cardAgent();
    const { t, host, meetingId } = await setup(agent, { createdBy: CEO, feishu: true });
    try {
      expect(await pendingNotices(t, meetingId)).toEqual([]);
      const freezes = () => t.sql("SELECT dedupe_key, run_at > now() + interval '47 hours' AS later FROM jobs WHERE kind = 'meeting.card_freeze'");
      expect(await freezes()).toEqual([{ dedupe_key: `meeting.card_freeze:${meetingId}:48h`, later: true }]);
      const view = await viewOf(t, host, meetingId);
      expect((await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft: { ...view.draft, summary: "改过的摘要" } })).statusCode).toBe(200);
      await t.pool.query(`UPDATE meetings SET outcome = jsonb_set(outcome, '{status}', '"failed"') WHERE id = $1`, [meetingId]);
      await runOutcome(t.pool, agent, meetingId);
      expect((await viewOf(t, host, meetingId)).draftVersion).toBe(3);
      expect(await freezes()).toHaveLength(1);
      expect(await pendingNotices(t, meetingId)).toEqual([]);
      expect(await t.sql("SELECT payload FROM jobs WHERE kind = 'feishu.notify'")).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("到期不代判；生成满 48 小时自动冻结：没人确认的决策不进确认版，没有已确认的决策就不写本体", async () => {
    ontology();
    const { t, host, meetingId } = await setup(cardAgent().agent);
    try {
      // 换成会议卡之前留下的一条待确认主持人条目，早过了原来的代判时刻。
      await t.pool.query(
        `INSERT INTO meeting_decisions (id, meeting_id, tier, ordinal, statement, item_ids, recommendation, next_remind_at, due_at)
         VALUES (gen_random_uuid(), $1, 'host', 1, '接口统一改成 v2', '[]'::jsonb, 'confirmed', now() - interval '2 days', now() - interval '1 day')`,
        [meetingId],
      );
      const jobs = t.app.meetingFollowThrough.jobs();
      const later = new Date(Date.now() + 3 * 24 * 60 * 60_000);
      const worker = createJobWorker({ pool: t.pool, handlers: jobs.handlers, recurring: jobs.recurring, now: () => later });
      while (await worker.tick() > 0);
      expect(await t.sql("SELECT status FROM meeting_decisions WHERE meeting_id = $1", [meetingId])).toEqual([{ status: "pending" }]);
      const view = await viewOf(t, host, meetingId);
      expect(view.confirmed).toMatchObject({ kind: "first", confirmation: { revision: 1, confirmedBy: null },
        payload: { schemaVersion: "meeting-card.v2", decisions: [], actionItems: [], objectChanges: [], occurredAt: "2026-06-01T02:00:00.000Z" } });
      expect(view.sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      expect(view.decisions![0].review.status).toBe("pending");
    } finally {
      await t.close();
    }
  });

  it("通知栏按人列要确认的条目：责任人有决策和行动项，主持人、CEO 没有；冻结后决策不再列，行动项照旧", async () => {
    ontology();
    const { t, ceo, host, owner, meetingId } = await setup(cardAgent().agent, { createdBy: CEO });
    try {
      expect(await myCards(t, owner)).toEqual({ meetings: [], confirms: [
        { meetingId, title: "接口切换会", kind: "decision", id: "dec-1", text: "接口统一改成 v2", dueDate: null },
        { meetingId, title: "接口切换会", kind: "action", id: "act-1", text: "渠道看板接到 v2", dueDate: "2026-06-30" },
      ] });
      expect(await myCards(t, host)).toEqual({ meetings: [], confirms: [] });
      expect(await myCards(t, ceo)).toEqual({ meetings: [], confirms: [] });
      await t.app.meetingFollowThrough.cardConfirm.freeze(meetingId);
      expect((await myCards(t, owner)).confirms.map((item) => item.id)).toEqual(["act-1"]);
    } finally {
      await t.close();
    }
  });
});
