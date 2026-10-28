import { afterEach, describe, expect, it, vi } from "vitest";
import type { TMeetingCardView } from "@warmap/contracts";
import { cardAgent, getCard, HOST, OWNER, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 会议决策逐条确认（10/28 方案 B）：决策和行动项由责任人（没有就是主持人）逐条确认，主持人可以代确认；
// 决策都有了结果或生成满 48 小时冻结一版，写一条会议事件：只带已确认的决策和行动项（各带确认人），记录正文默认不写（等斯一答复）。

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

/** 两条决策：「接口统一改成 v2」责任人测试丙（带一处修改），「验收按 4 家算」没有责任人（主持人确认，也带一处修改）。 */
const TWO_DECISIONS = cardAgent(
  [
    { targetRef: "obj-po-1#target/acc-2", after: { text: "接口统一切到 v2" }, basisSections: [1], decision: 1 },
    { targetRef: "obj-po-1#target/acc-1", after: { text: "十月底前 4 家客户上线" }, basisSections: [1], decision: 2 },
  ],
  [{ text: "接口统一改成 v2", ownerPersonId: OWNER, basisSections: [1] }, { text: "验收按 4 家客户上线算", ownerPersonId: null, basisSections: [1] }],
);

type Setup = Awaited<ReturnType<typeof setup>>;
const review = (s: Setup, cookie: string, body: Record<string, unknown>) =>
  s.t.app.inject({ method: "POST", url: `/api/meetings/${s.meetingId}/card/reviews`, headers: { cookie, origin: s.t.publicOrigin }, payload: body });
const confirmsOf = async (s: Setup, cookie: string) =>
  ((await s.t.app.inject({ method: "GET", url: "/api/me/meeting-cards", headers: { cookie } })).json().confirms as { kind: string; id: string }[]).map((item) => `${item.kind}:${item.id}`);
const parsed = (body: any) => JSON.parse(body.params.content.text) as { payload: any; confirmation: any };

afterEach(() => vi.unstubAllGlobals());

describe("会议决策逐条确认", { timeout: 30_000 }, () => {
  it("责任人和主持人各自确认；决策都有了结果就冻结，事件只带已确认的决策和行动项（各带确认人），不带记录正文，只提交已确认决策的修改", async () => {
    const world = ontology();
    const s = await setup(TWO_DECISIONS);
    try {
      // 有责任人的给责任人，没有的给主持人；行动项给负责人。
      expect(await confirmsOf(s, s.owner)).toEqual(["decision:dec-1", "action:act-1"]);
      expect(await confirmsOf(s, s.host)).toEqual(["decision:dec-2"]);

      const confirmed = await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      expect(confirmed.statusCode).toBe(200);
      expect((confirmed.json().view as TMeetingCardView).decisions![0].review).toMatchObject({ status: "confirmed", by: OWNER, proxy: false });
      // 接下就推成执行事项；自己接下的不再出「分给你的事」那一条。
      expect((await review(s, s.owner, { kind: "action", id: "act-1", verdict: "confirm" })).statusCode).toBe(200);
      const tasks = await s.t.sql("SELECT id::text, owner_id FROM tasks WHERE origin_meeting_id = $1", [s.meetingId]);
      expect(tasks).toEqual([{ id: expect.any(String), owner_id: OWNER }]);
      expect(await s.t.sql("SELECT read_at IS NOT NULL AS read FROM notifications WHERE kind = 'meeting_action_assigned' AND object_id = $1", [tasks[0].id])).toEqual([{ read: true }]);
      expect(await confirmsOf(s, s.owner)).toEqual([]);

      // 不对要写原因。
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "reject" })).json()).toMatchObject({ code: "REASON_REQUIRED" });
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "reject", reason: "会上没定数" })).statusCode).toBe(200);
      expect(await s.t.sql("SELECT kind FROM jobs WHERE dedupe_key = $1", [`meeting.card_freeze:${s.meetingId}:decided`])).toHaveLength(1);
      await s.run();

      const view = await getCard(s.t, s.host, s.meetingId);
      expect(view.confirmed).toMatchObject({ confirmation: { revision: 1, confirmedBy: null }, payload: { schemaVersion: "meeting-card.v2",
        decisions: [{ id: "dec-1", text: "接口统一改成 v2", ownerPersonId: OWNER, confirmedBy: OWNER, proxy: false }],
        actionItems: [{ id: "act-1", confirmedBy: OWNER, proxy: false }], objectChanges: [{ id: "chg-1", decisionId: "dec-1" }] } });
      expect(view.confirmed!.payload.sections.length).toBeGreaterThan(0);
      expect(view.sync).toMatchObject({ writeToWorld: true, event: { status: "succeeded" }, objects: [{ changeId: "chg-1", status: "updated" }] });

      expect(world.events()).toHaveLength(1);
      const body = world.events()[0];
      expect(body.params.declaration.trigger).toBe("会议决策逐条确认");
      expect(body.reason).toBe("天枢会议决策逐条确认（测试丙）");
      const { payload } = parsed(body);
      expect(payload).not.toHaveProperty("summary");
      expect(payload).not.toHaveProperty("sections");
      expect(payload.decisions.map((decision: { id: string }) => decision.id)).toEqual(["dec-1"]);
      expect(payload.decisions[0].sourceRefs).toEqual([{ sourceId: "src-1", locator: "turn-002..turn-003" }]);
      // 只提交已确认决策的那一处修改。
      expect(world.revisions().map((revision) => revision.idempotency_key)).toEqual([`tianshu-meeting:${s.meetingId}:v1:change:chg-1`]);

      // 冻结后决策不能再点。
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" })).json()).toMatchObject({ code: "ALREADY_REVIEWED" });
    } finally {
      await s.t.close();
    }
  });

  it("主持人代确认（记为代确认），别人不能替；处理过的不能再点；冻结后没确认的决策不能再点", async () => {
    ontology();
    const s = await setup(TWO_DECISIONS);
    try {
      expect((await review(s, s.owner, { kind: "decision", id: "dec-2", verdict: "confirm" })).statusCode).toBe(404);
      const proxied = await review(s, s.host, { kind: "decision", id: "dec-1", verdict: "confirm" });
      expect(proxied.statusCode).toBe(200);
      expect((proxied.json().view as TMeetingCardView).decisions![0].review).toMatchObject({ status: "confirmed", by: HOST, proxy: true });
      expect(await confirmsOf(s, s.owner)).toEqual(["action:act-1"]);
      const again = await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "ALREADY_REVIEWED", view: { decisions: [{ review: { by: HOST } }, { review: { status: "pending" } }] } });

      await s.t.app.meetingFollowThrough.cardConfirm.freeze(s.meetingId);
      expect((await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" })).json()).toMatchObject({ code: "CARD_FROZEN" });
      expect((await getCard(s.t, s.host, s.meetingId)).confirmed!.payload.decisions).toEqual([expect.objectContaining({ id: "dec-1", confirmedBy: HOST, proxy: true })]);
      // 行动项冻结后还能接下。
      expect((await review(s, s.owner, { kind: "action", id: "act-1", verdict: "reject", reason: "不归我" })).statusCode).toBe(200);
      expect(await s.t.sql("SELECT 1 FROM tasks WHERE origin_meeting_id = $1", [s.meetingId])).toEqual([]);
    } finally {
      await s.t.close();
    }
  });

  it("冻结前选了不写进本体：冻结后只留天枢；冻结后再改 409", async () => {
    const world = ontology();
    const s = await setup(TWO_DECISIONS);
    try {
      const put = (writeToWorld: boolean) => s.t.app.inject({ method: "PUT", url: `/api/meetings/${s.meetingId}/card/world`,
        headers: { cookie: s.host, origin: s.t.publicOrigin }, payload: { writeToWorld } });
      expect((await s.t.app.inject({ method: "PUT", url: `/api/meetings/${s.meetingId}/card/world`, headers: { cookie: s.owner, origin: s.t.publicOrigin },
        payload: { writeToWorld: false } })).statusCode).toBe(404);
      expect(((await put(false)).json() as TMeetingCardView).writeToWorld).toBe(false);
      await review(s, s.owner, { kind: "decision", id: "dec-1", verdict: "confirm" });
      await review(s, s.host, { kind: "decision", id: "dec-2", verdict: "confirm" });
      await s.run();
      expect((await getCard(s.t, s.host, s.meetingId)).sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      expect(world.events()).toEqual([]);
      expect((await put(true)).json()).toMatchObject({ code: "CARD_FROZEN" });
    } finally {
      await s.t.close();
    }
  });

  it("记录正文开关打开（MEETING_WORLD_RECORD_TEXT=1）：没有决策的会生成后直接冻结写入，事件带正文", async () => {
    const world = ontology();
    const s = await setup(cardAgent([], []), { meetingRecordText: true });
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
    const s = await setup(cardAgent([], []));
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
