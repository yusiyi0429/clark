import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldPeriodGoalService, periodGoalConfirmAction } from "../src/worldPeriodGoals.js";
import type { WorldHead } from "../src/worldClient.js";
import { instance, projection, stubWorld, withWorld } from "./worldFixture.js";

afterEach(() => vi.unstubAllGlobals());

const ceo = () => "liu-minghua";
const goal = (overrides: Partial<WorldHead> = {}): WorldHead => ({
  object_id: "<period-goal-1>", object_type: "PeriodGoal", title: "E&O 10 月", revision_id: "<revision-15>",
  object_version: 2, version: 2, domain_id: "<domain:eo>", external_refs: [],
  lifecycle: { status: "committed", display_name: "已承诺" }, contract_version: "tkos.world/0.3", ...overrides,
});

async function seedPlan(pool: Pool, period = "2026-10", confirmedAt: string | null = "2026-10-08T13:22:05Z") {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO monthly_plans (id, version, period, status, company_outcome, battlefields, todos, negotiation, generation, confirmed_at)
     VALUES ($1, 2, $2, $3, '公司结果', '[]', '[]', '{}', '{}', $4)`,
    [id, period, confirmedAt ? "confirmed" : "negotiating", confirmedAt],
  );
  return id;
}

function worldHttp(goals: WorldHead[], onCommit: (body: any) => unknown = () => ({ receipt_id: "<receipt-18>", status: "committed", result: { event_id: "<event-20>" } })) {
  return stubWorld(({ url, body }) => {
    if (url.pathname === "/v1/world/objects") return { items: url.searchParams.get("period") === "2026-10" ? goals : [], next_cursor: null };
    if (url.pathname.startsWith("/v1/world/objects/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return projection(goals.find((item) => item.object_id === id));
    }
    if (url.pathname.endsWith("/prepare")) return { expected_versions: [] };
    return onCommit(body);
  });
}
const commitsOf = (calls: { url: URL }[]) => calls.filter((call) => call.url.pathname === "/v1/actions");
const forbidden = () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "No delegation in force lets this service principal record this family of actions in this domain on behalf of that person." } }), { status: 403 });

describe("world 代 CEO 确认周期目标（0.3）", () => {
  it("请求形状：按对象契约声明 0.3、outcome accepted、on_behalf_of 带签发记录与原签发时刻 +08:00、不带写入声明", () => {
    const action = periodGoalConfirmAction(goal(), { id: "plan-1", period: "2026-10", confirmed_at: new Date("2026-10-03T13:38:15Z") }, "<principal:ceo>", "tianshu:plan-sign:plan-1:<period-goal-1>:2");
    expect(action).toMatchObject({
      action_type: "world_confirm_period_goal", contract_version: "tkos.world/0.3",
      target: { object_id: "<period-goal-1>", revision_id: "<revision-15>", expected_version: 2 },
      params: { outcome: "accepted", on_behalf_of: { principal_id: "<principal:ceo>", external_record_id: "tianshu:plan-sign:plan-1", external_confirmed_at: "2026-10-03T21:38:15+08:00" } },
    });
    expect(action.params).not.toHaveProperty("declaration");
  });

  it("已签发计划补记：只确认 company / E&O 域里已承诺的目标，代名单里的 CEO；重跑不再写", async () => {
    await withWorld(async (client, { pool }) => {
      const planId = await seedPlan(pool);
      const goals = [
        goal(),
        goal({ object_id: "<period-goal-draft>", lifecycle: { status: "draft" } }),
        goal({ object_id: "<period-goal-other>", domain_id: "<domain:agents>" }),
      ];
      const calls = worldHttp(goals);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      const commits = commitsOf(calls);
      expect(commits).toHaveLength(1);
      expect(commits[0].body).toMatchObject({ contract_version: "tkos.world/0.3", target: { object_id: "<period-goal-1>" } });
      expect(commits[0].body.params.on_behalf_of).toEqual({
        principal_id: instance.people["liu-minghua"], external_record_id: `tianshu:plan-sign:${planId}`, external_confirmed_at: "2026-10-08T21:22:05+08:00",
      });
      expect((await pool.query("SELECT action_type, status FROM world_sync_ledger")).rows).toEqual([{ action_type: "world_confirm_period_goal", status: "committed" }]);
      service.schedule();
      await service.idle();
      expect(commitsOf(calls)).toHaveLength(1);
      await service.close();
    });
  });

  it("未签发的计划不确认", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool, "2026-10", null);
      const calls = worldHttp([goal()]);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toHaveLength(0);
      await service.close();
    });
  });

  it("名单里的 CEO 没有本体主体：不写", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      const calls = worldHttp([goal()]);
      const service = createWorldPeriodGoalService(pool, client, () => "someone-else", 60_000);
      await service.idle();
      expect(calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toHaveLength(0);
      await service.close();
    });
  });

  it("委托没登记 403：台账如实记失败（管理员失败列表读它），同一目标版本不自动重试；目标再次承诺（版本变了）才重试", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      const goals = [goal()];
      let forbid = true;
      const calls = worldHttp(goals, () => forbid ? forbidden() : { receipt_id: "<receipt-19>", status: "committed", result: { event_id: "<event-21>" } });
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect((await pool.query("SELECT status, error_code FROM world_sync_ledger")).rows).toEqual([{ status: "failed", error_code: "FORBIDDEN" }]);
      service.schedule();
      await service.idle();
      expect(commitsOf(calls)).toHaveLength(1);
      forbid = false;
      goals[0] = goal({ revision_id: "<revision-16>", object_version: 3 });
      service.schedule();
      await service.idle();
      const commits = commitsOf(calls);
      expect(commits).toHaveLength(2);
      expect(commits[1].body.target).toEqual({ object_id: "<period-goal-1>", revision_id: "<revision-16>", expected_version: 3 });
      expect((await pool.query("SELECT status FROM world_sync_ledger ORDER BY id")).rows).toEqual([{ status: "failed" }, { status: "committed" }]);
      await service.close();
    });
  });

  it("网络失败不算失败，下一轮按原幂等键重放同一请求", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      let fail = true;
      const calls = worldHttp([goal()], () => {
        if (fail) { fail = false; throw new Error("fetch failed"); }
        return { receipt_id: "<receipt-18>", status: "committed", result: { event_id: "<event-20>" } };
      });
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      service.schedule();
      await service.idle();
      const commits = commitsOf(calls);
      expect(commits).toHaveLength(2);
      expect(commits[1].body).toEqual(commits[0].body);
      expect((await pool.query("SELECT status FROM world_sync_ledger ORDER BY id")).rows).toEqual([{ status: "network_error" }, { status: "committed" }]);
      await service.close();
    });
  });
});
