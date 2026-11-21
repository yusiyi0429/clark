import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MeetingCardView, type TMeetingCardView } from "@warmap/contracts";
import { signActionId } from "../src/actionToken.js";
import { JOB_MAX_ATTEMPTS } from "../src/jobs.js";
import { payloadHash } from "../src/meetingCardHash.js";
import { cardAgent, CEO, confirm, edit, getCard, HOST, ready, retry, setup, worldOf } from "./meetingCardFixture.js";
import { projection, stubWorld } from "./worldFixture.js";

// 整卡确认（FR-5.1、5.3、5.5）：主持人或创建人带草稿版本确认 → 冻结一版 → 写一条整场会议事件，正文是 {payload, confirmation} 的 JSON；
// 修改分更正原记录（correction）和会后新决定（新 meeting 事件指回前次）。

type Written = { eventId: string; body: any };
/**
 * 假本体：挂点 PO（版本 5）；记事件按幂等键去重（同键重放回原回执）；取事件返回 subject_refs 挂到这个对象上的事件（带 content）。
 * network() 为 true 时记事件请求抛网络错误；beforeCommit 在每次记事件（prepare 之后、提交之前）先跑；readable() 为 false 时取事件为空；
 * tampered() 为 true 时读回的正文 payload 被改了一个字（confirmation 原样）；lost() 为 true 时事件记下了、回包丢了（抛网络错误）；
 * conflict() 为 true 时记事件回 409 VERSION_CONFLICT（什么也不记）。
 */
function ontology({ network = () => false, beforeCommit, readable = () => true, tampered = () => false, lost = () => false, conflict = () => false }:
  { network?: () => boolean; beforeCommit?: () => Promise<void>; readable?: () => boolean; tampered?: () => boolean; lost?: () => boolean; conflict?: () => boolean } = {}) {
  const tamper = (text: string) => {
    if (!tampered()) return text;
    const body = JSON.parse(text);
    body.payload.summary = `${body.payload.summary}。`;
    return JSON.stringify(body);
  };
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
      // 对象修改照收不改（读回对不上记失败），只看会议事件。
      if (call.body.action_type !== "world_record_event") return { receipt_id: `r-${call.body.idempotency_key}`, status: "committed", result: {} };
      await beforeCommit?.();
      if (network()) throw new TypeError("fetch failed");
      if (conflict()) return Response.json({ error: { code: "VERSION_CONFLICT", message: "版本已前进" } }, { status: 409 });
      const event = recorded.find((item) => item.body.idempotency_key === call.body.idempotency_key)
        ?? recorded[recorded.push({ eventId: `ev-${recorded.length + 1}`, body: call.body }) - 1];
      if (lost()) throw new TypeError("fetch failed");
      return { receipt_id: `r-${event.eventId}`, status: "committed", result: { event_id: event.eventId } };
    }
    const events = path.match(/^\/v1\/world\/objects\/([^/]+)\/events$/);
    if (events) {
      return { events: readable() ? recorded.filter((item) => item.body.params.subject_refs.some((ref: string) => ref.startsWith(`${decodeURIComponent(events[1])}@`)))
        .map((item) => ({ event_id: item.eventId, content: { refs: [], components: [], ...item.body.params.content, text: tamper(item.body.params.content.text) } })) : [] };
    }
    if (path === `/v1/world/objects/${po.object_id}`) return projection(po);
    return { items: [], next_cursor: null };
  });
  // 会议事件的提交（对象修改另见 meetingObjectSync.test.ts）。
  const writes = () => calls.filter((call) => call.url.pathname === "/v1/actions" && call.body.action_type === "world_record_event").map((call) => call.body);
  return { po, calls, writes, recorded };
}

const parsed = (body: any) => JSON.parse(body.params.content.text) as { payload: any; confirmation: any };

afterEach(() => vi.unstubAllGlobals());

