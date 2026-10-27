import { afterEach, describe, expect, it, vi } from "vitest";
import type { TMeetingCardView } from "@warmap/contracts";
import { confirm, edit, getCard, OWNER, putDraft, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 行动项（拍板 4）：天枢本地，随整卡确认；确认后没推过的推成执行事项、taskId 回填到草稿和这次的确认快照；不重复推、推完再改不回改；不进本体。

/** 假本体：挂点 PO（版本 5），记事件照收。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  const recorded: { eventId: string; body: any }[] = [];
  const calls = stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/actions/prepare") return { expected_versions: [] };
    if (path === "/v1/actions") {
      if (call.body.action_type !== "world_record_event") return { receipt_id: `r-${call.body.idempotency_key}`, status: "committed", result: {} };
      const event = recorded.find((item) => item.body.idempotency_key === call.body.idempotency_key)
        ?? recorded[recorded.push({ eventId: `ev-${recorded.length + 1}`, body: call.body }) - 1];
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    const events = path.match(/^\/v1\/world\/objects\/([^/]+)\/events$/);
    if (events) return { events: recorded.map((item) => ({ event_id: item.eventId, content: { refs: [], components: [], ...item.body.params.content } })) };
    if (path === `/v1/world/objects/${po.object_id}`) return projection(po);
    return { items: [], next_cursor: null };
  });
  const writes = () => calls.filter((call) => call.url.pathname === "/v1/actions").map((call) => call.body);
  const events = () => writes().filter((body) => body.action_type === "world_record_event");
  return { writes, events };
}

type Task = { id: string; title: string; owner_id: string; due_date: string | null; origin_item_id: string };
const tasksOf = async (t: Awaited<ReturnType<typeof setup>>["t"], meetingId: string) =>
  await t.sql("SELECT id::text, title, owner_id, due_date::text, origin_item_id FROM tasks WHERE origin_meeting_id = $1 ORDER BY created_at", [meetingId]) as Task[];
const stored = async (t: Awaited<ReturnType<typeof setup>>["t"], meetingId: string) => ({
  draft: (await t.sql("SELECT action_items FROM meeting_cards WHERE meeting_id = $1", [meetingId]))[0].action_items as TMeetingCardView["actionItems"],
  snapshots: (await t.sql("SELECT action_items FROM meeting_card_confirmations WHERE meeting_id = $1 ORDER BY revision", [meetingId]))
    .map((row) => row.action_items as TMeetingCardView["actionItems"]),
});

afterEach(() => vi.unstubAllGlobals());

describe("行动项推成执行事项", () => {
  it("确认后推成执行事项", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      const tasks = await tasksOf(t, meetingId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: "渠道看板接到 v2", owner_id: OWNER, due_date: "2026-06-30", origin_item_id: "act-1" });
      const { draft, snapshots } = await stored(t, meetingId);
      expect(draft[0].taskId).toBe(tasks[0].id);
      expect(snapshots[0][0].taskId).toBe(tasks[0].id);
      const view: TMeetingCardView = res.json();
      expect(view.actionItems[0].taskId).toBe(tasks[0].id);
      expect(view.confirmed!.actionItems[0].taskId).toBe(tasks[0].id);
      // 负责人收到派活提醒（沿用会后推送）。
      expect((await t.sql("SELECT person_id FROM notifications WHERE kind = 'meeting_action_assigned' AND object_id = $1", [tasks[0].id]))).toEqual([{ person_id: OWNER }]);
    } finally {
      await t.close();
    }
  });

  it("推出的执行事项没有逐字引用：负责人首页照常打开", async () => {
    ontology();
    const { t, host, owner, meetingId } = await setup();
    try {
      expect((await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true })).statusCode).toBe(200);
      const home = await t.app.inject({ method: "GET", url: "/api/me/home", headers: { cookie: owner } });
      expect(home.statusCode).toBe(200);
      expect((await t.sql("SELECT source_quote FROM tasks WHERE origin_meeting_id = $1", [meetingId]))[0].source_quote).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("修改后再确认不重复推；推完再改不回改执行事项", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      const view = await getCard(t, host, meetingId);
      const draft = structuredClone(view.draft!);
      draft.summary = "改过的摘要。";
      const saved = await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft,
        actionItems: [{ ...view.actionItems[0], text: "渠道看板接到 v3", dueDate: "2026-07-15" }] });
      expect(saved.statusCode).toBe(200);
      const res = await confirm(t, host, meetingId, { draftVersion: saved.json().draftVersion, writeToWorld: true, kind: "followup" });
      expect(res.statusCode).toBe(200);
      const tasks = await tasksOf(t, meetingId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: "渠道看板接到 v2", due_date: "2026-06-30" });
      const { draft: items, snapshots } = await stored(t, meetingId);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1][0]).toMatchObject({ text: "渠道看板接到 v3", taskId: tasks[0].id });
      expect(items[0].taskId).toBe(tasks[0].id);
    } finally {
      await t.close();
    }
  });

  it("确认后只改了行动项：不出新版本、不写本体、不用选原因，新的一条照推；再点一次不动", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      const view = await getCard(t, host, meetingId);
      const added = { id: "act-new", text: "约客户演示", ownerPersonId: OWNER, dueDate: null, basisSectionIds: [], taskId: null };
      const saved = await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft: view.draft, actionItems: [...view.actionItems, added] });
      expect(saved.statusCode).toBe(200);
      const draftVersion = (saved.json() as TMeetingCardView).draftVersion;
      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      await run();
      const tasks = await tasksOf(t, meetingId);
      expect(tasks.map((task) => task.origin_item_id)).toEqual(["act-1", "act-new"]);
      const { draft, snapshots } = await stored(t, meetingId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].map((item) => item.taskId)).toEqual([tasks[0].id, tasks[1].id]);
      expect(draft[1].taskId).toBe(tasks[1].id);
      expect(world.events()).toHaveLength(1);
      const after: TMeetingCardView = res.json();
      expect(after.confirmed).toMatchObject({ confirmation: { revision: 1 }, actionItems: [{ id: "act-1" }, { id: "act-new", taskId: tasks[1].id }] });

      const again = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(again.statusCode).toBe(200);
      await run();
      expect(await tasksOf(t, meetingId)).toHaveLength(2);
      expect((await stored(t, meetingId)).snapshots).toHaveLength(1);
      expect(world.events()).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("会议卡视图带草稿和确认版的差别：没改 none、只改行动项 items、挂点变了 content（连同行动项也是 content，确认要选原因）", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      expect((await getCard(t, host, meetingId)).draftChange).toBe("none");
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      const view = await getCard(t, host, meetingId);
      expect(view.draftChange).toBe("none");
      const saved = await putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft: view.draft, actionItems: [{ ...view.actionItems[0], text: "渠道看板接到 v3" }] });
      expect((saved.json() as TMeetingCardView).draftChange).toBe("items");
      // 挂点改了以后（同 anchorsChanged）：草稿的挂点对象跟着改、草稿版本加一。
      await t.pool.query("UPDATE meeting_cards SET draft = jsonb_set(draft, '{relatedObjectRefs}', '[]'::jsonb), draft_version = draft_version + 1 WHERE meeting_id = $1", [meetingId]);
      const both = await getCard(t, host, meetingId);
      expect(both.draftChange).toBe("content");
      const res = await confirm(t, host, meetingId, { draftVersion: both.draftVersion, writeToWorld: false });
      expect(res.json()).toMatchObject({ code: "KIND_REQUIRED" });
      await t.pool.query("UPDATE meeting_cards SET action_items = $2::jsonb WHERE meeting_id = $1", [meetingId, JSON.stringify(view.actionItems)]);
      expect((await getCard(t, host, meetingId)).draftChange).toBe("content");
    } finally {
      await t.close();
    }
  });

  it("改了又改回（none）：确认不出新版本、不用选原因；先不写入、这次选写入的改成写入", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: false });
      const summary = (await getCard(t, host, meetingId)).draft!.summary;
      await edit(t, host, meetingId, (draft) => { draft.summary = "临时改一下"; });
      const back = await edit(t, host, meetingId, (draft) => { draft.summary = summary; });
      expect(back.draftChange).toBe("none");
      const res = await confirm(t, host, meetingId, { draftVersion: back.draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      expect((res.json() as TMeetingCardView).sync).toMatchObject({ revision: 1, writeToWorld: true, event: { status: "pending" } });
      await run();
      expect(world.events()).toHaveLength(1);
      expect((await stored(t, meetingId)).snapshots).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("存草稿和确认回填撞在一起：taskId 按写入时的行，不被读到的旧值盖掉", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      await ready(t, host, meetingId);
      const view = await getCard(t, host, meetingId);
      // 另一个事务先回填 taskId 且不提交；存草稿读到的是旧的（null），写的时候等它。
      const other = await t.pool.connect();
      try {
        await other.query("BEGIN");
        await other.query(`UPDATE meeting_cards SET action_items = jsonb_set(action_items, '{0,taskId}', '"task-race"') WHERE meeting_id = $1`, [meetingId]);
        const put = putDraft(t, host, meetingId, { draftVersion: view.draftVersion, draft: view.draft, actionItems: view.actionItems });
        await vi.waitFor(async () => expect((await t.sql("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted"))[0].n).toBeGreaterThan(0), { timeout: 5000 });
        await other.query("COMMIT");
        expect((await put).statusCode).toBe(200);
      } finally {
        other.release();
      }
      expect((await stored(t, meetingId)).draft[0].taskId).toBe("task-race");
    } finally {
      await t.close();
    }
  });

  it("不写本体也照推", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const res = await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: false });
      expect(res.statusCode).toBe(200);
      await run();
      expect(await tasksOf(t, meetingId)).toHaveLength(1);
      expect(world.writes()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("行动项不进本体", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const res = await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect(world.events()).toHaveLength(1);
      const text = world.events()[0].params.content.text as string;
      expect(text).not.toContain("渠道看板接到 v2");
      expect(text).not.toContain("actionItems");
      expect(JSON.parse(text).payload).not.toHaveProperty("actionItems");
      expect((res.json() as TMeetingCardView).confirmed!.payload).not.toHaveProperty("actionItems");
    } finally {
      await t.close();
    }
  });
});

describe("会议卡上指定说话人", () => {
  const speakers = (t: Awaited<ReturnType<typeof setup>>["t"], cookie: string, meetingId: string, payload: unknown) =>
    t.app.inject({ method: "POST", url: `/api/meetings/${meetingId}/card/speakers`, headers: { cookie, origin: t.publicOrigin }, payload });
  /** 把逐字稿第 3 句改成没对上人的「Speaker 1」（像飞书认不出的声音），卡里写上原名；OWNER 先不在参会人里。 */
  async function unmapped(t: Awaited<ReturnType<typeof setup>>["t"], meetingId: string) {
    await t.pool.query(`UPDATE meetings SET transcript = jsonb_set(jsonb_set(transcript, '{turns,2,speakerId}', '"speaker:1"'), '{unmappedSpeakers}',
      '[{"id":"speaker:1","name":"Speaker 1"},{"id":"speaker:2","name":"Nexus"}]'),
      participants = (SELECT jsonb_agg(p) FROM jsonb_array_elements(participants) p WHERE p->>'personId' <> $2) WHERE id = $1`, [meetingId, OWNER]);
    await t.pool.query(`UPDATE meeting_cards SET draft = jsonb_set(draft, '{summary}', '"Speaker 1 接 v2，Speaker 10 另说。"'),
      action_items = jsonb_set(action_items, '{0,text}', '"Speaker 1 渠道看板接到 v2"') WHERE meeting_id = $1`, [meetingId]);
  }

  it("指定到人：发言改记到他、补进参会人、卡里原名换成他的名字（Speaker 10 不动）；另一位还要指定", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      await unmapped(t, meetingId);
      const before = await getCard(t, host, meetingId);
      expect(before.unmappedSpeakers).toEqual([{ id: "speaker:1", name: "Speaker 1" }, { id: "speaker:2", name: "Nexus" }]);
      const res = await speakers(t, host, meetingId, { draftVersion: before.draftVersion, speakerId: "speaker:1", personId: OWNER });
      expect(res.statusCode).toBe(200);
      const view: TMeetingCardView = res.json();
      expect(view.draftVersion).toBe(before.draftVersion + 1);
      expect(view.unmappedSpeakers).toEqual([{ id: "speaker:2", name: "Nexus" }]);
      expect(view.draft!.summary).toBe("测试丙 接 v2，Speaker 10 另说。");
      expect(view.actionItems[0].text).toBe("测试丙 渠道看板接到 v2");
      expect(view.draft!.participants.map((person) => person.name)).toContain("测试丙");
      const [meeting] = await t.sql("SELECT transcript, participants FROM meetings WHERE id = $1", [meetingId]);
      expect(meeting.transcript.turns[2].speakerId).toBe(OWNER);
      expect(meeting.transcript.unmappedSpeakers).toEqual([{ id: "speaker:2", name: "Nexus" }]);
      expect((meeting.participants as { personId: string }[]).map((person) => person.personId)).toContain(OWNER);
    } finally {
      await t.close();
    }
  });

  it("「不是天枢里的人」只记下不再提示、卡不动；草稿版本过期 409；别人 404", async () => {
    ontology();
    const { t, host, owner, meetingId } = await setup();
    try {
      await unmapped(t, meetingId);
      const before = await getCard(t, host, meetingId);
      expect((await speakers(t, host, meetingId, { draftVersion: before.draftVersion - 1, speakerId: "speaker:2", personId: null })).statusCode).toBe(409);
      expect((await speakers(t, owner, meetingId, { draftVersion: before.draftVersion, speakerId: "speaker:2", personId: null })).statusCode).toBe(404);
      const res = await speakers(t, host, meetingId, { draftVersion: before.draftVersion, speakerId: "speaker:2", personId: null });
      expect(res.statusCode).toBe(200);
      const view: TMeetingCardView = res.json();
      expect(view.draftVersion).toBe(before.draftVersion);
      expect(view.unmappedSpeakers).toEqual([{ id: "speaker:1", name: "Speaker 1" }]);
      expect((await speakers(t, host, meetingId, { draftVersion: view.draftVersion, speakerId: "speaker:2", personId: OWNER })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });
});
