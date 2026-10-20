import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import { createJobWorker } from "../src/jobs.js";
import { stubWorld, worldEnv } from "./worldFixture.js";

// 预约建会：带挂点、起止，只存天枢不写本体；主持人（成员）也能给自己建会。挂点选项含本体里的本月 PO 和 LTO。
const START = "2026-10-22T10:00:00.000+08:00";
const END = "2026-10-22T11:30:00.000+08:00";
const MISSION = "m-booking";
const head = (object_id: string, object_type: string, title: string) => ({
  object_id, object_type, title, revision_id: `${object_id}-rev`, object_version: 1, version: 1, domain_id: "<domain:eo>",
  external_refs: [], lifecycle: { status: "committed" }, contract_version: "tkos.world/0.3",
});
const PO = head("<period-goal-oct>", "PeriodGoal", "E&O 10 月目标");
const LTO = head("<long-term-goal-1>", "LongTermGoal", "E&O 长期目标");

/** 假本体：按类型列对象（PeriodGoal 只在 period=2026-10 时有）；其余请求一律空。 */
function ontology() {
  return stubWorld(({ url }) => {
    if (url.pathname !== "/v1/world/objects") return { ok: true };
    const type = url.searchParams.get("type");
    const items = type === "LongTermGoal" ? [LTO] : type === "PeriodGoal" && url.searchParams.get("period") === "2026-10" ? [PO] : [];
    return { items, next_cursor: null };
  });
}

