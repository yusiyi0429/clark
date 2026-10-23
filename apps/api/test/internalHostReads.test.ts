import { afterEach, describe, expect, it, vi } from "vitest";
import { planItemDates, readMissionPlans, type MissionPlanWorld } from "../src/missionPlanRead.js";
import { createTestApp, type TestApp } from "./helpers.js";
import { CEO, confirm, HOST, OWNER, ready, setup } from "./meetingCardFixture.js";
import { projection, stubWorld, worldEnv } from "./worldFixture.js";

// 给独立 Chat 的宿主只读接口（10/22 与人豪定稿）：X-Viewer-Role 必填并按人员目录核对；待决议题、预约会议、首页卡片（工具清单 10/22 人豪定为不做）。
const TOKEN = "internal-chat-test";
const HOUR = 60 * 60 * 1000;
const NEW_ROUTES = ["/internal/pending-issues", "/internal/scheduled-meetings", "/internal/home-cards", "/internal/mission-plans"];

const get = (t: TestApp, url: string, personId: string, role?: string) => t.app.inject({ method: "GET", url,
  headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": personId, ...(role ? { "x-viewer-role": role } : {}) } });

/** 假本体：挂点 PO，只读（整卡确认要读）。 */
function ontology() {
  const po = {
    object_id: "obj-po-1", object_type: "PeriodGoal", title: "十月交付", revision_id: "obj-po-1-r5", object_version: 5, version: 5,
    lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", external_refs: [],
    blocks: [{ id: "target", components: [{ id: "acc-1", type: "acceptance_criterion", text: "十月底前 3 家客户上线" }] }],
  };
  stubWorld((call) => call.url.pathname === `/v1/world/objects/${po.object_id}` ? projection(po) : { items: [], next_cursor: null });
}

/** 把会挪到相对现在的时间。 */
const place = (t: TestApp, meetingId: string, startOffset: number, endOffset: number) =>
  t.sql("UPDATE meetings SET scheduled_at = $2, ends_at = $3, ended_at = NULL WHERE id = $1",
    [meetingId, new Date(Date.now() + startOffset), new Date(Date.now() + endOffset)]);

/** 复制一场还没交记录的预约会（同样的参会人和会议群），没有会议卡。 */
async function cloneScheduled(t: TestApp, meetingId: string, startOffset: number, endOffset: number): Promise<string> {
  const id = crypto.randomUUID();
  await t.sql("CREATE TEMP TABLE m_copy AS SELECT * FROM meetings WHERE id = $1", [meetingId]);
  await t.sql("UPDATE m_copy SET id = $1, status = 'scheduled', transcript = NULL", [id]);
  await t.sql("INSERT INTO meetings SELECT * FROM m_copy");
  await t.sql("DROP TABLE m_copy");
  await t.sql(`INSERT INTO thread_members (object_type, object_id, person_id, added_by)
    SELECT object_type, $2, person_id, added_by FROM thread_members WHERE object_type = 'meeting' AND object_id = $1`, [meetingId, id]);
  await place(t, id, startOffset, endOffset);
  return id;
}

/** Mission 计划的用例把「现在」定在 2026-10（公司时区），没写年的日期按它推。 */
const MONTH = "2026-10";
const LAST_MONTH = "2026-09";
const planApp = (env: Parameters<typeof createTestApp>[0] = {}) =>
  createTestApp({ ...env, internalChatToken: TOKEN }, undefined, { monthlyNow: () => new Date("2026-10-23T02:00:00Z") });

/** 主持人（测试乙）的 Mission：本月两条（rehearsal-a 本体里有，rehearsal-b 没关联）；占位的和上月的不列。 */
async function seedMissions(t: TestApp) {
  const insert = (id: string, code: string, period: string, placeholder = false) => t.sql(`INSERT INTO missions
    (id, version, code, period, title, owner_id, capability_id, outcome, placeholder, source_ref, source_document_id, source_revision, source_title)
    VALUES ($1, 1, $2, $3, $4, $5, 'unit-test', '结果', $6, 'test://m', 'test', 1, '测试')`, [id, code, period, `Mission ${code}`, HOST, placeholder]);
  await insert("m-a", "rehearsal-a", MONTH);
  await insert("m-b", "rehearsal-b", MONTH);
  await insert("m-c", "rehearsal-c", MONTH, true);
  await insert("m-d", "rehearsal-d", LAST_MONTH);
}
/** 本体里 rehearsal-a 对应的 Mission（0.3 读回：组件既在块上也在 value 里，Task 全景块只挂在块上）。 */
const missionObject = {
  object_id: "obj-mission-a", object_type: "Mission", title: "冒烟 Mission", revision_id: "rev-4", object_version: 4, version: 4,
  lifecycle: { status: "active" }, contract_version: "tkos.world/0.3", domain_id: "domain-aidc", external_refs: [{ system: "tianshu", id: "mission:rehearsal-a" }],
  blocks: [
    { id: "definition", components: [{ id: "m-ac1", type: "acceptance_criterion", text: "预发可用" }] },
    { id: "mission_plan", value: { components: [{ id: "mp-path", type: "core_path", text: "先预发后上线" }, { id: "mp-ms1", type: "milestone", text: "2026年10月28日 正式上线" }] },
      components: [{ id: "mp-path", type: "core_path", text: "先预发后上线" }, { id: "mp-ms1", type: "milestone", text: "2026年10月28日 正式上线" }] },
    { id: "execution_plan", value: null, components: [
      { id: "pi-preview-teardown", type: "plan_item", text: "预发环境回收：10/27 前停服务、删卷和站点" },
      { id: "pi-notes", type: "plan_item", text: "整理 TK 的接入说明" },
    ] },
  ],
};
/** 假本体：按外部引用列对象、取对象；unreachable 时列对象就断网。 */
function missionWorld(options: { unreachable?: boolean } = {}) {
  return stubWorld((call) => {
    if (call.url.pathname === "/v1/world/objects") {
      if (options.unreachable && call.url.searchParams.has("external_id")) throw new TypeError("fetch failed");
      return { items: call.url.searchParams.get("external_id") === "mission:rehearsal-a" ? [missionObject] : [], next_cursor: null };
    }
    if (call.url.pathname === `/v1/world/objects/${missionObject.object_id}`) return projection(missionObject);
    return { ok: true };
  });
}
const statuses = (body: { missions: { code: string; planStatus: string; plan: unknown }[] }) =>
  body.missions.map(({ code, planStatus, plan }) => ({ code, planStatus, plan }));
const missionPlanCalls = (calls: { url: URL }[]) => calls.filter((call) => call.url.searchParams.get("external_id")?.startsWith("mission:"));
const missionPlans = async (t: TestApp, personId: string, role: string) => {
  const res = await get(t, "/internal/mission-plans", personId, role);
  expect(res.statusCode).toBe(200);
  return res.json();
};

afterEach(() => vi.unstubAllGlobals());

describe("给独立 Chat 的宿主只读接口", () => {
  it("视角必填并按人员目录核对：缺视角 400，用不了 403，不在目录 404；三个会议接口也一样", async () => {
    const { t, meetingId } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      for (const url of [...NEW_ROUTES, "/internal/confirmed-meetings", `/internal/confirmed-meetings/${meetingId}`, `/internal/confirmed-meetings/${meetingId}/transcript`]) {
        expect((await t.app.inject({ method: "GET", url, headers: { "x-owner-id": CEO, "x-viewer-role": "ceo" } })).statusCode).toBe(401);
        for (const role of [undefined, "admin"]) {
          const missing = await get(t, url, CEO, role);
          expect([missing.statusCode, missing.json().code]).toEqual([400, "VIEW_REQUIRED"]);
        }
        // CEO 本人没有 DRI / 参与人角色，用不了成员视角；主持人不是 CEO。
        expect((await get(t, url, CEO, "member")).json().code).toBe("VIEW_NOT_ALLOWED");
        const denied = await get(t, url, HOST, "ceo");
        expect([denied.statusCode, denied.json().code]).toEqual([403, "VIEW_NOT_ALLOWED"]);
      }
      for (const url of NEW_ROUTES) {
        const unknown = await get(t, url, "person-nobody", "member");
        expect([unknown.statusCode, unknown.json().code]).toEqual([404, "OWNER_NOT_FOUND"]);
      }
      // 会议接口保持原来的错误码。
      expect((await get(t, "/internal/confirmed-meetings", "person-nobody", "member")).json().code).toBe("MEETING_NOT_FOUND");
    } finally {
      await t.close();
    }
  });

  it("待决议题：CEO 视角全部，成员视角只看本人在议题群里的", async () => {
    const { t } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      const all = (await get(t, "/internal/pending-issues", CEO, "ceo")).json();
      expect(all.viewerRole).toBe("ceo");
      const mine = await t.createIssue({ title: "测试丙在群里的议题" });
      const mineId = mine.objectRef.id;
      await t.sql("INSERT INTO thread_members (object_type, object_id, person_id, added_by) VALUES ('issue', $1, $2, $3)", [mineId, OWNER, CEO]);

      const ceoView = (await get(t, "/internal/pending-issues", CEO, "ceo")).json();
      expect(ceoView.issues).toHaveLength(all.issues.length + 1);
      expect(ceoView.issues.find((issue: { issueId: string }) => issue.issueId === mineId)).toMatchObject({
        title: "测试丙在群里的议题", label: "待决", researchStatus: expect.any(String), location: { level: "battlefield", battlefieldId: "growth" },
        createdAt: expect.stringMatching(/Z$/), href: `/issues/${mineId}` });

      const ownerView = (await get(t, "/internal/pending-issues", OWNER, "member")).json();
      expect(ownerView).toMatchObject({ viewerRole: "member", issues: [{ issueId: mineId, href: `/me/issues/${mineId}` }] });
      expect(ownerView.issues).toHaveLength(1);
      // 离开议题群后就不列了。
      await t.sql("UPDATE thread_members SET left_at = now() WHERE object_type = 'issue' AND object_id = $1 AND person_id = $2", [mineId, OWNER]);
      expect((await get(t, "/internal/pending-issues", OWNER, "member")).json().issues).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("预约会议：本人在会里、没整卡确认的会，按阶段标；整卡确认后不再出现", async () => {
    ontology();
    const { t, host, meetingId } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      // 原会：逐字稿已导入、会议卡还没确认 → 待确认。
      await place(t, meetingId, -24 * HOUR, -23 * HOUR);
      const upcoming = await cloneScheduled(t, meetingId, 24 * HOUR, 25 * HOUR);
      const inProgress = await cloneScheduled(t, meetingId, -0.5 * HOUR, 0.5 * HOUR);
      const awaitingRecord = await cloneScheduled(t, meetingId, -48 * HOUR, -47 * HOUR);
      const stages = (body: { meetings: { meetingId: string; stage: string }[] }) => Object.fromEntries(body.meetings.map((m) => [m.meetingId, m.stage]));

      const ceoView = (await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json();
      expect(ceoView.viewerRole).toBe("ceo");
      expect(stages(ceoView)).toEqual({ [meetingId]: "awaiting_confirm", [upcoming]: "upcoming", [inProgress]: "in_progress", [awaitingRecord]: "awaiting_record" });
      expect(ceoView.meetings.find((m: { meetingId: string }) => m.meetingId === meetingId)).toMatchObject({
        title: "接口切换会", label: "预约", endedAt: null, host: { personId: HOST, name: expect.any(String) },
        participants: expect.arrayContaining([expect.objectContaining({ personId: OWNER })]), issueIds: [expect.any(String)], href: `/meetings/${meetingId}` });
      expect(ceoView.meetings.map((m: { startsAt: string }) => m.startsAt)).toEqual([...ceoView.meetings.map((m: { startsAt: string }) => m.startsAt)].sort());

      // 测试丙退出了「即将开」那场的会议群：成员视角不列，CEO 视角照列。
      await t.sql("UPDATE thread_members SET left_at = now() WHERE object_type = 'meeting' AND object_id = $1 AND person_id = $2", [upcoming, OWNER]);
      const ownerView = (await get(t, "/internal/scheduled-meetings", OWNER, "member")).json();
      expect(stages(ownerView)).toEqual({ [meetingId]: "awaiting_confirm", [inProgress]: "in_progress", [awaitingRecord]: "awaiting_record" });
      expect(ownerView.meetings[0].href).toMatch(/^\/me\/meetings\//);
      expect(stages((await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json())).toHaveProperty(upcoming);

      // 时间窗：只看明后天；不合法或超过 90 天 → 400。
      const tomorrow = new URLSearchParams({ from: new Date(Date.now() + 12 * HOUR).toISOString(), to: new Date(Date.now() + 36 * HOUR).toISOString() });
      expect(stages((await get(t, `/internal/scheduled-meetings?${tomorrow}`, CEO, "ceo")).json())).toEqual({ [upcoming]: "upcoming" });
      for (const query of ["from=yesterday", "from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z", "from=2026-06-01T00:00:00Z&to=2026-05-01T00:00:00Z"]) {
        const bad = await get(t, `/internal/scheduled-meetings?${query}`, CEO, "ceo");
        expect([bad.statusCode, bad.json().code]).toEqual([400, "INVALID_INPUT"]);
      }

      // 整卡确认后走确认会议接口，这里不再出现。
      const draftVersion = await ready(t, host, meetingId);
      expect((await confirm(t, host, meetingId, { draftVersion, writeToWorld: false })).statusCode).toBe(200);
      expect(stages((await get(t, "/internal/scheduled-meetings", CEO, "ceo")).json())).not.toHaveProperty(meetingId);
    } finally {
      await t.close();
    }
  });

  it("首页卡片：CEO 是公司首页的 Card，成员是我的工作台；都不带 Action", async () => {
    const { t } = await setup(undefined, { internalChatToken: TOKEN });
    try {
      const ceo = await get(t, "/internal/home-cards", CEO, "ceo");
      expect(ceo.json()).toMatchObject({ viewerRole: "ceo", scene: "公司首页" });
      const ceoCards = ceo.json().cards as Record<string, unknown>[];
      expect(ceoCards.map((card) => card.kind)).toContain("issue");
      for (const card of [...ceoCards]) {
        expect(Object.keys(card).sort()).toEqual(["cardId", "kind", "label", "objectRef", "payload", "title", "version"]);
        expect(card.label).toBe("页面");
      }
      expect(ceo.body).not.toContain("actionId");

      const member = await get(t, "/internal/home-cards", HOST, "member");
      expect(member.json()).toMatchObject({ viewerRole: "member", scene: "我的工作台" });
      for (const card of member.json().cards as { kind: string }[]) expect(["task", "mission-card", "battlefield"]).toContain(card.kind);
      expect(member.body).not.toContain("actionId");
    } finally {
      await t.close();
    }
  });

  it("Mission 计划：本人本月的 Mission 带本体计划块里的条目和日期，只读本体；没关联的 plan 为 null", async () => {
    const calls = missionWorld();
    const t = await planApp({ ...worldEnv, worldInstance: "demo" });
    try {
      await seedMissions(t);
      expect(await missionPlans(t, HOST, "member")).toEqual({ viewerRole: "member", period: MONTH, missions: [
        { missionId: "m-a", code: "rehearsal-a", title: "Mission rehearsal-a", planStatus: "ok", plan: {
          objectRef: "obj-mission-a@4", title: "冒烟 Mission", items: [
            { block: "mission_plan", componentId: "mp-ms1", type: "milestone", text: "2026年10月28日 正式上线", dates: ["2026-10-28"] },
            { block: "execution_plan", componentId: "pi-preview-teardown", type: "plan_item", text: "预发环境回收：10/27 前停服务、删卷和站点", dates: ["2026-10-27"] },
            { block: "execution_plan", componentId: "pi-notes", type: "plan_item", text: "整理 词元云集 的接入说明", dates: [] },
          ] } },
        { missionId: "m-b", code: "rehearsal-b", title: "Mission rehearsal-b", planStatus: "not_linked", plan: null },
      ] });
      // CEO 视角也只是本人的（CEO 名下没有 Mission）。
      expect(await missionPlans(t, CEO, "ceo")).toEqual({ viewerRole: "ceo", period: MONTH, missions: [] });
      // 只读：对本体只发 GET。
      expect(missionPlanCalls(calls).map((call) => call.url.searchParams.get("external_id"))).toEqual(["mission:rehearsal-a", "mission:rehearsal-b"]);
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("Mission 计划：本体没配、实例没开读时照样给本地 Mission，plan 为 null 并说原因，不读本体", async () => {
    const calls = missionWorld();
    for (const [env, planStatus] of [[{}, "world_not_configured"], [worldEnv, "world_reads_off"]] as const) {
      const t = await planApp(env);
      try {
        await seedMissions(t);
        expect(statuses(await missionPlans(t, HOST, "member"))).toEqual([
          { code: "rehearsal-a", planStatus, plan: null }, { code: "rehearsal-b", planStatus, plan: null }]);
      } finally {
        await t.close();
      }
    }
    expect(missionPlanCalls(calls)).toEqual([]);
  }, 20_000);

  it("Mission 计划：开了读但本体连不上，第一条读失败后剩下的不再读，不报 500", async () => {
    const calls = missionWorld({ unreachable: true });
    const t = await planApp({ ...worldEnv, worldInstance: "demo" });
    try {
      await seedMissions(t);
      expect(statuses(await missionPlans(t, HOST, "member"))).toEqual([
        { code: "rehearsal-a", planStatus: "world_unreachable", plan: null }, { code: "rehearsal-b", planStatus: "world_unreachable", plan: null }]);
      expect(missionPlanCalls(calls)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("Mission 计划读取：引用重复算 world_error 并接着读下一个；整次超过时限后剩下的不读；条目截字、限条数", async () => {
    const t = await planApp();
    try {
      await seedMissions(t);
      const q = t.pool.query.bind(t.pool);
      const plan = (body: { code: string; planStatus: string }[]) => body.map(({ code, planStatus }) => ({ code, planStatus }));
      const world = (heads: (code: string) => unknown[], object: unknown, delayMs = 0) => ({
        async listObjects(filters: { external_id?: string }) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return heads(filters.external_id!.replace("mission:", ""));
        },
        async getObject() { return projection(object); },
      }) as unknown as MissionPlanWorld;

      // 同一引用对应两个对象：这个 Mission 是 world_error，下一个照读。
      const duplicate = world((code) => code === "rehearsal-a" ? [missionObject, { ...missionObject, object_id: "obj-mission-a2" }] : [], missionObject);
      expect(plan(await readMissionPlans(q, HOST, MONTH, duplicate))).toEqual([
        { code: "rehearsal-a", planStatus: "world_error" }, { code: "rehearsal-b", planStatus: "not_linked" }]);

      // 整次时限 20 毫秒、每次列对象 50 毫秒：第一个读完，第二个不再读。
      const slow = world((code) => code === "rehearsal-a" ? [missionObject] : [], missionObject, 50);
      expect(plan(await readMissionPlans(q, HOST, MONTH, slow, 20))).toEqual([
        { code: "rehearsal-a", planStatus: "ok" }, { code: "rehearsal-b", planStatus: "world_unreachable" }]);

      // 里程碑在前、Task 全景在后，合计最多 50 条；每条文字最多 600 字。
      const many = { ...missionObject, blocks: [
        { id: "execution_plan", components: Array.from({ length: 30 }, (_, i) => ({ id: `pi-${i}`, type: "plan_item", text: i === 0 ? "长".repeat(700) : `条目 ${i}` })) },
        { id: "mission_plan", components: Array.from({ length: 30 }, (_, i) => ({ id: `mp-${i}`, type: "milestone", text: `里程碑 ${i}` })) },
      ] };
      const [read] = await readMissionPlans(q, HOST, MONTH, world((code) => code === "rehearsal-a" ? [many] : [], many));
      const items = read.plan!.items;
      expect(items).toHaveLength(50);
      expect(items.slice(0, 30).every((item) => item.block === "mission_plan")).toBe(true);
      expect(items.slice(30).map((item) => item.componentId)).toEqual(Array.from({ length: 20 }, (_, i) => `pi-${i}`));
      expect(items[30].text).toBe(`${"长".repeat(600)}…`);
    } finally {
      await t.close();
    }
  });

  it("计划条目的日期：全部按序、去重，跳过无效的接着找，没写年取离本月最近的年份", () => {
    expect(planItemDates("由 10/28 改到 10/27", "2026-10")).toEqual(["2026-10-28", "2026-10-27"]);
    expect(planItemDates("回收时间由10月28日前调整为10月27日前，10/27 停服务", "2026-10")).toEqual(["2026-10-28", "2026-10-27"]);
    expect(planItemDates("2026/10/27、2026-10-26、2026年10月25日", "2026-10")).toEqual(["2026-10-27", "2026-10-26", "2026-10-25"]);
    expect(planItemDates("1/5 前完成年度复盘", "2026-12")).toEqual(["2027-01-05"]);
    expect(planItemDates("12/28 已完成", "2027-01")).toEqual(["2026-12-28"]);
    expect(planItemDates("50/50 分工，10/27 前完成", "2026-10")).toEqual(["2026-10-27"]);
    expect(planItemDates("2/30 和 13/1 都不是日期，v2/3 是版本", "2026-10")).toEqual([]);
  });
});
