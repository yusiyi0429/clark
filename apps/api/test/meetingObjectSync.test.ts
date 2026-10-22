import { afterEach, describe, expect, it, vi } from "vitest";
import type { TMeetingObjectResult } from "@warmap/contracts";
import { cardAgent, confirm, edit, getCard, OCCURRED, ready, setup, worldOf } from "./meetingCardFixture.js";
import { createMeetingObjectSync } from "../src/meetingObjectSync.js";
import type { Query } from "../src/meetingStore.js";
import { WorldClient } from "../src/worldClient.js";
import { instance, projection, stubWorld, worldEnv } from "./worldFixture.js";

// 对象修改（FR-5.3、5.4）：会议事件写成后，确认版里的每条修改按顺序各提交一次修订、读回核对，各有回执；本期不做失败项重试（拍板 5）。

const TWO_CHANGES = [
  { targetRef: "obj-po-1#target/acc-1", after: { text: "十月底前 4 家客户上线" }, basisSections: [1] },
  { targetRef: "obj-po-1#target/acc-2", after: { text: "接口统一切到 v2" }, basisSections: [1] },
];
const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

/**
 * 假本体：挂点 PO（版本 5，target 块两个文字组件）。记事件按幂等键去重、取事件能读回；
 * 修订：expected_version 不是对象当前版本回 409 VERSION_CONFLICT；提交时组件按 id 合并、版本加一（同键重放不再改）。
 * 回执带 object_versions。refuse(body, path) 返回 Response 时修订照它回（模拟无权限、状态不允许、别人刚好改了）；
 * afterCommit(key) 在修订提交、回执返回前跑（模拟提交和读回之间别人的修改）；network() 为 true 时修订请求抛网络错误。
 */
function ontology({ refuse, afterCommit, network = () => false, blockClass = "activity", objectType = "PeriodGoal" }:
  { refuse?: (body: any, path: string) => Response | undefined; afterCommit?: (key: string) => void | Promise<void>; network?: () => boolean; blockClass?: string; objectType?: string } = {}) {
  const po = {
    object_id: "obj-po-1", object_type: objectType, title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", class: blockClass, components: [
      { id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" },
      { id: "acc-2", type: "acceptance_criterion", text: "接口用 v1" },
    ] }],
  };
  const edit = (id: string, text: string) => {
    po.blocks[0].components.find((item) => item.id === id)!.text = text;
    po.object_version += 1;
    po.version += 1;
    po.revision_id = `obj-po-1-r${po.object_version}`;
  };
  const events: { eventId: string; body: any }[] = [];
  const revised = new Map<string, unknown>();
  const calls = stubWorld(async (call) => {
    const path = call.url.pathname;
    if (path === "/v1/actions/prepare" || path === "/v1/actions") {
      const body = call.body;
      if (body.action_type === "world_revise_object") {
        if (network()) throw new TypeError("fetch failed");
        if (path === "/v1/actions" && revised.has(body.idempotency_key)) return revised.get(body.idempotency_key);
        const refused = refuse?.(body, path);
        if (refused) return refused;
        if (body.target.expected_version !== po.object_version) return error(409, "VERSION_CONFLICT");
        if (path === "/v1/actions/prepare") return { expected_versions: [] };
        for (const [, block] of Object.entries(body.params.payload.blocks as Record<string, { components: { id: string; text: string }[] }>)) {
          for (const component of block.components) edit(component.id, component.text);
        }
        const receipt = { receipt_id: `r-${body.idempotency_key}`, status: "committed", result: { version: po.version },
          object_versions: [{ object_id: po.object_id, object_version: po.object_version }] };
        revised.set(body.idempotency_key, receipt);
        await afterCommit?.(body.idempotency_key);
        return receipt;
      }
      if (path === "/v1/actions/prepare") return { expected_versions: [] };
      const event = events.find((item) => item.body.idempotency_key === body.idempotency_key)
        ?? events[events.push({ eventId: `ev-${events.length + 1}`, body }) - 1];
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    if (path === `/v1/world/objects/${po.object_id}/events`) return { events: events.map((item) => ({ event_id: item.eventId, content: item.body.params.content })) };
    if (path === `/v1/world/objects/${po.object_id}`) return projection(po);
    return { items: [], next_cursor: null };
  });
  const revisions = () => calls.filter((call) => call.url.pathname === "/v1/actions/prepare" && call.body.action_type === "world_revise_object").map((call) => call.body);
  return { po, edit, calls, revisions };
}