describe("整卡确认与会议事件", () => {
  it("确认后写一条整场事件：正文是 payload 和 confirmation 的 JSON，subject_refs 是带版本的挂点，读回核对后才算写成", async () => {
    const world = ontology();
    const { t, ceo, host, owner, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      // 只有主持人或创建人能确认：参会人 404；不是建会的人的 CEO 也 404。
      await t.pool.query("UPDATE meetings SET created_by = $2 WHERE id = $1", [meetingId, HOST]);
      expect((await confirm(t, owner, meetingId, { draftVersion, writeToWorld: true })).statusCode).toBe(404);
      expect((await confirm(t, ceo, meetingId, { draftVersion, writeToWorld: true })).statusCode).toBe(404);
      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      const view: TMeetingCardView = res.json();
      expect(Value.Check(MeetingCardView, view)).toBe(true);
      expect(view.confirmed).toMatchObject({ kind: "first", confirmation: { revision: 1, confirmedBy: HOST }, payload: { revision: 1, relatedObjectRefs: ["obj-po-1@5"] } });
      expect(view.confirmed!.confirmation.payloadHash).toBe(payloadHash(view.confirmed!.payload));
      expect(view.confirmed!.payload.objectChanges[0]).not.toHaveProperty("stale");
      expect(view.sync).toMatchObject({ revision: 1, writeToWorld: true, event: { status: "pending", eventId: null },
        objects: [{ changeId: "chg-1", title: "十月交付 · 验收标准", status: "pending", actualVersion: null, error: null }] });
      // 第一次确认：会议算处理完。
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");
      // 行动项快照留在确认表，不进 payload。
      expect((await t.sql("SELECT action_items FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].action_items).toEqual(view.actionItems);
      expect(view.confirmed!.payload).not.toHaveProperty("actionItems");
      // 已确认、事件还在写：页头是「写入中」，不是待确认。
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "writing", version: 1, eventId: null });
      await run();

      expect(world.writes()).toHaveLength(1);
      const body = world.writes()[0];
      expect(body).toMatchObject({ action_type: "world_record_event", idempotency_key: `tianshu-meeting:${meetingId}:v1:event`,
        params: { category: "meeting", subject_refs: ["obj-po-1@5"], occurred_at: "2026-06-01T10:02:00+08:00",
          declaration: { scene: "obj-po-1@5", trigger: "会议记录整卡确认", human_acceptance: { required: false } } } });
      expect(body.params).not.toHaveProperty("supersedes_event_id");
      // 确认人的名字只写在 reason 里。
      expect(body.reason).toBe("天枢会议记录整卡确认（测试乙）");
      expect(Object.keys(body.params.content).sort()).toEqual(["artifacts", "text"]);
      expect(body.params.content.artifacts).toEqual([view.confirmed!.payload.sources[0].url]);
      const { payload, confirmation } = parsed(body);
      expect(payload).toEqual(view.confirmed!.payload);
      expect(payload.revision).toBe(1);
      expect(confirmation.payloadHash).toBe(payloadHash(payload));
      // 读回：写完按挂点对象取事件，带 since。
      const readBack = world.calls.find((call) => call.url.pathname === "/v1/world/objects/obj-po-1/events")!;
      expect(readBack.url.searchParams.get("since")).toBe("2026-06-01T10:02:00+08:00");

      const after = await getCard(t, host, meetingId);
      expect(after.sync).toMatchObject({ event: { status: "succeeded", eventId: "ev-1", error: null } });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 1, eventId: "ev-1" });
      // 参会人看不到记录状态。
      expect((await worldOf(t, owner, meetingId)).world).toMatchObject({ record: null, at: null });
      // CEO 能读确认版。
      expect((await getCard(t, ceo, meetingId)).confirmed).toEqual(after.confirmed);
    } finally {
      await t.close();
    }
  });

  it("从议题建的会记下建会的人：CEO 建、主持人是别人，CEO 也能确认", async () => {
    ontology();
    const { t, ceo, host, meetingId } = await setup();
    try {
      expect((await t.sql("SELECT created_by FROM meetings WHERE id = $1", [meetingId]))[0].created_by).toBe(CEO);
      const draftVersion = await ready(t, host, meetingId);
      expect((await getCard(t, ceo, meetingId)).canEdit).toBe(true);
      const res = await confirm(t, ceo, meetingId, { draftVersion, writeToWorld: true });
      expect(res.statusCode).toBe(200);
      expect((res.json() as TMeetingCardView).confirmed!.confirmation.confirmedBy).toBe(CEO);
    } finally {
      await t.close();
    }
  });

  it("会议卡确认后不能替换逐字稿：CEO 看不到这个动作，签好的也 409", async () => {
    ontology();
    const { t, ceo, host, meetingId } = await setup();
    try {
      const actions = async () => ((await t.app.inject({ method: "GET", url: `/api/cards/meetings/${meetingId}`, headers: { cookie: ceo } })).json()
        .cards[0].actions as { actionType: string }[]).map((action) => action.actionType);
      expect(await actions()).toContain("meeting.replace_transcript");
      expect((await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: false })).statusCode).toBe(200);
      expect(await actions()).not.toContain("meeting.replace_transcript");
      const version = (await t.sql("SELECT version FROM meetings WHERE id = $1", [meetingId]))[0].version as number;
      const replaced = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie: ceo, origin: t.publicOrigin }, payload: {
        actionId: signActionId(t.env.sessionSecret, { actionType: "meeting.replace_transcript", objectType: "meeting", objectId: meetingId, objectVersion: version }),
        input: { transcript: { schemaVersion: "warmap-transcript.v1", meetingId, turns: [{ id: "turn-001", speakerId: HOST, text: "换一份逐字稿。" }] }, confirmReplace: true },
      } });
      expect(replaced.statusCode).toBe(409);
      expect(replaced.json().code).toBe("OUTCOME_HAS_CONFIRMED_EFFECT");
      expect((await getCard(t, host, meetingId)).confirmed!.confirmation.revision).toBe(1);
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

  describe("任务最后一次仍连不上本体：台账记待核验，之后按同一幂等键重放核验", () => {
    type T = Awaited<ReturnType<typeof setup>>["t"];
    const keyOf = (meetingId: string) => `tianshu-meeting:${meetingId}:v1:event`;
    const ledgerStatus = async (t: T, meetingId: string) =>
      (await t.sql("SELECT status FROM world_sync_ledger WHERE idempotency_key = $1 ORDER BY id DESC LIMIT 1", [keyOf(meetingId)]))[0].status;
    const failedRows = async (t: T) => (await t.sql("SELECT count(*)::int AS n FROM world_sync_ledger WHERE status = 'failed'"))[0].n;
    const verifyJobs = (t: T) => t.sql("SELECT dedupe_key, status, attempts, run_at FROM jobs WHERE kind = 'meeting.world_verify' ORDER BY id");
    /** 这类还在等的任务改成现在就到期；给了 attempts 就把已跑次数拨到这个数（领取时再加一）。 */
    const due = (t: T, kind: string, attempts?: number) =>
      t.pool.query("UPDATE jobs SET run_at = now() - interval '1 minute', attempts = COALESCE($2, attempts) WHERE kind = $1 AND status = 'pending'", [kind, attempts ?? null]);
    /** 确认、第一次写入网络错，然后写入任务最后一次仍网络错。 */
    async function offlineToLastAttempt(t: T, host: string, meetingId: string, run: () => Promise<void>) {
      await confirm(t, host, meetingId, { draftVersion: await ready(t, host, meetingId), writeToWorld: true });
      await run();
      await due(t, "meeting.world_sync", JOB_MAX_ATTEMPTS - 1);
      await run();
      expect(await t.sql("SELECT status FROM jobs WHERE kind = 'meeting.world_sync'")).toEqual([{ status: "done" }]);
    }
    /** 待核验时：会议照网络错显示（写入中，不显示失败），台账没有失败，排了一条 1 小时后的核验。 */
    async function expectUnverified(t: T, host: string, meetingId: string) {
      expect(await ledgerStatus(t, meetingId)).toBe("unverified");
      expect(await failedRows(t)).toBe(0);
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "pending", eventId: null, error: "连不上本体" });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "writing" });
    }

    it("本体其实已经记下（回包丢了）：核验时同键重放拿回原回执，台账 committed，本体只有一条事件", async () => {
      let lost = true;
      const world = ontology({ lost: () => lost });
      const { t, host, meetingId, run } = await setup();
      try {
        const started = Date.now();
        await offlineToLastAttempt(t, host, meetingId, run);
        await expectUnverified(t, host, meetingId);
        const [job] = await verifyJobs(t);
        expect(job).toMatchObject({ status: "pending", attempts: 0 });
        expect(String(job.dedupe_key)).toContain(keyOf(meetingId));
        expect(new Date(job.run_at as Date).getTime() - started).toBeGreaterThanOrEqual(60 * 60_000);
        // 不到 1 小时不跑。
        const writes = world.writes().length;
        await run();
        expect(world.writes()).toHaveLength(writes);

        lost = false;
        await due(t, "meeting.world_verify");
        await run();
        expect(world.recorded).toHaveLength(1);
        expect(world.writes().map((body) => body.idempotency_key)).toEqual(world.writes().map(() => keyOf(meetingId)));
        for (const body of world.writes().slice(1)) expect(body).toEqual(world.writes()[0]);
        expect(await ledgerStatus(t, meetingId)).toBe("committed");
        expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1", error: null });
        expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", eventId: "ev-1" });
        expect((await verifyJobs(t)).map((row) => row.status)).toEqual(["done"]);
      } finally {
        await t.close();
      }
    });

    it("本体里没有、核验时网络恢复：写入成功，台账 committed，只有一条事件", async () => {
      let down = true;
      const world = ontology({ network: () => down });
      const { t, host, meetingId, run } = await setup();
      try {
        await offlineToLastAttempt(t, host, meetingId, run);
        await expectUnverified(t, host, meetingId);
        expect(world.recorded).toHaveLength(0);
        down = false;
        await due(t, "meeting.world_verify");
        await run();
        expect(world.recorded).toHaveLength(1);
        expect(await ledgerStatus(t, meetingId)).toBe("committed");
        expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1", error: null });
      } finally {
        await t.close();
      }
    });

    it("核验时一直连不上：按退避重试，最后一次仍网络错就 2 小时后再排一条核验，一直是待核验、不记失败，本体回话后写成", async () => {
      let down = true;
      const world = ontology({ network: () => down });
      const { t, host, meetingId, run } = await setup();
      try {
        await offlineToLastAttempt(t, host, meetingId, run);
        await due(t, "meeting.world_verify");
        await run();
        // 网络错：核验任务按 jobs 退避等下一次。
        expect((await verifyJobs(t))[0]).toMatchObject({ status: "pending", attempts: 1 });
        await expectUnverified(t, host, meetingId);
        const beforeLast = Date.now();
        await due(t, "meeting.world_verify", JOB_MAX_ATTEMPTS - 1);
        await run();
        // 最后一次仍网络错：这一条正常结束，接着排下一条核验（2 小时后），不会卡住。
        const [last, next] = await verifyJobs(t);
        expect([last.status, next.status, next.attempts]).toEqual(["done", "pending", 0]);
        expect(next.dedupe_key).not.toBe(last.dedupe_key);
        expect(String(next.dedupe_key)).toContain(keyOf(meetingId));
        expect(new Date(next.run_at as Date).getTime() - beforeLast).toBeGreaterThanOrEqual(2 * 60 * 60_000);
        await expectUnverified(t, host, meetingId);

        down = false;
        await due(t, "meeting.world_verify");
        await run();
        expect(world.recorded).toHaveLength(1);
        expect(await ledgerStatus(t, meetingId)).toBe("committed");
        expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1", error: null });
        expect((await verifyJobs(t)).map((row) => row.status)).toEqual(["done", "done"]);
      } finally {
        await t.close();
      }
    });

    it("核验时对象版本已前进（409 VERSION_CONFLICT）：记失败「目标已变」，本体里没有事件", async () => {
      let down = true;
      let moved = false;
      const world = ontology({ network: () => down, conflict: () => moved });
      const { t, host, meetingId, run } = await setup();
      try {
        await offlineToLastAttempt(t, host, meetingId, run);
        down = false;
        moved = true;
        await due(t, "meeting.world_verify");
        await run();
        expect(await ledgerStatus(t, meetingId)).toBe("failed");
        expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "failed", eventId: null, error: "目标已变" });
        expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "failed" });
        expect(world.recorded).toHaveLength(0);
        expect((await verifyJobs(t)).map((row) => row.status)).toEqual(["done"]);
      } finally {
        await t.close();
      }
    });
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
      expect(failed.sync!.event).toMatchObject({ status: "failed", eventId: null, error: "读回不一致" });
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "failed", version: 1 });

      readable = true;
      const again = (await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).json() as TMeetingCardView;
      expect(again.confirmed!.confirmation.revision).toBe(1);
      await run();
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([`tianshu-meeting:${meetingId}:v1:event`, `tianshu-meeting:${meetingId}:v1:event`]);
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "succeeded", eventId: "ev-1" });
    } finally {
      await t.close();
    }
  });

  it("写失败后同一草稿再选不写入：不出新版本、不重排、不再发请求", async () => {
    const world = ontology({ readable: () => false });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "failed" });
      const requests = world.calls.length;

      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: false });
      expect(res.statusCode).toBe(200);
      expect((res.json() as TMeetingCardView)).toMatchObject({ confirmed: { confirmation: { revision: 1 } }, sync: { writeToWorld: true, event: { status: "failed" } } });
      expect((await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync' AND status = 'pending'"))[0].n).toBe(0);
      await run();
      expect(world.calls.slice(requests).filter((call) => call.url.pathname.startsWith("/v1/actions") || call.url.pathname.endsWith("/events"))).toEqual([]);
      expect(world.writes()).toHaveLength(1);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].n).toBe(1);
    } finally {
      await t.close();
    }
  });

  it("读回找到了这条但正文对不上摘要值：不算写成", async () => {
    let tampered = true;
    const world = ontology({ tampered: () => tampered });
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      expect(world.writes()).toHaveLength(1);
      expect((await getCard(t, host, meetingId)).sync!.event).toMatchObject({ status: "failed", eventId: null, error: "读回不一致" });
      tampered = false;
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
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
      expect(view.confirmed!.confirmation.confirmedBy).toBe(HOST);
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");

      // 同一草稿改成写入：不出新版本、不用选原因，写一条（拍板 8）。
      const enabled = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(enabled.statusCode).toBe(200);
      expect((enabled.json() as TMeetingCardView)).toMatchObject({ confirmed: { kind: "first", confirmation: { revision: 1 } },
        sync: { revision: 1, writeToWorld: true, event: { status: "pending" } } });
      await run();
      expect(world.writes()).toHaveLength(1);
      expect(parsed(world.writes()[0]).payload.revision).toBe(1);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].n).toBe(1);
      expect((await worldOf(t, host, meetingId)).world).toMatchObject({ excluded: false, excludedBy: null, record: { status: "committed", version: 1, eventId: "ev-1" } });
    } finally {
      await t.close();
    }
  });

  it("只关会议写本体（MEETING_WORLD_WRITES_OFF）：照常确认，选了写入也按不写入记，不排写入任务、不发写请求，没有可重试的；读挂点照旧，视图带 worldWritesOff", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup(cardAgent(), { meetingWorldWritesOff: true });
    try {
      const before = await getCard(t, host, meetingId);
      expect(before.worldWritesOff).toBe(true);
      // 读还开着：挂点对象里能改的组件照样读得到。
      expect(before.targetOptions.map((option) => option.targetRef)).toContain("obj-po-1#target/acc-1");

      const draftVersion = await ready(t, host, meetingId);
      const confirmed = await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      expect(confirmed.statusCode).toBe(200);
      const view = confirmed.json() as TMeetingCardView;
      expect(view.confirmed).toMatchObject({ kind: "first", confirmation: { revision: 1, confirmedBy: HOST } });
      expect(view.sync).toMatchObject({ writeToWorld: false, event: { status: "skipped", eventId: null } });
      expect(view.sync!.objects.every((object) => object.status !== "pending")).toBe(true);
      await run();
      // 同一草稿再点一次写入：还是不写入，不变成「写入中」。
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: true })).json().sync).toMatchObject({ writeToWorld: false, event: { status: "skipped" } });
      await run();

      expect(await t.sql("SELECT count(*)::int AS n FROM jobs WHERE kind = 'meeting.world_sync'")).toEqual([{ n: 0 }]);
      expect(world.calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
      const retried = await retry(t, host, meetingId);
      expect([retried.statusCode, retried.json().code]).toEqual([409, "NOTHING_TO_RETRY"]);
      expect((await t.sql("SELECT status FROM meetings WHERE id = $1", [meetingId]))[0].status).toBe("reviewed");
    } finally {
      await t.close();
    }
  });

  it("写过再选不写入：不出新版本、不追加，原事件保留", async () => {
    const world = ontology();
    const { t, host, meetingId, run } = await setup();
    try {
      const draftVersion = await ready(t, host, meetingId);
      await confirm(t, host, meetingId, { draftVersion, writeToWorld: true });
      await run();
      const res = await confirm(t, host, meetingId, { draftVersion, writeToWorld: false });
      expect(res.statusCode).toBe(200);
      expect((res.json() as TMeetingCardView)).toMatchObject({ confirmed: { confirmation: { revision: 1 } },
        sync: { writeToWorld: true, event: { status: "succeeded", eventId: "ev-1" } } });
      await run();
      expect(world.writes()).toHaveLength(1);
      expect((await t.sql("SELECT count(*)::int AS n FROM meeting_card_confirmations WHERE meeting_id = $1", [meetingId]))[0].n).toBe(1);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 1, eventId: "ev-1" });
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
      // 被更正那条的台账没了：沿用同步回执里记下的 subject_refs 和 occurred_at。
      await t.pool.query("DELETE FROM world_sync_ledger WHERE idempotency_key = $1", [`tianshu-meeting:${meetingId}:v1:event`]);
      const next = await edit(t, host, meetingId, (draft) => { draft.sections[0].body = "已定：接口统一改成 v2，十月底切换。"; draft.occurredAt = "2026-06-01T10:30:00+08:00"; });
      const view = (await confirm(t, host, meetingId, { draftVersion: next.draftVersion, writeToWorld: true, kind: "correction", reason: "记错了切换时间" })).json() as TMeetingCardView;
      expect(view.confirmed).toMatchObject({ kind: "correction", payload: { revision: 2, relatedObjectRefs: ["obj-po-1@6"] } });
      await run();
      const [first, second] = world.writes();
      expect(second.idempotency_key).toBe(`tianshu-meeting:${meetingId}:v2:event`);
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
      expect(world.writes().map((body) => body.idempotency_key)).toEqual([1, 2, 3].map((revision) => `tianshu-meeting:${meetingId}:v${revision}:event`));
      expect(world.writes()[2].params.content.refs).toEqual(["event:ev-2"]);
      expect((await worldOf(t, host, meetingId)).world.record).toMatchObject({ status: "committed", version: 3, eventId: "ev-3" });
    } finally {
      await t.close();
    }
  });
});
