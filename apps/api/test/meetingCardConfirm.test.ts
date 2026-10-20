import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardView, type TMeetingCardView, type TMeetingWorldResponse } from "@warmap/contracts";
import { createTestApp, preflightCandidate, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import type { PostMeetingAgent } from "../src/outcome.js";
import type { PreflightAgent, PreflightAgentInput } from "../src/meetingPreflight.js";
import { createJobWorker } from "../src/jobs.js";
import { payloadHash } from "../src/meetingCardHash.js";
import { hashSecret } from "../src/session.js";
import { projection, stubWorld, worldEnv } from "./worldFixture.js";

// 整卡确认（FR-5.1、5.3、5.5）：主持人或创建人带草稿版本确认 → 冻结一版 → 写一条整场会议事件，正文是 {payload, confirmation} 的 JSON；
// 修改分更正原记录（correction）和会后新决定（新 meeting 事件指回前次）。
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const CEO = TEST_CEO.personId;
const HOST = TEST_MEMBER.personId;
const OWNER = "person-fixture-003";
const OWNER_LOGIN = { loginId: "ceshib", passcode: "3579" };
const OCCURRED = "2026-06-01T10:02:00+08:00";

const TURNS = [
  { id: "turn-001", speakerId: CEO, text: "渠道预算这个月先不动，下周再看数据。" },
  { id: "turn-002", speakerId: HOST, text: "接口统一改成 v2，验收标准改成十月底前 4 家客户上线。" },
  { id: "turn-003", speakerId: OWNER, text: "好，我月底前把渠道看板接到 v2。" },
];

function cardAgent(objectChanges = [{ targetRef: "obj-po-1#target/acc-1", after: { text: "十月底前 4 家客户上线" }, basisSections: [1] }]): PostMeetingAgent {
  return {
    async generate() {
      return { candidate: {
        summary: "接口统一切到 v2，渠道预算下周再定。",
        sections: [
          { heading: "接口切换", body: "已定：接口统一改成 v2。", turnIds: ["turn-002", "turn-003"] },
          { heading: "渠道预算", body: "未定：渠道预算下周看数据再定。", turnIds: ["turn-001"] },
        ],
        objectChanges,
        actionItems: [{ text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", basisSections: [1] }],
      } };
    },
  };
}
const preflightAgent: PreflightAgent = { async generate(input: PreflightAgentInput) { return { candidate: preflightCandidate(input.issues.map((issue) => `issue:${issue.id}`)) }; } };

type Written = { eventId: string; body: any };
/**
 * 假本体：挂点 PO（版本 5）；记事件按幂等键去重（同键重放回原回执）；取事件返回 subject_refs 挂到这个对象上的事件（带 content）。
 * network() 为 true 时记事件请求抛网络错误；beforeCommit 在每次记事件（prepare 之后、提交之前）先跑；readable() 为 false 时取事件为空。
 */
function ontology({ network = () => false, beforeCommit, readable = () => true }: { network?: () => boolean; beforeCommit?: () => Promise<void>; readable?: () => boolean } = {}) {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  const recorded: Written[] = [];
  const calls = stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/actions/prepare") return { expected_versions: [] };
    if (path === "/v1/actions") {
      await beforeCommit?.();
      if (network()) throw new TypeError("fetch failed");
      const event = recorded.find((item) => item.body.idempotency_key === call.body.idempotency_key)
        ?? recorded[recorded.push({ eventId: `ev-${recorded.length + 1}`, body: call.body }) - 1];
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    const events = path.match(/^\/v1\/world\/objects\/([^/]+)\/events$/);
    if (events) {
      return { events: readable() ? recorded.filter((item) => item.body.params.subject_refs.some((ref: string) => ref.startsWith(`${decodeURIComponent(events[1])}@`)))
        .map((item) => ({ event_id: item.eventId, content: { refs: [], components: [], ...item.body.params.content } })) : [] };
    }
    if (path === `/v1/world/objects/${po.object_id}`) return projection(po);
    return { items: [], next_cursor: null };
  });
  const writes = () => calls.filter((call) => call.url.pathname === "/v1/actions").map((call) => call.body);
  return { po, calls, writes };
}

async function setup(agent: PostMeetingAgent = cardAgent()) {
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, ...worldEnv }, undefined, { preflightAgent, outcomeAgent: agent });
  const ceo = await t.loginCookie();
  const issueCard = await t.createIssue();
  const create = ((issueCard as unknown as { actions: { actionType: string; actionId: string }[] }).actions).find((a) => a.actionType === "issue.create_meeting")!;
  const created = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
    actionId: create.actionId,
    input: { title: "接口切换会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: HOST, ceoParticipantId: CEO, participants: [HOST, OWNER], issueIds: [issueCard.objectRef.id] },
  } });
  const meetingId = created.json().cards[0].objectRef.id as string;
  await t.pool.query("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, JSON.stringify([{ kind: "po", id: "obj-po-1", title: "十月交付" }])]);
  await t.pool.query("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE) ON CONFLICT (person_id) DO NOTHING",
    [OWNER, OWNER_LOGIN.loginId, hashSecret(OWNER_LOGIN.passcode)]);
  const ownerLogin = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: OWNER_LOGIN });
  const owner = String(ownerLogin.headers["set-cookie"]).split(";")[0];
  const imported = await t.app.inject({ method: "POST", url: `/api/dri/meetings/${meetingId}/transcript`, headers: { authorization: `Bearer ${t.env.driServiceToken}` },
    payload: { schemaVersion: "warmap-transcript.v1", meetingId, turns: TURNS } });
  expect(imported.statusCode).toBe(200);
  const host = await t.memberCookie();
  const worker = createJobWorker({ pool: t.pool, handlers: t.app.meetingFollowThrough.jobs().handlers });
  const run = async () => { while (await worker.tick() > 0); };
  return { t, ceo, host, owner, meetingId, run };
}

