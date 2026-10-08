import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldClient } from "../src/worldClient.js";
import { createWorldMeetingService, meetingEventAction, selectMeetingSubjects } from "../src/worldMeetingEvents.js";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import { executeConfirmItem, executeDismissItem, onOutcomeReviewed, pendingOntologyUpdater, pendingOutcome } from "../src/outcome.js";
import { examples, instance, projection, stubWorld, withWorld, worldEnv } from "./worldFixture.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, testEnv } from "./helpers.js";
import { signActionId } from "../src/actionToken.js";

afterEach(() => vi.unstubAllGlobals());
const now = () => new Date("2026-09-30T08:00:00Z");
const item = (id: string, status = "confirmed") => ({ id, kind: "ceoJudgment", text: `确认结论 ${id}`, turnId: "turn-1", quote: "确认结论", speakerId: TEST_CEO.personId,
  ownerPersonId: null, issueId: null, judgmentKind: "external_commitment", parentItemId: null, review: { status, effectRef: status === "confirmed" ? `effect:${id}` : null } });

async function seedMeeting(pool: Pool, options: { eo?: boolean; pending?: boolean; scheduledAt?: string } = {}) {
  const id = randomUUID();
  const eoOwner = options.eo === false ? "another-owner" : TEST_MEMBER.personId;
  await pool.query(`INSERT INTO capability_config (id, version, name, "group", six_month_outcome, code, owner_id)
    VALUES ('eo-test',1,'E&O','test','','05',$1) ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id`, [eoOwner]);
  const outcome = { ...pendingOutcome(), status: "ready", summary: "模型摘要不可直接推送", items: [item("one", options.pending ? "pending" : "confirmed"), item("ignored", "dismissed")] };
  await pool.query(`INSERT INTO meetings (id,version,title,status,scheduled_at,ends_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,outcome,origin_ref)
    VALUES ($1,1,'E&O 周会',$2,$3,$3::timestamptz + interval '1 hour',$4,$5,'[]','[]',$6::jsonb,$7::jsonb,$8::jsonb,'{"type":"manual"}')`,
    [id, options.pending ? "held" : "reviewed", options.scheduledAt ?? "2026-09-29T15:19:05+08:00", TEST_MEMBER.personId, TEST_CEO.personId, JSON.stringify(emptyPreflight()), JSON.stringify(emptyDraft()), JSON.stringify(outcome)]);
  return id;
}
function meetingHttp(onCommit?: (body: any) => unknown | Promise<unknown>) {
  return stubWorld(({ url, body }) => {
    if (url.pathname === "/v1/world/objects") return examples[1][0];
    if (url.pathname.startsWith("/v1/world/objects/")) return projection(examples[1][0].items[0]);
    if (url.pathname.endsWith("/prepare")) return { expected_versions: [] };
    return onCommit ? onCommit(body) : examples[4][1];
  });
}
const scope = (id: string, version: number, itemId = "one") => ({ objectType: "meeting", objectId: id, objectVersion: version, actionType: "meeting.confirm_item", itemId });