async function seed(t: TestApp) {
  await t.pool.query("INSERT INTO capability_config (id, version, name, \"group\", six_month_outcome, code, owner_id) VALUES ('unit-booking', 1, '预约单元', 'test', '', '99', $1)", [TEST_MEMBER.personId]);
  await t.pool.query(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title)
    VALUES ($1, 1, 'booking-202610', '2026-10', '预约挂点 Mission', $2, 'unit-booking', '跑通预约', 'test://m', 'test', 1, '测试')`, [MISSION, TEST_MEMBER.personId]);
}

const book = (t: TestApp, cookie: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: "/api/meetings", headers: { cookie, origin: t.publicOrigin }, payload });
const body = (extra: Record<string, unknown> = {}) =>
  ({ title: "预约的会", scheduledAt: START, endsAt: END, anchors: [{ kind: "mission", id: MISSION }], ...extra });

afterEach(() => vi.unstubAllGlobals());

describe("预约建会", () => {
  it("主持人自己建会，挂点和起止都存下", async () => {
    const t = await createTestApp();
    try {
      await seed(t);
      const member = await t.memberCookie();
      const created = await book(t, member, body());
      expect(created.statusCode).toBe(200);
      const meetingId = created.json().card.objectRef.id as string;
      const [row] = await t.sql("SELECT lead_dri_id, world_anchors, scheduled_at, ends_at FROM meetings WHERE id = $1", [meetingId]);
      expect(row.lead_dri_id).toBe(TEST_MEMBER.personId);
      expect(row.world_anchors).toEqual([{ kind: "mission", id: MISSION }]);
      expect((row.scheduled_at as Date).toISOString()).toBe(new Date(START).toISOString());
      expect((row.ends_at as Date).toISOString()).toBe(new Date(END).toISOString());
    } finally {
      await t.close();
    }
  });

  it("建会不写本体", async () => {
    const calls = ontology();
    const t = await createTestApp(worldEnv);
    try {
      await seed(t);
      const created = await book(t, await t.memberCookie(), body({ anchors: [{ kind: "po", id: PO.object_id }, { kind: "mission", id: MISSION }] }));
      expect(created.statusCode).toBe(200);
      const worker = createJobWorker({ pool: t.pool, handlers: t.app.meetingFollowThrough.jobs().handlers });
      while (await worker.tick() > 0);
      expect(calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("成员不能替别人建会，CEO 可以指定主持人", async () => {
    const t = await createTestApp();
    try {
      await seed(t);
      const res = await book(t, await t.memberCookie(), body({ leadDriId: TEST_CEO.personId }));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
      expect(await t.sql("SELECT id FROM meetings")).toEqual([]);

      const ceo = await t.loginCookie();
      const noHost = await book(t, ceo, body());
      expect(noHost.statusCode).toBe(400);
      expect(await t.sql("SELECT id FROM meetings")).toEqual([]);

      const byCeo = await book(t, ceo, body({ leadDriId: TEST_MEMBER.personId }));
      expect(byCeo.statusCode).toBe(200);
      const meetingId = byCeo.json().card.objectRef.id as string;
      const [row] = await t.sql("SELECT lead_dri_id, created_by FROM meetings WHERE id = $1", [meetingId]);
      expect(row).toEqual({ lead_dri_id: TEST_MEMBER.personId, created_by: TEST_CEO.personId });
      // 建会的 CEO 和主持人都能整卡确认。
      const { decisions } = t.app.meetingFollowThrough;
      expect(await decisions.confirmRecord(meetingId, TEST_CEO.personId, { writeToWorld: false })).toMatchObject({ world: { record: { status: "excluded" } } });
      expect(await decisions.confirmRecord(meetingId, TEST_MEMBER.personId, { writeToWorld: false })).toMatchObject({ world: { record: { status: "excluded" } } });
    } finally {
      await t.close();
    }
  });

  it("没有挂点不能建，结束不晚于开始也不能建", async () => {
    const t = await createTestApp();
    try {
      await seed(t);
      const member = await t.memberCookie();
      expect((await book(t, member, body({ anchors: [] }))).statusCode).toBe(400);
      expect((await book(t, member, body({ endsAt: START }))).statusCode).toBe(400);
      expect((await book(t, member, body({ anchors: [{ kind: "mission", id: "not-a-mission" }] }))).statusCode).toBe(400);
      expect(await t.sql("SELECT id FROM meetings")).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("预约时的挂点选项包含 PO 和 LTO", async () => {
    ontology();
    const t = await createTestApp(worldEnv);
    try {
      await seed(t);
      const res = await t.app.inject({ method: "GET", url: "/api/world-anchor-options?period=2026-10", headers: { cookie: await t.memberCookie() } });
      expect(res.statusCode).toBe(200);
      const options = res.json().options as { kind: string; id: string; title: string }[];
      expect(options.filter((option) => option.kind === "po")).toEqual([{ kind: "po", id: PO.object_id, title: PO.title }]);
      expect(options.filter((option) => option.kind === "lto")).toEqual([{ kind: "lto", id: LTO.object_id, title: LTO.title }]);
      expect(options).toContainEqual({ kind: "mission", id: MISSION, title: "预约挂点 Mission" });
      expect(options).toContainEqual({ kind: "unit", id: "unit-booking", title: "预约单元" });
    } finally {
      await t.close();
    }
  });

  it("本体没配时选项只有 Mission 和单元", async () => {
    const t = await createTestApp();
    try {
      await seed(t);
      const res = await t.app.inject({ method: "GET", url: "/api/world-anchor-options?period=2026-10", headers: { cookie: await t.memberCookie() } });
      expect(res.statusCode).toBe(200);
      expect(new Set((res.json().options as { kind: string }[]).map((option) => option.kind))).toEqual(new Set(["mission", "unit"]));
    } finally {
      await t.close();
    }
  });

  it("挂到 LTO 的会：会议页显示本体里的标题，改挂点可换成 PO", async () => {
    ontology();
    const t = await createTestApp(worldEnv);
    try {
      await seed(t);
      const member = await t.memberCookie();
      const created = await book(t, member, body({ anchors: [{ kind: "lto", id: LTO.object_id }] }));
      expect(created.statusCode).toBe(200);
      const meetingId = created.json().card.objectRef.id as string;
      const world = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world`, headers: { cookie: member } });
      expect(world.json().world.anchors).toEqual([{ kind: "lto", id: LTO.object_id, title: LTO.title }]);

      const changed = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: member, origin: t.publicOrigin },
        payload: { anchors: [{ kind: "po", id: PO.object_id }, { kind: "mission", id: MISSION }] } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().world.anchors).toEqual([
        { kind: "po", id: PO.object_id, title: PO.title }, { kind: "mission", id: MISSION, title: "预约挂点 Mission" },
      ]);
      const options = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world-anchor-options`, headers: { cookie: member } });
      expect([...new Set((options.json().options as { kind: string }[]).map((option) => option.kind))]).toEqual(["po", "lto", "mission", "unit"]);

      // 本体读不到了：会议页照样显示存下的标题，留着已选的 PO 改挂点也照样能存。
      stubWorld(() => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "down" } }), { status: 503 }));
      const offline = await t.app.inject({ method: "GET", url: `/api/meetings/${meetingId}/world`, headers: { cookie: member } });
      expect(offline.json().world.anchors).toEqual([
        { kind: "po", id: PO.object_id, title: PO.title }, { kind: "mission", id: MISSION, title: "预约挂点 Mission" },
      ]);
      const kept = await t.app.inject({ method: "PUT", url: `/api/meetings/${meetingId}/world-anchors`, headers: { cookie: member, origin: t.publicOrigin },
        payload: { anchors: [{ kind: "po", id: PO.object_id }] } });
      expect(kept.statusCode).toBe(200);
      expect(kept.json().world.anchors).toEqual([{ kind: "po", id: PO.object_id, title: PO.title }]);
    } finally {
      await t.close();
    }
  });
});