const getCard = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingCardView> => {
  const res = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/card`, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const putDraft = (t: TestApp, cookie: string, meetingId: string, payload: unknown) =>
  t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/card/draft`, headers: { cookie, origin: t.publicOrigin }, payload });
const confirm = (t: TestApp, cookie: string, meetingId: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/card/confirm`, headers: { cookie, origin: t.publicOrigin }, payload });
const retry = (t: TestApp, cookie: string, meetingId: string) =>
  t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/card/retry`, headers: { cookie, origin: t.publicOrigin } });
const worldOf = async (t: TestApp, cookie: string, meetingId: string): Promise<TMeetingWorldResponse> =>
  (await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world`, headers: { cookie } })).json();

/** 改草稿（edit 改一份拷贝），返回保存后的视图。 */
async function edit(t: TestApp, cookie: string, meetingId: string, change: (draft: NonNullable<TMeetingCardView["draft"]>) => void): Promise<TMeetingCardView> {
  const view = await getCard(t, cookie, meetingId);
  const draft = structuredClone(view.draft!);
  change(draft);
  const res = await putDraft(t, cookie, meetingId, { draftVersion: view.draftVersion, draft, actionItems: view.actionItems });
  expect(res.statusCode).toBe(200);
  return res.json();
}
/** 填上实际开始（服务导入的逐字稿没有），返回可确认的草稿版本。 */
const ready = async (t: TestApp, host: string, meetingId: string) => (await edit(t, host, meetingId, (draft) => { draft.occurredAt = OCCURRED; })).draftVersion;
const parsed = (body: any) => JSON.parse(body.params.content.text) as { payload: any; confirmation: any };

afterEach(() => vi.unstubAllGlobals());

describe("整卡确认与会议事件", () => {
  it("确认后写一条整场事件：正文是 payload 和 confirmation 的 JSON，subject_refs 是带版本的挂点，读回核对后才算写成", async () => {
    const world = ontology();
    const { t, ceo, host, owner, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      // 只有主持人或创建人能确认（议题建会没记创建人，按主持人算）：参会人、CEO 都 404。
      expect((await confirm(t, owner, meetingId, { draftVersion, writeToWorld: true })).statusCode).toBe(404);
      expect((await confirm(t, ceo, meetingId, { draftVersion, writeToWorld: true })).statusCode).toBe(404);
      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      const view: TMeetingCardView = res.json();
      expect(Value.Check(MeetingCardView, view)).toBe(true);
      expect(view.confirmed).toMatchObject({ kind: "first", confirmation: { revision: 1, confirmedBy: "测试乙" }, payload: { revision: 1, relatedObjectRefs: ["obj-po-1@5"] } });
      expect(view.confirmed!.confirmation.payloadHash).toBe(payloadHash(view.confirmed!.payload));
      expect(view.confirmed!.payload.objectChanges[0]).not.toHaveProperty("stale");
      expect(view.sync).toMatchObject({ revision: 1, writeToWorld: true, event: { status: "pending", eventId: null }, objects: [] });
      // 第一次确认：会议算处理完。
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");
      // 行动项快照留在确认表，不进 payload。
      expect((await t.sql("SELECT action_items FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].action_items).toEqual(view.actionItems);
      expect(view.confirmed!.payload).not.toHaveProperty("actionItems");
      await run();

      expect(world.writes()).toHaveLength(1);
      const body = world.writes()[0];
      expect(body).toMatchObject({ action_type: "world_record_event", idempotency_key: `tianshu-meeting:${meetingId}:v1`,
        params: { category: "meeting", subject_refs: ["obj-po-1@5"], occurred_at: "2026-06-01T10:02:00+08:00",
          declaration: { scene: "obj-po-1@5", trigger: "会议记录整卡确认", human_acceptance: { required: false } } } });
      expect(body.params).not.toHaveProperty("supersedes_event_id");
      expect(Object.keys(body.params.content).sort()).toEqual(["artifacts", "text"]);
      expect(body.params.content.artifacts).toEqual([view.confirmed!.payload.sources[0].url]);
      const { payload, confirmation } = parsed(body);
      expect(payload).toEqual(view.confirmed!.payload);
      expect(payload.revision).toBe(1);
      expect(confirmation.payloadHash).toBe(payloadHash(payload));

      const after = await getCard(t, host, meetingId);
      expect(after.sync).toMatchObject({ event: { status: "succeeded", eventId: "ev-1", error: null } });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 1, eventId: "ev-1" });
      // CEO 能读确认版。
      expect((await getCard(t, ceo, meetingId)).confirmed).toEqual(after.confirmed);
    } finally {
      await t.close();
    }
  });

  it("建会到确认之前不写本体", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await ready(t, host, meetingId);
      await edit(t, host, meetingId, (draft) => { draft.summary = "改过的摘要"; });
      await run();
      expect(world.calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
      expect((await getCard(t, host, meetingId))).toMatchObject({ confirmed: null, sync: null });
    } finally {
      await t.close();
    }
  });

  it("草稿版本过期不让确认", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await ready(t, host, meetingId);
      const res = await confirm(t, host, meetingId, { draftVersion: 1, writeToWorld: true });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DRAFT_CHANGED", view: { draftVersion: 2, confirmed: null } });
      await run();
      expect(world.writes()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("同一草稿重复确认不出新版本", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      const first = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).json() as TMeetingCardView;
      const second = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true, kind: "correction" });
      expect(second.statusCode).toBe(200);
      expect((second.json() as TMeetingCardView).confirmed).toEqual(first.confirmed);
      expect(first.confirmed!.confirmation.revision).toBe(1);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].n).toBe(1);
      await run();
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect(world.writes()).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("重试正文一致：写入结果未知时按同一键重放同一正文", async () => {
    let down = true;
    const world = ontology({ network: () => down });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "pending", eventId: null });

      down = false;
      const retried = await retry(t, host, meetingId);
      expect(retried.statusCode).toBe(200);
      await run();
      const [first, second] = world.writes();
      expect(second).toEqual(first);
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1" });
      // 写成之后没有可重试的。
      expect((await retry(t, host, meetingId)).statusCode).toBe(409);
    } finally {
      await t.close();
    }
  });

  it("写成但读回对不上：记失败和原因；同一草稿再确认按同一版重写", async () => {
    let readable = false;
    const world = ontology({ readable: () => readable });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      const failed = await getCard(t, host, meetingId);
      expect(failed.sync!.event).toMatchObject({ status: "failed", eventId: null, error: expect.stringContaining("READBACK_MISMATCH") });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "failed", version: 1 });

      readable = true;
      const again = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).json() as TMeetingCardView;
      expect(again.confirmed!.confirmation.revision).toBe(1);
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1`, `tianshu-meeting:${meetingId}:v1`]);
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1" });
    } finally {
      await t.close();
    }
  });

  it("没有对象修改也能确认", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup(cardAgent([]));
    try {
      const draftVersion = await ready(t, host, meetingId);
      expect((await getCard(t, host, meetingId)).draft!.objectChanges).toEqual([]);
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).statusCode).toBe(200);
      await run();
      expect(world.writes()).toHaveLength(1);
      expect(parsed(world.writes()[0]).payload.objectChanges).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("没填实际时间不让确认", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      const res = await confirm(t, host, meetingId, { draftVersion: 1, writeToWorld: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("OCCURRED_AT_REQUIRED");
      // 将来的时刻也不行。
      const future = (await edit(t, host, meetingId, (draft) => { draft.occurredAt = "2999-01-01T10:00:00+08:00"; })).draftVersion;
      expect((await confirm(t, host, meetingId, { draftVersion: future, writeToWorld: true })).json().code).toBe("OCCURRED_AT_REQUIRED");
    } finally {
      await t.close();
    }
  });

  it("选了不写入不发请求", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      const view = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).json() as TMeetingCardView;
      expect(view.sync).toMatchObject({ writeToWorld: false, event: { status: "skipped", eventId: null } });
      await run();
      expect(world.writes()).toEqual([]);
      expect((await worldOf(t, host, meetingId)).world).toMatchObject({ excluded: true, excludedBy: "测试乙", record: { status: "excluded", version: 1, eventId: null } });
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");
    } finally {
      await t.close();
    }
  });

  it("修改必须选原因", async () => {
    ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      const next = await edit(t, host, meetingId, (draft) => { draft.sections[1].body = "已定：渠道预算这个月不动。"; });
      const res = await confirm(t, host, meetingId, { draftVersion: next.draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("KIND_REQUIRED");
    } finally {
      await t.close();
    }
  });

  it("更正写 correction 并替换前次", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      // 改挂点对象的版本（本体那边有人改过），更正仍沿用被更正事件的 subject_refs 和发生时刻。
      world.po.object_version = 6;
      world.po.version = 6;
      const next = await edit(t, host, meetingId, (draft) => { draft.sections[0].body = "已定：接口统一改成 v2，十月底切换。"; draft.occurredAt = "2026-06-01T10:30:00+08:00"; });
      const view = (await confirm(t, host, meetingId, { draftVersion: next.draftVersion, writeToWorld: true, kind: "correction", reason: "记错了切换时间" })).json() as TMeetingCardView;
      expect(view.confirmed).toMatchObject({ kind: "correction", payload: { revision: 2, relatedObjectRefs: ["obj-po-1@6"] } });
      await run();
      const [first, second] = world.writes();
      expect(second.idempotency_key).toBe(`tianshu-meeting:${meetingId}:v2`);
      expect(second.params).toMatchObject({ category: "correction", supersedes_event_id: "ev-1", subject_refs: first.params.subject_refs, occurred_at: first.params.occurred_at });
      expect(second.params.content).not.toHaveProperty("refs");
      expect(parsed(second).payload.sections[0].body).toBe("已定：接口统一改成 v2，十月底切换。");
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 2, eventId: "ev-2" });
    } finally {
      await t.close();
    }
  });

  it("会后新决定另记一条并指回前次", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      const next = await edit(t, host, meetingId, (draft) => { draft.sections.push({ id: "sec-3", heading: "会后补充", body: "已定：会后定了渠道预算下调一成。", sourceRefs: [] }); });
      const before = Date.now();
      await confirm(t, host, meetingId, { draftVersion: next.draftVersion, writeToWorld: true, kind: "followup" });
      await run();
      const second = world.writes()[1];
      expect(second.params).toMatchObject({ category: "meeting", subject_refs: ["obj-po-1@5"], content: { refs: ["event:ev-1"] } });
      expect(second.params).not.toHaveProperty("supersedes_event_id");
      expect(new Date(second.params.occurred_at).getTime()).toBeLessThan(before);
      expect(second.params.occurred_at).toMatch(/\+08:00$/);
    } finally {
      await t.close();
    }
  });

  it("修改没确认前确认版不变", async () => {
    ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed" });
      await edit(t, host, meetingId, (draft) => { draft.sections[1].body = "已定：渠道预算这个月不动。"; });
      const view = await getCard(t, host, meetingId);
      expect(view.confirmed!.payload.sections[1].body).toBe("未定：渠道预算下周看数据再定。");
      expect(view.draft!.sections[1].body).toBe("已定：渠道预算这个月不动。");
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "edit_pending", version: 1, eventId: "ev-1" });
    } finally {
      await t.close();
    }
  });

  it("写入中又确认，新版指回刚写成的那条", async () => {
    let interleave: (() => Promise<void>) | null = null;
    const world = ontology({ beforeCommit: async () => { const step = interleave; interleave = null; await step?.(); } });
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      const v2 = await edit(t, host, meetingId, (draft) => { draft.summary = "第二版摘要"; });
      await confirm(t, host, meetingId, { draftVersion: v2.draftVersion, writeToWorld: true, kind: "followup" });
      // v2 提交前，主持人又改了一版并确认（v3）。
      interleave = async () => {
        const v3 = await edit(t, host, meetingId, (draft) => { draft.summary = "第三版摘要"; });
        const res = await confirm(t, host, meetingId, { draftVersion: v3.draftVersion, writeToWorld: true, kind: "followup" });
        expect((res.json() as TMeetingCardView).confirmed!.confirmation.revision).toBe(3);
      };
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([1, 2, 3].map((revision) => `tianshu-meeting:${meetingId}:v${revision}`));
      expect(world.writes()[2].params.content.refs).toEqual(["event:ev-2"]);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 3, eventId: "ev-3" });
    } finally {
      await t.close();
    }
  });
});
