import { afterEach, describe, expect, it, vi } from "vitest";
import type { TMeetingCardView } from "@warmap/contracts";
import { cardAgent, confirm, getCard, HOST, OWNER, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 会议决策逐条确认（10/28 方案 B）：决策和行动项只由责任人本人逐条确认，不能代确认（斯一第 4 条）；没有责任人的决策由主持人在参会人里补归属，
// 再由那个人确认（斯一第 3 条，10/29 起）；没有负责人的行动项照旧由主持人接下或退回。
// 决策都有了结果或生成满 48 小时冻结一版，写一条会议事件：只带已确认的决策和行动项（各带确认人），不提交对象修改（斯一第 7 条），记录正文默认不写。

/** 假本体：挂点 PO（版本 5，两个文字组件）；记事件按幂等键去重、能读回；修订照收（版本加一）。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", class: "activity", components: [
      { id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" },
      { id: "acc-2", type: "acceptance_criterion", text: "接口用 v1" },
    ] }],
  };
  const events: { eventId: string; body: any }[] = [];
  const calls = stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/actions/prepare") return { expected_versions: [] };
    if (path === "/v1/actions") {
      const body = call.body;
      if (body.action_type === "world_revise_object") {
        for (const block of Object.values(body.params.payload.blocks as Record<string, { components: { id: string; text: string }[] }>)) {
          for (const component of block.components) po.blocks[0].components.find((item) => item.id === component.id)!.text = component.text;
        }
        po.object_version += 1;
        po.version += 1;
        po.revision_id = `obj-po-1-r${po.object_version}`;
        return { receipt_id: `r-${body.idempotency_key}`, status: "committed", result: { version: po.version },
          object_versions: [{ object_id: po.object_id, object_version: po.object_version }] };
      }
      const event = events.find((item) => item.body.idempotency_key === body.idempotency_key) ?? events[events.push({ eventId: `ev-${events.length + 1}`, body }) - 1];
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    if (path === `/v1/world/objects/${po.object_id}/events`) return { events: events.map((item) => ({ event_id: item.eventId, content: item.body.params.content })) };
    if (path === `/v1/world/objects/${po.object_id}`) return projection(po);
    return { items: [], next_cursor: null };
  });
  const actions = (type: string) => calls.filter((call) => call.url.pathname === "/v1/actions" && call.body.action_type === type).map((call) => call.body);
  return { events: () => actions("world_record_event"), revisions: () => actions("world_revise_object") };
}

/** 两条决策：「接口统一改成 v2」责任人测试丙，「验收按 4 家算」没有责任人（主持人补归属）。 */
const TWO_DECISIONS = cardAgent([],
  [{ text: "接口统一改成 v2", ownerPersonId: OWNER, basisSections: [1] }, { text: "验收按 4 家客户上线算", ownerPersonId: null, basisSections: [1] }]);
const V2 = { v2: true };

type Setup = Awaited<ReturnType<typeof setup>>;
const review = (s: Setup, cookie: string, body: Record<string, unknown>) =>
  s.t.app.inject({ method: "POST", url: `/api/meetings/${s.meetingId}/card/reviews`, headers: { cookie, origin: s.t.publicOrigin }, payload: body });
const assign = (s: Setup, cookie: string, body: Record<string, unknown>) =>
  s.t.app.inject({ method: "POST", url: `/api/meetings/${s.meetingId}/card/owners`, headers: { cookie, origin: s.t.publicOrigin }, payload: body });
/** 通知栏里的条目：要补责任人的写成 owner:<决策 id>。 */
const confirmsOf = async (s: Setup, cookie: string) =>
  ((await s.t.app.inject({ method: "GET", url: "/api/me/meeting-cards", headers: { cookie } })).json().confirms as { kind: string; id: string; needsOwner: boolean }[])
    .map((item) => `${item.needsOwner ? "owner" : item.kind}:${item.id}`);
const parsed = (body: any) => JSON.parse(body.params.content.text) as { payload: any; confirmation: any };

afterEach(() => vi.unstubAllGlobals());

describe("会议决策逐条确认", { timeout: 30_000 }, () => {
  it("责任人各自确认；决策都有了结果就冻结，事件只带已确认的决策和行动项（各带确认人），不带记录正文，不提交对象修改", async () => {
    const world = ontology();
    const s = await setup(TWO_DECISIONS, {}, V2);
    try {
      // 有责任人的给责任人，没有的给主持人补归属；行动项给负责人。
      expect(await confirmsOf(s, s.owner)).toEqual(["decision:dec-1", "action:act-1"]);
      expect(await confirmsOf(s, s.host)).toEqual(["owner:dec-2"]);

      const confirmed = await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      expect(confirmed.statusCode).toBe(200);
      expect((confirmed.json().view as TMeetingCardView).decisions![0].review).toEqual({ status: "confirmed", by: OWNER, at: expect.any(String), reason: null });
      // 接下只记在会议卡上，不建执行事项（10/30 起会后分派关掉），也没有「分给你的事」。
      const accepted = await review(s, s.owner, { kind: "action", id: "act-1", verdict: "confirm" });
      expect(accepted.statusCode).toBe(200);
      expect((accepted.json().view as TMeetingCardView).actionItems[0]).toMatchObject({ taskId: null, review: { status: "confirmed", by: OWNER } });
      expect(await s.t.sql("SELECT 1 FROM tasks WHERE origin_meeting_id = $1", [s.meetingId])).toEqual([]);
      expect(await s.t.sql("SELECT 1 FROM notifications WHERE kind = 'meeting_action_assigned'")).toEqual([]);
      expect(await confirmsOf(s, s.owner)).toEqual([]);

      // 主持人补归属给测试丙；不对要写原因。
      expect((await assign(s, s.host, { id: "dec-2", ownerPersonId: OWNER })).statusCode).toBe(200);
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "reject" })).json()).toMatchObject({ code: "REASON_REQUIRED" });
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "reject", reason: "会上没定数" })).statusCode).toBe(200);
      expect(await s.t.sql("SELECT kind FROM jobs WHERE dedupe_key = $1", [`meeting.card_freeze:${s.meetingId}:decided`])).toHaveLength(1);
      await s.run();

      const view = await getCard(s.t, s.host, s.meetingId);
      expect(view.confirmed).toMatchObject({ confirmation: { revision: 1, confirmedBy: null }, payload: { schemaVersion: "meeting-card.v2",
        decisions: [{ id: "dec-1", text: "接口统一改成 v2", ownerPersonId: OWNER, confirmedBy: OWNER }],
        actionItems: [{ id: "act-1", confirmedBy: OWNER }], objectChanges: [] } });
      expect(view.confirmed!.payload.sections.length).toBeGreaterThan(0);
      expect(view.sync).toMatchObject({ writeToWorld: true, event: { status: "succeeded" }, objects: [] });

      expect(world.events()).toHaveLength(1);
      const body = world.events()[0];
      expect(body.params.declaration.trigger).toBe("会议决策逐条确认");
      expect(body.reason).toBe("天枢会议决策逐条确认（测试丙）");
      const { payload } = parsed(body);
      expect(payload).not.toHaveProperty("summary");
      expect(payload).not.toHaveProperty("sections");
      expect(payload.decisions.map((decision: { id: string }) => decision.id)).toEqual(["dec-1"]);
      expect(payload.decisions[0].sourceRefs).toEqual([{ sourceId: "src-1", locator: "turn-002..turn-003" }]);
      // 接下的行动项照样进会议事件，带确认人。
      expect(payload.actionItems).toEqual([expect.objectContaining({ id: "act-1", text: "渠道看板接到 v2", ownerPersonId: OWNER, dueDate: "2026-06-30", confirmedBy: OWNER })]);
      // 确认决策不等于批准修改：一条对象修改都不提交。
      expect(world.revisions()).toEqual([]);

      // 冻结后决策不能再点。
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "confirm" })).json()).toMatchObject({ code: "ALREADY_REVIEWED" });
    } finally {
      await s.t.close();
    }
  });

  it("只有责任人本人能点：主持人和别人都不能替，也不能整卡确认；处理过的不能再点；冻结后没确认的决策不能再点", async () => {
    ontology();
    const s = await setup(TWO_DECISIONS, {}, V2);
    try {
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "confirm" })).statusCode).toBe(404);
      expect((await review(s, s.host, { kind: "decision", id: "dec-1", verdict: "confirm" })).statusCode).toBe(404);
      expect((await review(s, s.host, { kind: "action", id: "act-1", verdict: "confirm" })).statusCode).toBe(404);
      const whole = await confirm(s.t, s.host, s.meetingId, { draftVersion: await ready(s.t, s.host, s.meetingId), writeToWorld: true });
      expect(whole.statusCode).toBe(409);
      expect(whole.json()).toMatchObject({ code: "REVIEW_PER_ITEM" });
      expect((await getCard(s.t, s.host, s.meetingId)).decisions!.map((decision) => decision.review.status)).toEqual(["pending", "pending"]);

      expect((await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" })).statusCode).toBe(200);
      expect(await confirmsOf(s, s.owner)).toEqual(["action:act-1"]);
      const again = await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "ALREADY_REVIEWED", view: { decisions: [{ review: { by: OWNER } }, { review: { status: "pending" } }] } });

      await s.t.app.meetingFollowThrough.cardConfirm.freeze(s.meetingId);
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" })).json()).toMatchObject({ code: "CARD_FROZEN" });
      expect((await getCard(s.t, s.host, s.meetingId)).confirmed!.payload.decisions).toEqual([expect.objectContaining({ id: "dec-1", confirmedBy: OWNER })]);
      // 行动项冻结后还能接下。
      expect((await review(s, s.owner, { kind: "action", id: "act-1", verdict: "reject", reason: "不归我" })).statusCode).toBe(200);
      expect(await s.t.sql("SELECT 1 FROM tasks WHERE origin_meeting_id = $1", [s.meetingId])).toEqual([]);
    } finally {
      await s.t.close();
    }
  });

  it("没有责任人的决策：主持人不能直接确认，只能在参会人里补归属；补上后由那个人本人确认，事件里记他确认", async () => {
    ontology();
    const s = await setup(TWO_DECISIONS, {}, V2);
    try {
      const direct = await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" });
      expect(direct.statusCode).toBe(409);
      expect(direct.json()).toMatchObject({ code: "OWNER_REQUIRED" });
      // 只有主持人能补；只能补参会人；已有责任人的不能改。
      expect((await assign(s, s.owner, { id: "dec-2", ownerPersonId: OWNER })).statusCode).toBe(404);
      expect((await assign(s, s.host, { id: "dec-2", ownerPersonId: "person-not-here" })).json()).toMatchObject({ code: "NOT_PARTICIPANT" });
      expect((await assign(s, s.host, { id: "dec-1", ownerPersonId: HOST })).json()).toMatchObject({ code: "OWNER_SET" });
      expect(await confirmsOf(s, s.owner)).toEqual(["decision:dec-1", "action:act-1"]);

      const assigned = await assign(s, s.host, { id: "dec-2", ownerPersonId: OWNER });
      expect(assigned.statusCode).toBe(200);
      expect((assigned.json().view as TMeetingCardView).decisions![1]).toMatchObject({ ownerPersonId: OWNER, review: { status: "pending", by: null } });
      expect(await confirmsOf(s, s.host)).toEqual([]);
      expect(await confirmsOf(s, s.owner)).toEqual(["decision:dec-1", "decision:dec-2", "action:act-1"]);
      // 补完主持人也不能替他点。
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" })).statusCode).toBe(404);

      expect((await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" })).statusCode).toBe(200);
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "confirm" })).statusCode).toBe(200);
      await s.run();
      expect((await getCard(s.t, s.host, s.meetingId)).confirmed!.payload.decisions).toEqual([
        expect.objectContaining({ id: "dec-1", confirmedBy: OWNER }),
        expect.objectContaining({ id: "dec-2", ownerPersonId: OWNER, confirmedBy: OWNER }),
      ]);
      expect((await assign(s, s.host, { id: "dec-2", ownerPersonId: HOST })).json()).toMatchObject({ code: "CARD_FROZEN" });
    } finally {
      await s.t.close();
    }
  });

  it("冻结前选了不写进本体：冻结后只留天枢；冻结后再改 409", async () => {
    const world = ontology();
    const s = await setup(TWO_DECISIONS, {}, V2);
    try {
      const put = (writeToWorld: boolean) => s.t.app.inject({ method: "PUT", url: `/api/meetings/${s.meetingId}/card/world`,
        headers: { cookie: s.host, origin: s.t.publicOrigin }, payload: { writeToWorld } });
      expect((await s.t.app.inject({ method: "PUT", url: `/api/meetings/${s.meetingId}/card/world`, headers: { cookie: s.owner, origin: s.t.publicOrigin },
        payload: { writeToWorld: false } })).statusCode).toBe(404);
      expect(((await put(false)).json() as TMeetingCardView).writeToWorld).toBe(false);
      await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      await assign(s, s.host, { id: "dec-2", ownerPersonId: OWNER });
      await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "confirm" });
      await s.run();
      expect((await getCard(s.t, s.host, s.meetingId)).sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      expect(world.events()).toEqual([]);
      expect((await put(true)).json()).toMatchObject({ code: "CARD_FROZEN" });
    } finally {
      await s.t.close();
    }
  });

  it("只关会议写本体（MEETING_WORLD_WRITES_OFF，切到 Nexus）：不找人逐条确认（已经在等的也不出），会议卡照常生成、48 小时冻结，只留天枢，不写会议事件", async () => {
    const world = ontology();
    const s = await setup(TWO_DECISIONS, { meetingWorldWritesOff: true }, V2);
    try {
      // 切换前生成的会，决策和行动项本来在等责任人、主持人：开关打开后通知栏（等你、飞书同源）里都没有了。
      expect(await confirmsOf(s, s.owner)).toEqual([]);
      expect(await confirmsOf(s, s.host)).toEqual([]);
      const draft = await getCard(s.t, s.host, s.meetingId);
      expect(draft.worldWritesOff).toBe(true);
      expect(draft.decisions!.map((decision) => decision.text)).toEqual(["接口统一改成 v2", "验收按 4 家客户上线算"]);

      await s.t.app.meetingFollowThrough.cardConfirm.freeze(s.meetingId);
      await s.run();
      const view = await getCard(s.t, s.host, s.meetingId);
      expect(view.confirmed).toMatchObject({ confirmation: { revision: 1, confirmedBy: null }, payload: { decisions: [] } });
      expect(view.sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      expect(world.events()).toEqual([]);
      expect(world.revisions()).toEqual([]);
      expect(await s.t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync'")).toEqual([{ n: 0 }]);
    } finally {
      await s.t.close();
    }
  });

  it("记录正文开关打开（MEETING_WORLD_RECORD_TEXT=1）：没有决策的会生成后直接冻结写入，事件带正文", async () => {
    const world = ontology();
    const s = await setup(cardAgent([], []), { meetingRecordText: true }, V2);
    try {
      await s.run();
      expect(world.events()).toHaveLength(1);
      const body = world.events()[0];
      expect(body.params.declaration.trigger).toBe("会议记录生成");
      expect(body.reason).toBe("天枢会议记录生成");
      const { payload, confirmation } = parsed(body);
      expect(payload.sections.map((section: { heading: string }) => section.heading)).toEqual(["接口切换", "渠道预算"]);
      expect(payload.decisions).toEqual([]);
      expect(confirmation).toMatchObject({ confirmedBy: null, payloadHash: (await getCard(s.t, s.host, s.meetingId)).confirmed!.confirmation.payloadHash });
    } finally {
      await s.t.close();
    }
  });

  it("记录正文开关关着（缺省）：没有决策的会 48 小时冻结后也不写", async () => {
    const world = ontology();
    const s = await setup(cardAgent([], []), {}, V2);
    try {
      await s.run();
      expect((await getCard(s.t, s.host, s.meetingId)).confirmed).toBeNull();
      await s.t.app.meetingFollowThrough.cardConfirm.freeze(s.meetingId);
      await s.run();
      expect((await getCard(s.t, s.host, s.meetingId)).sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      expect(world.events()).toEqual([]);
    } finally {
      await s.t.close();
    }
  });
});
