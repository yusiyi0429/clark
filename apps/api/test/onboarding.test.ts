import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { OnboardingResponse, type TOnboardingResponse } from "@warmap/contracts";
import type { VoiceprintDeps } from "../src/voiceprints.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

const NOW = "2026-09-30T16:30:00.000Z"; // 公司时间已进入 10 月，UTC 仍为 9 月。
const clock = () => new Date(NOW);
const fakeVoiceprints: VoiceprintDeps = {
  configured: () => true,
  requireConfig: () => ({ groupId: "test" }),
  async toPcm() { throw new Error("onboarding must not record"); },
  async enroll() { throw new Error("onboarding must not enroll"); },
  async update() { throw new Error("onboarding must not update voiceprints"); },
  async remove() { throw new Error("onboarding must not delete voiceprints"); },
  async groupVerify() { throw new Error("onboarding must not contact the provider"); },
};

async function read(t: TestApp, cookie: string): Promise<TOnboardingResponse> {
  const response = await t.app.inject({ method: "GET", url: "/api/me/onboarding", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(Value.Check(OnboardingResponse, body)).toBe(true);
  return body;
}

async function plan(t: TestApp, status: "draft" | "negotiating" | "confirmed", period = "2026-10") {
  await t.sql(
    `INSERT INTO monthly_plans (id, version, period, status, company_outcome, battlefields, todos, negotiation, generation)
     VALUES ($1, 1, $2, $3, '公司未公开目标', $4::jsonb, '[]', '{}', '{}')
     ON CONFLICT (period) DO UPDATE SET status = EXCLUDED.status, battlefields = EXCLUDED.battlefields`,
    [randomUUID(), period, status, JSON.stringify([
      { battlefieldId: "growth", outcome: "增长本月已签发目标" },
      { battlefieldId: "owned", outcome: "我负责的战场本月目标" },
      { battlefieldId: "private", outcome: "其他战场的目标" },
    ])],
  );
}

async function mission(t: TestApp, id: string, ownerId: string, period: string, battlefieldIds: string[]) {
  await t.sql(
    `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome,
      source_ref, source_document_id, source_revision, source_title)
     VALUES ($1, 1, $1, $2, $3, $4, 'test-capability', $5::jsonb, '不投影的正文', 'test-source', 'test-doc', 1, '测试资料')`,
    [id, period, `${id} 标题`, ownerId, JSON.stringify(battlefieldIds)],
  );
}

async function issue(t: TestApp, status = "pending", level = "red") {
  await t.sql(
    `INSERT INTO issues (id, version, origin, origin_ref, title, location, urgency, status, research)
     VALUES ($1, 1, 'dri', '{}', '测试议题', '{"level":"company"}', $2::jsonb, $3, '{}')`,
    [randomUUID(), JSON.stringify({ level }), status],
  );
}

async function meeting(t: TestApp, scheduledAt: string, status = "scheduled") {
  await t.sql(
    `INSERT INTO meetings (id, version, title, status, scheduled_at, ends_at, lead_dri_id, ceo_participant_id,
      participants, issue_ids, preflight, draft, origin_ref)
     VALUES ($1, 1, '测试会议', $2, $3::timestamptz, $3::timestamptz + interval '1 hour', $4, $5, '[]', '[]', '{}', '{}', '{}')`,
    [randomUUID(), status, scheduledAt, TEST_MEMBER.personId, TEST_CEO.personId],
  );
}

describe("首次登录引导", () => {
  it("requires a session and same-site Origin, and completes only the signed-in person", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      for (const [method, url] of [["GET", "/api/me/onboarding"], ["POST", "/api/me/onboarding/complete"]] as const) {
        expect((await t.app.inject({ method, url, headers: { origin: t.publicOrigin } })).statusCode).toBe(401);
      }
      const cookie = await t.memberCookie();
      for (const origin of [undefined, "https://evil.example"]) {
        const denied = await t.app.inject({ method: "POST", url: "/api/me/onboarding/complete", headers: { cookie, ...(origin ? { origin } : {}) } });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().code).toBe("ORIGIN_MISMATCH");
      }
      expect(await t.sql("SELECT * FROM person_onboarding")).toEqual([]);
      const result = await t.app.inject({
        method: "POST", url: "/api/me/onboarding/complete?personId=person-fixture-001",
        headers: { cookie, origin: t.publicOrigin }, payload: { personId: TEST_CEO.personId },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ onboarded: true });
      const rows = await t.sql("SELECT person_id, completed_at FROM person_onboarding");
      expect(rows).toEqual([{ person_id: TEST_MEMBER.personId, completed_at: new Date(NOW) }]);
    } finally { await t.close(); }
  });

  it("keeps completion idempotent across sessions and returns both states in login, session and passcode responses", async () => {
    let currentTime = new Date(NOW);
    const t = await createTestApp({}, undefined, { monthlyNow: () => currentTime });
    try {
      const login = () => t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: TEST_MEMBER.loginId, passcode: TEST_MEMBER.passcode } });
      const initial = await login();
      expect(initial.json().onboarded).toBe(false);
      const cookie = String(initial.headers["set-cookie"]).split(";")[0];
      const session = (sessionCookie: string) => t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: sessionCookie } });
      expect((await session(cookie)).json().onboarded).toBe(false);
      for (let count = 0; count < 2; count++) {
        const completed = await t.app.inject({ method: "POST", url: "/api/me/onboarding/complete", headers: { cookie, origin: t.publicOrigin } });
        expect(completed.json()).toEqual({ onboarded: true });
        currentTime = new Date(currentTime.getTime() + 60_000);
      }
      expect(await t.sql("SELECT person_id, completed_at FROM person_onboarding")).toEqual([{ person_id: TEST_MEMBER.personId, completed_at: new Date(NOW) }]);
      expect((await session(cookie)).json().onboarded).toBe(true);
      expect((await t.app.inject({ method: "DELETE", url: "/api/me/onboarding/complete", headers: { cookie, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect((await session(cookie)).json().onboarded).toBe(false);
      expect(await t.sql("SELECT person_id FROM person_onboarding WHERE person_id = $1", [TEST_MEMBER.personId])).toEqual([]);
      expect((await t.app.inject({ method: "DELETE", url: "/api/me/onboarding/complete", headers: { cookie, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect((await t.app.inject({ method: "DELETE", url: "/api/me/onboarding/complete", headers: { cookie } })).statusCode).toBe(403);
      await t.app.inject({ method: "POST", url: "/api/me/onboarding/complete", headers: { cookie, origin: t.publicOrigin } });
      const anotherLogin = await login();
      expect(anotherLogin.json().onboarded).toBe(true);
      expect((await session(String(anotherLogin.headers["set-cookie"]).split(";")[0])).json().onboarded).toBe(true);
      const changed = await t.app.inject({ method: "POST", url: "/api/auth/passcode", headers: { origin: t.publicOrigin }, payload: { loginId: TEST_MEMBER.loginId, passcode: TEST_MEMBER.passcode, newPasscode: "7391" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().onboarded).toBe(true);
      expect((await session(await t.loginCookie())).json().onboarded).toBe(false);
    } finally { await t.close(); }
  });

  it("reads the registered CEO snapshot and existing voiceprint without leaking provider metadata", async () => {
    const t = await createTestApp({ companyName: " 测试公司 " }, undefined, { monthlyNow: clock, voiceprintDeps: fakeVoiceprints });
    try {
      await t.sql("UPDATE company_strategy_config SET ltco = '公司的六个月目标'");
      await t.sql("UPDATE battlefield_config SET code = '01', owner_id = $1 WHERE id = 'growth'", [TEST_MEMBER.personId]);
      await t.sql("INSERT INTO capability_config (id, version, code, name, six_month_outcome) VALUES ('product', 1, '02', '产品能力', '能力目标')");
      await t.sql("INSERT INTO person_voiceprints (person_id, provider_voiceprint_id, group_id, consented_at, updated_at) VALUES ($1, 'private-provider-id', 'private-group-id', $2, $2)", [TEST_CEO.personId, NOW]);
      const data = await read(t, await t.loginCookie());
      expect(data).toMatchObject({
        role: "ceo", displayName: "测试甲", companyName: "测试公司",
        voiceprint: { configured: true, enrolled: true, updatedAt: NOW },
        company: {
          sixMonthGoal: "公司的六个月目标",
          battlefields: [{ id: "growth", code: "01", name: "增长战场", ownerName: "测试乙" }],
          capabilities: [{ id: "product", code: "02", name: "产品能力" }],
          people: [{ personId: TEST_CEO.personId, displayName: "测试甲" }, { personId: TEST_MEMBER.personId, displayName: "测试乙" }],
        },
      });
      expect(data).not.toHaveProperty("work");
      expect(JSON.stringify(data)).not.toContain("private-");
      expect((await read(t, await t.memberCookie())).voiceprint).toEqual({ configured: true, enrolled: false, updatedAt: null });
    } finally { await t.close(); }
  });

  it("委托授权这一步默认隐藏，配置打开后两种角色都显示", async () => {
    const hidden = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      expect((await read(hidden, await hidden.loginCookie())).delegationStep).toBe(false);
      expect((await read(hidden, await hidden.memberCookie())).delegationStep).toBe(false);
    } finally { await hidden.close(); }
    const shown = await createTestApp({ onboardingDelegationStep: true }, undefined, { monthlyNow: clock });
    try {
      expect((await read(shown, await shown.loginCookie())).delegationStep).toBe(true);
      expect((await read(shown, await shown.memberCookie())).delegationStep).toBe(true);
    } finally { await shown.close(); }
  });

  it("returns honest empty data for both roles and does not recommend a missing plan", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      await t.sql("DELETE FROM battlefield_config");
      await t.sql("DELETE FROM company_strategy_config");
      const ceo = await read(t, await t.loginCookie());
      expect(ceo).toMatchObject({
        companyName: null, voiceprint: { configured: false, enrolled: false, updatedAt: null },
        company: { sixMonthGoal: "", battlefields: [], capabilities: [] },
        next: { text: "首页上暂时没有要你马上处理的事", action: "进入工作台", href: "/" },
      });
      const member = await read(t, await t.memberCookie());
      expect(member).toMatchObject({
        work: { period: "2026-10", planStatus: "none", battlefields: [], missions: [] },
        next: { text: "需要你留意的事情，会出现在通知栏", action: "进入工作台", href: "/me" },
      });
      expect(member).not.toHaveProperty("company");
    } finally { await t.close(); }
  });

  it("limits member work to current-month ownership and withholds target text before signing", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      await t.sql("INSERT INTO battlefield_config (id, version, name, owner_id, six_month_outcome) VALUES ('owned', 1, '本人负责战场', $1, '长期目标'), ('private', 1, '其他战场', $2, '私有目标'), ('unplanned', 1, '未列入计划战场', $1, '长期目标')", [TEST_MEMBER.personId, TEST_CEO.personId]);
      await mission(t, "mine-october", TEST_MEMBER.personId, "2026-10", ["growth"]);
      await mission(t, "mine-september", TEST_MEMBER.personId, "2026-09", ["private"]);
      await mission(t, "others-october", TEST_CEO.personId, "2026-10", ["private"]);
      const cookie = await t.memberCookie();
      for (const status of ["none", "draft", "negotiating", "confirmed"] as const) {
        if (status !== "none") await plan(t, status);
        const data = await read(t, cookie);
        if (data.role !== "member") throw new Error("member projection expected");
        expect(data.work.period).toBe("2026-10");
        expect(data.work.planStatus).toBe(status);
        expect(data.work.missions).toEqual([{ id: "mine-october", code: "mine-october", title: "mine-october 标题", battlefieldIds: ["growth"] }]);
        expect(data.work.battlefields).toEqual([
          { id: "growth", name: "增长战场", monthTarget: status === "confirmed" ? "增长本月已签发目标" : null },
          { id: "owned", name: "本人负责战场", monthTarget: status === "confirmed" ? "我负责的战场本月目标" : null },
          { id: "unplanned", name: "未列入计划战场", monthTarget: null },
        ]);
        expect(JSON.stringify(data)).not.toContain("公司未公开目标");
        expect(JSON.stringify(data)).not.toContain("其他战场");
        expect(data).not.toHaveProperty("company");
      }
    } finally { await t.close(); }
  });

  it("prioritizes current unsigned targets, then pending red issues, then today's scheduled meetings", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      const cookie = await t.loginCookie();
      await plan(t, "draft", "2026-09");
      await issue(t);
      await issue(t);
      await issue(t, "decided");
      await issue(t, "dismissed");
      await issue(t, "pending", "yellow");
      await meeting(t, "2026-09-30T16:15:00Z");
      await meeting(t, "2026-10-01T15:59:59Z");
      await meeting(t, "2026-09-30T15:59:59Z");
      await meeting(t, "2026-10-01T16:00:00Z");
      await meeting(t, "2026-10-01T08:00:00Z", "cancelled");
      await meeting(t, "2026-10-01T08:00:00Z", "held");
      expect((await read(t, cookie)).next).toEqual({ text: "有 2 个红色议题等你判断", action: "去看看", href: "/" });
      for (const status of ["draft", "negotiating"] as const) {
        await plan(t, status);
        expect((await read(t, cookie)).next).toEqual({ text: "10 月的目标等你核对和签发", action: "进入工作台", href: "/" });
      }
      await plan(t, "confirmed");
      expect((await read(t, cookie)).next.text).toBe("有 2 个红色议题等你判断");
      await t.sql("UPDATE issues SET status = 'dismissed' WHERE status = 'pending' AND urgency->>'level' = 'red'");
      expect((await read(t, cookie)).next).toEqual({ text: "今天有 2 场会", action: "进入工作台", href: "/" });
      await t.sql("UPDATE meetings SET status = 'cancelled'");
      expect((await read(t, cookie)).next.text).toBe("首页上暂时没有要你马上处理的事");
    } finally { await t.close(); }
  });

  it("counts only the member's unfinished execution items for the next action", async () => {
    const t = await createTestApp({}, undefined, { monthlyNow: clock });
    try {
      for (const [owner, status] of [[TEST_MEMBER.personId, "not_started"], [TEST_MEMBER.personId, "in_progress"], [TEST_MEMBER.personId, "done"], [TEST_MEMBER.personId, "returned"], [TEST_CEO.personId, "not_started"]]) {
        await t.sql("INSERT INTO tasks (id, title, status, owner_id, created_by) VALUES ($1, '执行事项', $2, $3, 'meeting')", [randomUUID(), status, owner]);
      }
      const cookie = await t.memberCookie();
      expect((await read(t, cookie)).next).toEqual({ text: "你有 2 件执行事项在推进", action: "看看我的执行事项", href: "/me" });
      await t.sql("UPDATE tasks SET status = 'done' WHERE owner_id = $1", [TEST_MEMBER.personId]);
      expect((await read(t, cookie)).next).toEqual({ text: "需要你留意的事情，会出现在通知栏", action: "进入工作台", href: "/me" });
    } finally { await t.close(); }
  });
});
