import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import { createJobWorker } from "../src/jobs.js";
import { stubWorld, worldEnv } from "./worldFixture.js";

// 预约建会：带挂点、起止，只存天枢不写本体；主持人（成员）也能给自己建会。挂点选项含本体里的本月 PO 和 LTO，每项带已确认的内容。
const START = "2026-10-22T10:00:00.000+08:00";
const END = "2026-10-22T11:30:00.000+08:00";
const MISSION = "m-booking";
const head = (object_id: string, object_type: string, title: string) => ({
  object_id, object_type, title, revision_id: `${object_id}-rev`, object_version: 1, version: 1, domain_id: "<domain:eo>",
  external_refs: [], lifecycle: { status: "established", display_name: "已成立" }, contract_version: "tkos.world/0.3",
});
const PO = head("<period-goal-oct>", "PeriodGoal", "E&O 10 月目标");
const LTO = head("<long-term-goal-1>", "LongTermGoal", "E&O 长期目标");

const PO_OUTCOME = "十月把预约跑通，每场会都挂到对象上";
const LTO_OUTCOME = "预约成为开会的默认入口";
/** 取对象：目标块里的结果组件。 */
const view = (target: typeof PO, outcome: string) => ({
  business: { ...target, attributes: {}, blocks: [{ id: "target", display_name: "目标", components: [{ id: "c1", type: "outcome", text: outcome }, { id: "c2", type: "success_criterion", text: "不进 brief" }] }] },
  records: { lifecycle: target.lifecycle }, protocol: { contract_version: target.contract_version },
});