const objectsOf = async (t: Awaited<ReturnType<typeof setup>>["t"], meetingId: string, revision: number) =>
  (await t.sql("SELECT objects FROM meeting_card_syncs WHERE meeting_id = $1 AND revision = $2", [meetingId, revision]))[0].objects as TMeetingObjectResult[];

afterEach(() => vi.unstubAllGlobals());

describe("对象修改逐个提交", () => {
  it("确认后逐个对象修改并读回", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      const draftVersion = await ready(t, host, meetingId);
      const view = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).json();
      expect(view.sync.objects).toEqual([
        { changeId: "chg-1", title: "十月交付 · 验收标准", status: "pending", actualVersion: null, error: null },
        { changeId: "chg-2", title: "十月交付 · 验收标准", status: "pending", actualVersion: null, error: null },
      ]);
      await run();

      const [first, second] = world.revisions();
      expect(world.revisions()).toHaveLength(2);
      expect(first).toMatchObject({
        action_type: "world_revise_object", contract_version: "tkos.world/0.3", idempotency_key: `tianshu-meeting:${meetingId}:v1:change:chg-1`,
        target: { object_id: "obj-po-1", revision_id: "obj-po-1-r5", expected_version: 5 },
        params: {
          payload: { blocks: { target: { components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 4 家客户上线" }] } } },
          declaration: { scene: "obj-po-1@5", trigger: "会议记录整卡确认", human_acceptance: { required: false } },
        },
      });
      // 冻结的是 5；第一条是天枢自己改的，第二条接着它改出的版本提交。
      expect(second).toMatchObject({ idempotency_key: `tianshu-meeting:${meetingId}:v1:change:chg-2`, target: { revision_id: "obj-po-1-r6", expected_version: 6 } });
      const sync = (await getCard(t, host, meetingId)).sync!;
      expect(sync.event.status).toBe("succeeded");
      expect(sync.objects).toEqual([
        { changeId: "chg-1", title: "十月交付 · 验收标准", status: "updated", actualVersion: 6, error: null },
        { changeId: "chg-2", title: "十月交付 · 验收标准", status: "updated", actualVersion: 7, error: null },
      ]);
      // 先逐条写修订，最后写会议事件；事件的 refs 列写成的修订，钉到改出的版本（斯一 10/21）。
      const prepares = world.calls.filter((call) => call.url.pathname === "/v1/actions/prepare").map((call) => call.body);
      expect(prepares.map((body) => body.action_type)).toEqual(["world_revise_object", "world_revise_object", "world_record_event"]);
      expect(prepares[2]).toMatchObject({ idempotency_key: `tianshu-meeting:${meetingId}:v1:event`,
        params: { content: { refs: ["obj-po-1@6#target/acc-1", "obj-po-1@7#target/acc-2"] } } });
      // 再跑一遍不再提交。
      await run();
      expect(world.revisions()).toHaveLength(2);
      // 自己改成的不算「目标已变」，记录也不变成修改待确认。
      const card = await getCard(t, host, meetingId);
      expect(card.draft!.objectChanges).toMatchObject([
        { id: "chg-1", stale: false, expectedVersion: 7, before: { text: "十月底前 4 家客户上线" }, after: { text: "十月底前 4 家客户上线" } },
        { id: "chg-2", stale: false, expectedVersion: 7, before: { text: "接口统一切到 v2" }, after: { text: "接口统一切到 v2" } },
      ]);
      expect(card.draftVersion).toBe(draftVersion);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 1 });
    } finally {
      await t.close();
    }
  });

  it("版本冲突不覆盖", async () => {
    // 提交时别人刚好改了这个对象。
    const world = ontology({ refuse: (body, path) => {
      if (path !== "/v1/actions/prepare" || world.po.object_version !== 5) return undefined;
      world.edit("acc-1", "十月底前 5 家客户上线");
      return error(409, "VERSION_CONFLICT");
    } });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect(world.revisions()).toHaveLength(1);
      expect(world.po.blocks[0].components[0].text).toBe("十月底前 5 家客户上线");
      expect(await objectsOf(t, meetingId, 1)).toEqual([{ changeId: "chg-1", title: "十月交付 · 验收标准", status: "conflict", actualVersion: null, error: "目标已变" }]);
      // 草稿里这条按对象当前值刷新，要重看（不经读卡，写入时就刷新）。
      const card = (await t.sql("SELECT draft, draft_version FROM meeting_cards WHERE meeting_id = $1", [meetingId]))[0];
      expect(card.draft_version).toBe(draftVersion + 1);
      expect(card.draft.objectChanges[0]).toMatchObject({ id: "chg-1", stale: true, expectedVersion: 6, before: { text: "十月底前 5 家客户上线" }, after: { text: "十月底前 4 家客户上线" } });
    } finally {
      await t.close();
    }
  });

  it("不允许修改时保留提议", async () => {
    const world = ontology({ refuse: (body) => body.idempotency_key.endsWith(":chg-1") ? error(403, "FORBIDDEN") : error(409, "INVALID_STATE") });
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      const view = await getCard(t, host, meetingId);
      expect(view.sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1" });
      expect(view.sync!.objects).toMatchObject([
        { changeId: "chg-1", status: "not_allowed", error: "已确认、待同步 · 本体拒绝", actualVersion: null },
        { changeId: "chg-2", status: "not_allowed", error: "对象状态不允许", actualVersion: null },
      ]);
      expect(view.confirmed!.payload.objectChanges.map((change) => change.id)).toEqual(["chg-1", "chg-2"]);
      expect(world.revisions()).toHaveLength(2);
      // 一条都没写成：事件不带 refs，不说修订已生效。
      const event = world.calls.find((call) => call.url.pathname === "/v1/actions/prepare" && call.body.action_type === "world_record_event")!.body;
      expect(event.params.content).not.toHaveProperty("refs");
    } finally {
      await t.close();
    }
  });

  it("本体回别的错误：只记短标签「写入失败」，不记本体原话", async () => {
    ontology({ refuse: () => Response.json({ error: { code: "SCHEMA_INVALID", message: "params.payload.blocks.target: unknown component" } }, { status: 422 }) });
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ status: "failed", error: "写入失败" }]);
    } finally {
      await t.close();
    }
  });

  it("不在本期可写范围（FR-5.4）：不提交、不进台账，记「已确认、待同步 · 原因」", async () => {
    for (const [options, reason] of [[{ blockClass: "dri_maintained", objectType: "Mission" }, "Mission 计划"], [{ objectType: "Company" }, "无门对象"],
      [{ objectType: "Task" }, "无门对象"], [{ blockClass: "plan" }, "不在可写范围"]] as const) {
      const world = ontology(options);
      const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES.slice(0, 1)));
      try {
        await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
        await run();
        expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ changeId: "chg-1", status: "not_allowed", error: `已确认、待同步 · ${reason}` }]);
        expect(world.revisions()).toHaveLength(0);
      } finally {
        await t.close();
      }
    }
  }, 30_000);

  it("目标是正式块：不提交，直接记「已确认、待同步」，台账不留记录；事件照写、不带 refs", async () => {
    const world = ontology({ blockClass: "formal" });
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([
        { changeId: "chg-1", status: "not_allowed", error: "已确认、待同步 · 正式块", actualVersion: null },
        { changeId: "chg-2", status: "not_allowed", error: "已确认、待同步 · 正式块", actualVersion: null },
      ]);
      expect(world.revisions()).toHaveLength(0);
      expect(await t.sql("SELECT idempotency_key FROM world_sync_ledger WHERE idempotency_key LIKE $1", [`%:change:%`])).toEqual([]);
      const event = world.calls.find((call) => call.url.pathname === "/v1/actions/prepare" && call.body.action_type === "world_record_event")!.body;
      expect(event.params.content).not.toHaveProperty("refs");
      expect((await getCard(t, host, meetingId)).sync!.event.status).toBe("succeeded");
    } finally {
      await t.close();
    }
  });

  it("一次确认里一条修订写失败：事件 refs 里没有它", async () => {
    const world = ontology({ refuse: (body) => body.idempotency_key?.endsWith(":chg-2")
      ? Response.json({ error: { code: "SCHEMA_INVALID", message: "x" } }, { status: 422 }) : undefined });
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ changeId: "chg-1", status: "updated", actualVersion: 6 }, { changeId: "chg-2", status: "failed", error: "写入失败" }]);
      const event = world.calls.find((call) => call.url.pathname === "/v1/actions/prepare" && call.body.action_type === "world_record_event")!.body;
      expect(event.params.content.refs).toEqual(["obj-po-1@6#target/acc-1"]);
    } finally {
      await t.close();
    }
  });

  it("提交和读回之间别人改了同一对象：下一条不接着改", async () => {
    const world = ontology({ afterCommit: (key) => { if (key.endsWith(":chg-1")) world.edit("acc-2", "别人改的"); } });
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      // 第一条按回执记 6（不是读回时的 7）；第二条接着 6 提交，过不了版本核对，不发请求。
      expect(world.revisions()).toHaveLength(1);
      expect(world.po.blocks[0].components[1].text).toBe("别人改的");
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([
        { changeId: "chg-1", status: "updated", actualVersion: 6 },
        { changeId: "chg-2", status: "conflict", error: "目标已变" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("提交后、草稿跟上前有人读卡：自己改成的仍不算目标已变", async () => {
    let window: (() => Promise<unknown>) | null = null;
    ontology({ afterCommit: async () => { const step = window; window = null; await step?.(); } });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      // 回执返回前读卡：按版本把这条刷到 6、标 stale、草稿版本加一。
      window = async () => expect((await getCard(t, host, meetingId)).draft!.objectChanges[0]).toMatchObject({ stale: true, expectedVersion: 6 });
      await run();
      expect(window).toBeNull();
      const card = await getCard(t, host, meetingId);
      expect(card.draftVersion).toBe(draftVersion + 1);
      expect(card.draft!.objectChanges[0]).toMatchObject({ stale: false, expectedVersion: 6, before: { text: "十月底前 4 家客户上线" }, after: { text: "十月底前 4 家客户上线" } });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed" });
    } finally {
      await t.close();
    }
  });

  it("草稿跟上时刚好有人存草稿：重读再来", async () => {
    ontology();
    const { t, host, meetingId } = await setup();
    try {
      const view = (await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true })).json();
      // 第一次写草稿前，别人存了一版（草稿版本加一），条件更新落空。
      let saves = 0;
      const q: Query = async (sql, params) => {
        if (sql.startsWith("UPDATE meeting_cards") && saves++ === 0) await t.pool.query("UPDATE meeting_cards SET draft_version = draft_version + 1 WHERE meeting_id = $1", [meetingId]);
        return t.pool.query(sql, params);
      };
      const sync = createMeetingObjectSync({ q, world: new WorldClient(t.pool.query.bind(t.pool), worldEnv, instance), refreshDraft: t.app.meetingFollowThrough.cards.refreshDraft });
      await sync.run(meetingId, 1, view.confirmed.payload.objectChanges, view.sync.objects, false);
      expect(saves).toBe(2);
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ status: "updated", actualVersion: 6 }]);
      const card = (await t.sql("SELECT draft FROM meeting_cards WHERE meeting_id = $1", [meetingId]))[0];
      expect(card.draft.objectChanges[0]).toMatchObject({ stale: false, expectedVersion: 6, before: { text: "十月底前 4 家客户上线" } });
    } finally {
      await t.close();
    }
  });

  it("改后内容为空不提交；契约版本不对不允许", async () => {
    const world = ontology({ refuse: () => error(409, "PROTOCOL_BINDING_CONFLICT") });
    const { t, host, meetingId, run } = await setup(cardAgent([
      { targetRef: "obj-po-1#target/acc-1", after: { text: " " }, basisSections: [1] },
      { targetRef: "obj-po-1#target/acc-2", after: { text: "接口统一切到 v2" }, basisSections: [1] },
    ]));
    try {
      // 存草稿不收空内容，只有模型生成的能带进来；实际开始直接填进库。
      await t.pool.query(`UPDATE meeting_cards SET draft = jsonb_set(draft, '{occurredAt}', $2::jsonb) WHERE meeting_id = $1`, [meetingId, JSON.stringify(OCCURRED)]);
      expect((await confirm(t, host, meetingId, { draftVersion: 1, writeToWorld: true })).statusCode).toBe(200);
      await run();
      expect(world.revisions().length).toBeGreaterThan(0);
      expect(world.revisions().every((body) => body.idempotency_key.endsWith(":chg-2"))).toBe(true);
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([
        { changeId: "chg-1", status: "blocked", error: "改后内容为空" },
        { changeId: "chg-2", status: "not_allowed", error: "契约版本不对" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("目标未定的不提交", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup(cardAgent([{ targetRef: "obj-po-1#target/nope", after: { text: "没有这个组件" }, basisSections: [1] }]));
    try {
      const draftVersion = await ready(t, host, meetingId);
      expect((await getCard(t, host, meetingId)).draft!.objectChanges[0].targetRef).toBeNull();
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect(world.revisions()).toEqual([]);
      expect((await getCard(t, host, meetingId)).sync).toMatchObject({ event: { status: "succeeded" },
        objects: [{ changeId: "chg-1", title: "", status: "blocked", actualVersion: null, error: "目标未定" }] });
    } finally {
      await t.close();
    }
  });

  it("不写入的一条也不提交；改成写入再提交", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      const view = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).json();
      expect(view.sync.objects).toMatchObject([{ changeId: "chg-1", status: "blocked", error: "不写入" }]);
      await run();
      expect(world.revisions()).toEqual([]);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect((await getCard(t, host, meetingId)).sync!.objects).toMatchObject([{ changeId: "chg-1", status: "updated", actualVersion: 6, error: null }]);
    } finally {
      await t.close();
    }
  });

  it("新版确认后旧版待提交的作废", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup(cardAgent(TWO_CHANGES));
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      const next = await edit(t, host, meetingId, (draft) => { draft.summary = "第二版摘要"; });
      await confirm(t, host, meetingId, { draftVersion: next.draftVersion, writeToWorld: true, kind: "correction" });
      expect((await objectsOf(t, meetingId, 1)).map((item) => item.status)).toEqual(["superseded", "superseded"]);
      await run();
      expect(world.revisions().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v2:change:chg-1`, `tianshu-meeting:${meetingId}:v2:change:chg-2`]);
      expect((await objectsOf(t, meetingId, 1)).map((item) => item.status)).toEqual(["superseded", "superseded"]);
      expect((await objectsOf(t, meetingId, 2)).map((item) => item.status)).toEqual(["updated", "updated"]);
      // 已经改成的不因新版确认作废。
      const v3 = await edit(t, host, meetingId, (draft) => { draft.summary = "第三版摘要"; });
      await confirm(t, host, meetingId, { draftVersion: v3.draftVersion, writeToWorld: true, kind: "correction" });
      expect((await objectsOf(t, meetingId, 2)).map((item) => item.status)).toEqual(["updated", "updated"]);
    } finally {
      await t.close();
    }
  });

  it("上一版已改成的修改：新版沿用结果、不再提交；之后别人改了这个对象，卡片不算目标已变、也不改回去", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect(world.revisions()).toHaveLength(1);
      const v2 = await edit(t, host, meetingId, (draft) => { draft.summary = "第二版摘要"; });
      const confirmed = (await confirm(t, host, meetingId, { draftVersion: v2.draftVersion, writeToWorld: true, kind: "correction" })).json();
      expect(confirmed.sync.objects).toMatchObject([{ changeId: "chg-1", status: "updated", actualVersion: 6, error: null }]);
      await run();
      expect(world.revisions()).toHaveLength(1);
      expect(await objectsOf(t, meetingId, 2)).toMatchObject([{ status: "updated", actualVersion: 6 }]);

      // 别人把对象改了：读卡、存草稿都不把这条标成目标已变，记录不变成修改待确认。
      world.edit("acc-1", "别人改的");
      const card = await getCard(t, host, meetingId);
      expect(card.draftChange).toBe("none");
      expect(card.draft!.objectChanges[0]).toMatchObject({ id: "chg-1", stale: false });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 2 });
      const v3 = await edit(t, host, meetingId, (draft) => { draft.summary = "第三版摘要"; });
      expect(v3.draft!.objectChanges[0]).toMatchObject({ stale: false });
      expect(v3.draftChange).toBe("content");
      await confirm(t, host, meetingId, { draftVersion: v3.draftVersion, writeToWorld: true, kind: "correction" });
      await run();
      expect(world.revisions()).toHaveLength(1);
      expect(world.po.blocks[0].components[0].text).toBe("别人改的");
    } finally {
      await t.close();
    }
  });

  it("上一版已改成、这次改了改后内容：照常提交", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      const v2 = await edit(t, host, meetingId, (draft) => { draft.objectChanges[0].after.text = "十月底前 6 家客户上线"; });
      await confirm(t, host, meetingId, { draftVersion: v2.draftVersion, writeToWorld: true, kind: "correction" });
      await run();
      expect(world.revisions().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1:change:chg-1`, `tianshu-meeting:${meetingId}:v2:change:chg-1`]);
      expect(world.revisions()[1]).toMatchObject({ target: { expected_version: 6 } });
      expect(world.po.blocks[0].components[0].text).toBe("十月底前 6 家客户上线");
      expect(await objectsOf(t, meetingId, 2)).toMatchObject([{ status: "updated", actualVersion: 7 }]);
    } finally {
      await t.close();
    }
  });

  it("网络错误留给任务重跑，最后一次仍失败记失败", async () => {
    let down = true;
    const world = ontology({ network: () => down });
    const { t, host, meetingId, run } = await setup();
    try {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ status: "pending" }]);
      expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync' AND status = 'pending'"))[0].n).toBe(1);
      // 任务最后一次重跑还是网络错误：记失败，不再留在待提交。
      await t.app.meetingFollowThrough.cardConfirm.syncWorld(meetingId, true);
      expect(await objectsOf(t, meetingId, 1)).toMatchObject([{ status: "failed", error: "连不上本体" }]);
      down = false;
      await t.app.meetingFollowThrough.cardConfirm.syncWorld(meetingId);
      expect(world.po.object_version).toBe(5);
    } finally {
      await t.close();
    }
  });
});