describe("world 会议事件", () => {
  it("§4 会议事件使用 content、多主体、+08:00 与首主体声明", async () => {
    const action = meetingEventAction({ id: "1", version: 1, scheduledAt: "2026-09-29T07:19:05Z", text: examples[4][0].params.content.text }, ["<mission-1>@3", "<period-goal-1>@1"], "https://example.com/tianshu");
    expect(action.params).toEqual({ ...examples[4][0].params, content: { ...examples[4][0].params.content, artifacts: ["https://example.com/tianshu/meetings/1"] } });
    expect(action.idempotency_key).toBe("tianshu:meeting:1");
  });
  it("主体选择：多个已链接 Mission 去重；无关联或均未链接时回落单元", async () => {
    await withWorld(async (client) => {
      const mission = examples[2][4].items[0];
      const other = { ...mission, object_id: "<mission-2>" };
      const calls = stubWorld(({ url }) => {
        if (url.pathname === "/v1/world/objects") {
          const external = url.searchParams.get("external_id");
          const items = external === "capability:05" ? examples[1][0].items : external === "mission:a" ? [mission] : external === "mission:b" ? [other] : [];
          return { items, next_cursor: null };
        }
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return projection(id === "<mission-1>" ? mission : id === "<mission-2>" ? other : examples[1][0].items[0]);
      });
      expect(await selectMeetingSubjects(client, ["a", "a", "b", "missing"])).toEqual(["<mission-1>@3", "<mission-2>@3"]);
      expect(calls.some((call) => call.url.searchParams.get("external_id") === "capability:05")).toBe(false);
      expect(await selectMeetingSubjects(client, [])).toEqual(["<unit:eo>@2"]);
      expect(await selectMeetingSubjects(client, ["missing"])).toEqual(["<unit:eo>@2"]);
    });
  });
  it("确认前不发；最后一项确认提交后推已确认结论，排除摘要与忽略项", async () => {
    await withWorld(async (client, { pool }) => {
      const id = await seedMeeting(pool, { pending: true });
      const calls = meetingHttp();
      const service = createWorldMeetingService(pool, client, testEnv.publicOrigin, now);
      const unsubscribe = onOutcomeReviewed(pool, service.schedule);
      try {
        service.schedule(id);
        await service.idle();
        expect(calls).toHaveLength(0);
        const confirmed = await executeConfirmItem(pool, pendingOntologyUpdater, testEnv.sessionSecret, scope(id, 1), "confirm-world-one");
        expect("card" in confirmed).toBe(true);
        await service.idle();
        const commit = calls.find((call) => call.url.pathname === "/v1/actions")!;
        expect(commit.body.params).toMatchObject({ category: "meeting", subject_refs: ["<unit:eo>@2"], occurred_at: "2026-09-29T15:19:05+08:00", content: { text: "确认结论 one", artifacts: [`https://warmap.local/meetings/${id}`] } });
        expect(commit.body.params.payload).toBeUndefined();
        expect((await pool.query("SELECT status,event_id FROM world_meeting_events")).rows).toEqual([{ status: "committed", event_id: "<event-15>" }]);
        await executeConfirmItem(pool, pendingOntologyUpdater, testEnv.sessionSecret, scope(id, 1), "confirm-world-one");
        service.schedule(id);
        await service.idle();
        expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
      } finally { unsubscribe(); await service.close(); }
    });
  });
  it("最后一项忽略也完成确认；非 E&O 会议不排队、不发 HTTP", async () => {
    await withWorld(async (client, { pool }) => {
      const id = await seedMeeting(pool);
      const second = item("pending", "pending");
      await pool.query("UPDATE meetings SET status='held', outcome=jsonb_set(outcome,'{items}',(outcome->'items') || $2::jsonb) WHERE id=$1", [id, JSON.stringify([second])]);
      const calls = meetingHttp();
      const service = createWorldMeetingService(pool, client, testEnv.publicOrigin, now);
      const unsubscribe = onOutcomeReviewed(pool, service.schedule);
      try {
        await executeDismissItem(pool, testEnv.sessionSecret, scope(id, 1, "pending"), "dismiss-world-pending");
        await service.idle();
        expect(calls.filter((call) => call.url.pathname === "/v1/actions")).toHaveLength(1);
        const other = await seedMeeting(pool, { eo: false });
        const before = calls.length;
        service.schedule(other);
        await service.idle();
        expect(calls).toHaveLength(before);
        expect((await pool.query("SELECT 1 FROM world_meeting_events WHERE meeting_id=$1", [other])).rowCount).toBe(0);
      } finally { unsubscribe(); await service.close(); }
    });
  });
  it("未来开始的会延迟推送，不篡改 occurred_at", async () => {
    await withWorld(async (client, { pool }) => {
      const id = await seedMeeting(pool, { scheduledAt: "2026-10-01T09:00:00+08:00" });
      const calls = meetingHttp();
      let clock = now();
      const service = createWorldMeetingService(pool, client, testEnv.publicOrigin, () => clock);
      try {
        service.schedule(id); await service.idle();
        expect(calls).toHaveLength(0);
        clock = new Date("2026-10-01T02:00:00Z");
        service.retry(); await service.idle();
        expect(calls.at(-1)!.body.params.occurred_at).toBe("2026-10-01T09:00:00+08:00");
      } finally { await service.close(); }
    });
  });
  it("网络失败在重启后同键重放；更正确认新增 correction 指向原事件，相同结论不重发", async () => {
    await withWorld(async (client, { pool }) => {
      const id = await seedMeeting(pool);
      let failed = false;
      const calls = meetingHttp((body) => {
        if (!failed) { failed = true; throw new Error("lost response"); }
        return { ...examples[4][1], result: { ...examples[4][1].result, event_id: body.params.category === "correction" ? "corrected-event" : "<event-15>" } };
      });
      const first = createWorldMeetingService(pool, client, testEnv.publicOrigin, now);
      first.schedule(id); await first.close();
      expect((await pool.query("SELECT status,error_code FROM world_meeting_events")).rows).toEqual([{ status: "pending", error_code: "NETWORK_ERROR" }]);
      const restarted = createWorldMeetingService(pool, new WorldClient(pool.query.bind(pool), worldEnv, instance), testEnv.publicOrigin, now);
      try {
        await restarted.idle();
        let commits = calls.filter((call) => call.url.pathname === "/v1/actions");
        expect(commits[1].body).toEqual(commits[0].body);
        await pool.query("UPDATE meetings SET version=2,outcome=jsonb_set(outcome,'{items,0,text}','\"更正后的结论\"') WHERE id=$1", [id]);
        restarted.schedule(id); await restarted.idle();
        commits = calls.filter((call) => call.url.pathname === "/v1/actions");
        expect(commits[2].body).toMatchObject({ idempotency_key: `tianshu:meeting:${id}:correction:2`, params: { category: "correction", supersedes_event_id: "<event-15>", content: { text: "更正后的结论" } } });
        await pool.query("UPDATE meetings SET version=3 WHERE id=$1", [id]);
        restarted.schedule(id); await restarted.idle();
        expect(calls.filter((call) => call.url.pathname === "/v1/actions")).toHaveLength(3);
      } finally { await restarted.close(); }
    });
  });
  it("403 留可见失败，不被后台轮询重试", async () => {
    await withWorld(async (client, { pool }) => {
      const id = await seedMeeting(pool);
      const calls = meetingHttp(() => Response.json(examples[11][5], { status: 403 }));
      const service = createWorldMeetingService(pool, client, testEnv.publicOrigin, now);
      try {
        service.schedule(id); await service.idle(); service.retry(); await service.idle();
        expect(calls.filter((call) => call.url.pathname === "/v1/actions")).toHaveLength(1);
        expect((await pool.query("SELECT status,error_code FROM world_meeting_events")).rows).toEqual([{ status: "failed", error_code: "FORBIDDEN" }]);
      } finally { await service.close(); }
    });
  });
  it("真实确认 API 响应不等待 world HTTP；healthz 按配置报告且无凭据", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls = meetingHttp(async () => { await blocked; return examples[4][1]; });
    const t = await createTestApp(worldEnv);
    try {
      const id = await seedMeeting(t.pool, { pending: true });
      const cookie = await t.loginCookie();
      const actionId = signActionId(testEnv.sessionSecret, scope(id, 1));
      const response = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers: { cookie, origin: t.publicOrigin }, payload: { actionId } });
      expect(response.statusCode).toBe(200);
      expect(response.json().cards[0].payload.status).toBe("reviewed");
      await vi.waitFor(() => expect(calls.some((call) => call.url.pathname === "/v1/actions")).toBe(true));
      const health = await t.app.inject({ method: "GET", url: "/healthz" });
      expect(health.json().dependencies.world).toBe(true);
      expect(health.body).not.toContain(worldEnv.worldAgentToken);
    } finally { release(); await t.close(); }
  });
  it("缺任一配置时不注册推送，healthz world=false", async () => {
    const calls = meetingHttp();
    const t = await createTestApp({ worldApiUrl: worldEnv.worldApiUrl });
    try {
      const id = await seedMeeting(t.pool, { pending: true });
      await executeConfirmItem(t.pool, pendingOntologyUpdater, testEnv.sessionSecret, scope(id, 1), "disabled-world-confirm");
      expect(calls).toHaveLength(0);
      expect((await t.app.inject({ method: "GET", url: "/healthz" })).json().dependencies.world).toBe(false);
      expect((await t.sql("SELECT * FROM world_meeting_events"))).toHaveLength(0);
    } finally { await t.close(); }
  });
});