/** 假本体：按类型列对象（PeriodGoal 只在 period=2026-10 时有）、按 id 取 PO 和 LTO；其余请求一律空。 */
function ontology() {
  return stubWorld(({ url }) => {
    if (url.pathname === `/v1/world/objects/${encodeURIComponent(PO.object_id)}`) return view(PO, PO_OUTCOME);
    if (url.pathname === `/v1/world/objects/${encodeURIComponent(LTO.object_id)}`) return view(LTO, LTO_OUTCOME);
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

/** 一张还在草稿轮次里的 Mission（本月计划已签，Mission 轮次没确认）。 */
async function seedDraftMission(t: TestApp) {
  await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
    VALUES ('00000000-0000-4000-8000-000000000001',1,'2026-10','confirmed','公司目标','[]','[]','{}','{}','2026-10-01T02:00:00Z')`);
  await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
    VALUES ('00000000-0000-4000-8000-000000000002',1,'growth','2026-10','00000000-0000-4000-8000-000000000001','draft','placeholder','{}','2026-10-01T02:00:00Z','2026-10-01T02:00:00Z')`);
  await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at)
    VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',$1,0,$2::jsonb,'2026-10-01T02:00:00Z')`, [TEST_MEMBER.personId, JSON.stringify([TEST_MEMBER.personId])]);
  await t.sql(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, outcome, source_ref, source_document_id, source_revision, source_title, personal_mission_card_id)
    VALUES ('m-draft', 1, 'draft-202610', '2026-10', '草稿里的 Mission', $1, 'unit-booking', '还没定的结果', 'test://m', 'test', 1, '测试', '00000000-0000-4000-8000-000000000003')`, [TEST_MEMBER.personId]);
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
      // 建会表单选参会人：成员读人员名册（只有 personId 和名字），完整人员目录仍只给 CEO。
      expect((await t.app.inject({ method: "GET", url: "/api/people", headers: { cookie: member } })).statusCode).toBe(403);
      const roster = await t.app.inject({ method: "GET", url: "/api/people/directory", headers: { cookie: member } });
      expect(roster.statusCode).toBe(200);
      const people = roster.json().people as Record<string, unknown>[];
      expect(people.length).toBeGreaterThan(0);
      for (const person of people) expect(Object.keys(person).sort()).toEqual(["displayName", "personId"]);
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
      // 校验挂点只列对象，不取 PO 的内容。
      expect(calls.some((call) => call.url.pathname.startsWith("/v1/world/objects/"))).toBe(false);
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
      // 会议卡带上建会的人（会议页据此给「再读一次」、贴妙记链接）。
      expect(byCeo.json().card.payload.createdBy).toBe(TEST_CEO.personId);
      // 建会的 CEO 和主持人都能编辑、整卡确认会议卡（还没有草稿：确认得到 409 而不是 404）。
      const { cards, cardConfirm } = t.app.meetingFollowThrough;
      for (const personId of [TEST_CEO.personId, TEST_MEMBER.personId]) {
        const viewer = { personId, isCeo: personId === TEST_CEO.personId };
        expect(await cards.view(meetingId, viewer)).toMatchObject({ view: { canEdit: true } });
        expect(await cardConfirm.confirm(meetingId, viewer, { draftVersion: 0, writeToWorld: false })).toMatchObject({ error: { status: 409, code: "CARD_NOT_READY" } });
      }
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
      // 这个 Mission 在本体里服务那个 PO（载入时记下的 goal_ref）。
      await t.pool.query("UPDATE missions SET world_goal_id = $2, battlefield_ids = '[\"growth\"]'::jsonb WHERE id = $1", [MISSION, PO.object_id]);
      const res = await t.app.inject({ method: "GET", url: "/api/world-anchor-options?period=2026-10", headers: { cookie: await t.memberCookie() } });
      expect(res.statusCode).toBe(200);
      const options = res.json().options as { kind: string; id: string; title: string }[];
      expect(options.filter((option) => option.kind === "po")).toEqual([{ kind: "po", id: PO.object_id, title: PO.title, brief: PO_OUTCOME, lifecycle: "established", ownerId: null, parentId: null }]);
      expect(options.filter((option) => option.kind === "lto")).toEqual([{ kind: "lto", id: LTO.object_id, title: LTO.title, brief: LTO_OUTCOME, lifecycle: "established", ownerId: null, parentId: null }]);
      expect(options).toContainEqual(expect.objectContaining({ kind: "mission", id: MISSION, title: "预约挂点 Mission", ownerId: TEST_MEMBER.personId, parentId: PO.object_id, group: "增长战场" }));
      expect(options).toContainEqual(expect.objectContaining({ kind: "unit", id: "unit-booking", title: "预约单元" }));
    } finally {
      await t.close();
    }
  });

  it("挂点候选带已确认内容", async () => {
    ontology();
    const t = await createTestApp(worldEnv);
    try {
      await seed(t);
      await seedDraftMission(t);
      const res = await t.app.inject({ method: "GET", url: "/api/world-anchor-options?period=2026-10", headers: { cookie: await t.memberCookie() } });
      expect(res.statusCode).toBe(200);
      const options = res.json().options as { kind: string; id: string; brief: string | null; lifecycle: string | null }[];
      expect(options.find((option) => option.kind === "po")).toMatchObject({ brief: PO_OUTCOME, lifecycle: "established" });
      expect(options.find((option) => option.id === "m-draft")).toMatchObject({ kind: "mission", brief: null, lifecycle: "draft" });
      expect(options.find((option) => option.id === "unit-booking")).toMatchObject({ kind: "unit", brief: "预约单元" });

      // 草稿的 PO 不取内容（不读对象）；读不到对象时 brief 是 null，选项照给。
      const draftPo = { ...PO, object_id: "<period-goal-draft>", title: "草稿 PO", lifecycle: { status: "draft" } };
      const otherLto = { ...LTO, object_id: "<long-term-goal-2>", title: "读不到的 LTO" };
      const calls = stubWorld(({ url }) => {
        if (url.pathname === "/v1/world/objects") {
          const type = url.searchParams.get("type");
          return { items: type === "PeriodGoal" ? [draftPo] : type === "LongTermGoal" ? [otherLto] : [], next_cursor: null };
        }
        return new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "down" } }), { status: 503 });
      });
      const again = await t.app.inject({ method: "GET", url: "/api/world-anchor-options?period=2026-10", headers: { cookie: await t.memberCookie() } });
      const goals = (again.json().options as { kind: string }[]).filter((option) => option.kind === "po" || option.kind === "lto");
      expect(goals).toEqual([
        { kind: "po", id: draftPo.object_id, title: "草稿 PO", brief: null, lifecycle: "draft", ownerId: null, parentId: null },
        { kind: "lto", id: otherLto.object_id, title: "读不到的 LTO", brief: null, lifecycle: "established", ownerId: null, parentId: null },
      ]);
      expect(calls.some((call) => call.url.pathname.endsWith(encodeURIComponent(draftPo.object_id)))).toBe(false);
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
