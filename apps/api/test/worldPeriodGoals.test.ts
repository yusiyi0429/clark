import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldPeriodGoalService, periodGoalCommitAction, periodGoalConfirmAction } from "../src/worldPeriodGoals.js";
import type { WorldHead } from "../src/worldClient.js";
import { instance, projection, stubWorld, withWorld } from "./worldFixture.js";

afterEach(() => vi.unstubAllGlobals());

const ceo = () => "liu-minghua";
const goal = (overrides: Partial<WorldHead> = {}): WorldHead => ({
  object_id: "<period-goal-1>", object_type: "PeriodGoal", title: "E&O 10 月", revision_id: "<revision-15>",
  object_version: 2, version: 2, domain_id: "<domain:eo>", external_refs: [],
  lifecycle: { status: "committed", display_name: "已承诺", event_id: "<commit-1>" }, contract_version: "tkos.world/0.3", ...overrides,
});
/** 承诺事件的记录时刻：缺省早于签发（2026-10-08 13:22:05Z）。 */
const commitTimes = new Map<string, string>([["<commit-1>", "2026-10-05T02:00:00Z"]]);
afterEach(() => { commitTimes.clear(); commitTimes.set("<commit-1>", "2026-10-05T02:00:00Z"); });

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
    if (url.pathname.endsWith("/events")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2)!);
      const eventId = (goals.find((item) => item.object_id === id)?.lifecycle as { event_id?: string }).event_id!;
      return { object_id: id, since: null, events: commitTimes.has(eventId) ? [{ event_id: eventId, kind: "commit", recorded_at: commitTimes.get(eventId) }] : [] };
    }
    if (url.pathname.startsWith("/v1/world/objects/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return projection(goals.find((item) => item.object_id === id));
    }
    if (url.pathname.endsWith("/prepare")) return { expected_versions: [] };
    return onCommit(body);
  });
}
const actionsOf = (calls: { url: URL }[]) => calls.filter((call) => call.url.pathname === "/v1/actions");
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

  it("已签发计划补记：各单元已承诺的目标都代名单里的 CEO 确认，对不上战场 DRI 的草稿不碰；重跑不再写", async () => {
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
      const commits = actionsOf(calls);
      expect(commits.map((call) => call.body.target.object_id)).toEqual(["<period-goal-1>", "<period-goal-other>"]);
      expect(commits[0].body).toMatchObject({ contract_version: "tkos.world/0.3" });
      expect(commits[0].body.params.on_behalf_of).toEqual({
        principal_id: instance.people["liu-minghua"], external_record_id: `tianshu:plan-sign:${planId}`, external_confirmed_at: "2026-10-08T21:22:05+08:00",
      });
      expect((await pool.query("SELECT action_type, status FROM world_sync_ledger ORDER BY id")).rows)
        .toEqual([{ action_type: "world_confirm_period_goal", status: "committed" }, { action_type: "world_confirm_period_goal", status: "committed" }]);
      service.schedule();
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(2);
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

  it("委托没登记 403：台账如实记失败（管理员失败列表读它），同一目标版本不自动重试", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      const calls = worldHttp([goal()], forbidden);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect((await pool.query("SELECT action_type, status, error_code FROM world_sync_ledger")).rows)
        .toEqual([{ action_type: "world_confirm_period_goal", status: "failed", error_code: "FORBIDDEN" }]);
      service.schedule();
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(1);
      await service.close();
    });
  });

  it("委托没覆盖的域：那个单元的目标如实记失败，其他单元照常确认", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      const calls = worldHttp([goal(), goal({ object_id: "<period-goal-other>", domain_id: "<domain:agents>" })],
        (body) => body.target.object_id === "<period-goal-other>" ? forbidden() : { receipt_id: "<receipt-18>", status: "committed", result: { event_id: "<event-20>" } });
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(2);
      expect((await pool.query("SELECT target_ref, status, error_code FROM world_sync_ledger ORDER BY id")).rows).toEqual([
        { target_ref: "<period-goal-1>", status: "committed", error_code: null },
        { target_ref: "<period-goal-other>", status: "failed", error_code: "FORBIDDEN" },
      ]);
      await service.close();
    });
  });

  it("只代确认签发时那一版：签发之后才承诺（含退回后重新承诺）的不代确认", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      commitTimes.set("<commit-2>", "2026-10-09T01:00:00Z");
      const calls = worldHttp([goal({ revision_id: "<revision-16>", object_version: 3, lifecycle: { status: "committed", event_id: "<commit-2>" } })]);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toHaveLength(0);
      await service.close();
    });
  });

  it("版本对不上就停：prepare 报版本过期后不改确认新版本", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      const goals = [goal()];
      const calls = stubWorld(({ url }) => {
        if (url.pathname === "/v1/world/objects") return { items: [goal()], next_cursor: null };
        if (url.pathname.endsWith("/events")) return { events: [{ event_id: "<commit-1>", recorded_at: "2026-10-05T02:00:00Z" }] };
        if (url.pathname.startsWith("/v1/world/objects/")) return projection(goals[0]);
        // 第一次 prepare 时目标已被改成新版本。
        goals[0] = goal({ revision_id: "<revision-16>", object_version: 3 });
        return new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "stale" } }), { status: 409 });
      });
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(calls.filter((call) => call.url.pathname.startsWith("/v1/actions"))).toHaveLength(1);
      expect((await pool.query("SELECT status, error_code FROM world_sync_ledger")).rows).toEqual([{ status: "failed", error_code: "VERSION_CONFLICT" }]);
      await service.close();
    });
  });

  it("只代确认当月：只看最近一份已签发的计划", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool, "2026-10");
      await seedPlan(pool, "2026-11", "2026-11-03T02:00:00Z");
      const calls = worldHttp([goal()]);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(calls.filter((call) => call.url.pathname === "/v1/world/objects").map((call) => call.url.searchParams.get("period"))).toEqual(["2026-11"]);
      expect(actionsOf(calls)).toHaveLength(0);
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
      const commits = actionsOf(calls);
      expect(commits).toHaveLength(2);
      expect(commits[1].body).toEqual(commits[0].body);
      expect((await pool.query("SELECT status FROM world_sync_ledger ORDER BY id")).rows).toEqual([{ status: "network_error" }, { status: "committed" }]);
      await service.close();
    });
  });
});

describe("world 代 RU DRI 承诺周期目标（0.3）", () => {
  const draft = (overrides: Partial<WorldHead> = {}): WorldHead => goal({
    object_id: "<period-goal-2>", revision_id: "<revision-20>", object_version: 1, version: 1,
    lifecycle: { status: "draft", display_name: "草稿", event_id: "<create-2>" }, ...overrides,
  });
  /** 本体里挂天枢战场的责任单元（外部引用 battlefield:<id>）。 */
  const unit = (battlefieldId: string, domainId = "<domain:eo>") => ({
    object_id: `<unit:${battlefieldId}>`, object_type: "ResponsibilityUnit", title: "E&O", revision_id: "<revision-u>", object_version: 1, version: 1,
    domain_id: domainId, external_refs: [{ system: "tianshu", id: `battlefield:${battlefieldId}` }], lifecycle: null, contract_version: "tkos.world/0.3",
  });
  /** 签发（2026-10-08 13:22:05Z）之前建好、改过的草稿。 */
  const before = (): Record<string, Record<string, unknown>[]> => ({ "<period-goal-2>": [
    { event_id: "<create-2>", kind: "object.created", recorded_at: "2026-10-01T02:00:00Z" },
    { event_id: "<revise-2>", kind: "object.revised", recorded_at: "2026-10-05T02:00:00Z" },
  ] });
  const ownBattlefield = (pool: Pool, owner = "yu-siyi") => pool.query("UPDATE battlefield_config SET owner_id = $1 WHERE id = 'growth'", [owner]);

  /** 有状态的本体桩：代承诺写进去后目标变成已承诺（版本加一，承诺事件带外部记录），之后才轮到代确认。 */
  function draftWorld(goals: WorldHead[], units: unknown[], events: Record<string, Record<string, unknown>[]>, reject: (body: any) => Response | undefined = () => undefined) {
    return stubWorld(({ url, body }) => {
      if (url.pathname === "/v1/world/objects") {
        if (url.searchParams.get("type") === "ResponsibilityUnit") return { items: units, next_cursor: null };
        return { items: url.searchParams.get("period") === "2026-10" ? goals : [], next_cursor: null };
      }
      if (url.pathname.endsWith("/events")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-2)!);
        return { object_id: id, since: null, events: events[id] ?? [] };
      }
      if (url.pathname.startsWith("/v1/world/objects/")) return projection(goals.find((item) => item.object_id === decodeURIComponent(url.pathname.split("/").at(-1)!)));
      if (url.pathname.endsWith("/prepare")) return { expected_versions: [] };
      const rejected = reject(body);
      if (rejected) return rejected;
      const index = goals.findIndex((item) => item.object_id === body.target.object_id);
      const eventId = `<${body.action_type}-${index}>`;
      if (body.action_type === "world_commit_period_goal") {
        goals[index] = { ...goals[index], object_version: goals[index].object_version + 1, lifecycle: { status: "committed", display_name: "已承诺", event_id: eventId } };
        (events[body.target.object_id] ??= []).push({ event_id: eventId, kind: "commit", recorded_at: new Date().toISOString(),
          external_confirmation: { external_record_id: body.params.on_behalf_of.external_record_id, external_confirmed_at: body.params.on_behalf_of.external_confirmed_at } });
      }
      // 本体自己挑委托：按被代记的人给一条（这里用主体 id 区分）。
      return { receipt_id: `<receipt-${eventId}>`, status: "committed",
        result: { event_id: eventId, on_behalf_of: { ...body.params.on_behalf_of, delegation_event_id: `<delegation:${body.params.on_behalf_of.principal_id}>` } } };
    });
  }

  it("请求形状：按对象契约声明 0.3、不带候选与写入声明，on_behalf_of 带签发记录与原签发时刻 +08:00", () => {
    const key = "tianshu:plan-sign:plan-1:commit:<period-goal-2>:1";
    expect(periodGoalCommitAction(draft(), { id: "plan-1", period: "2026-10", confirmed_at: new Date("2026-10-03T13:38:15Z") }, "<principal:eo-dri>", key)).toEqual({
      action_type: "world_commit_period_goal", contract_version: "tkos.world/0.3",
      target: { object_id: "<period-goal-2>", revision_id: "<revision-20>", expected_version: 1 }, expected_versions: [],
      idempotency_key: key, reason: "天枢 2026-10 月度计划签发",
      params: { on_behalf_of: { principal_id: "<principal:eo-dri>", external_record_id: "tianshu:plan-sign:plan-1", external_confirmed_at: "2026-10-03T21:38:15+08:00" } },
    });
  });

  it("签发时那一版草稿：按挂天枢战场的责任单元取战场 DRI 代承诺，随后代 CEO 确认这条承诺；重跑不再写", async () => {
    await withWorld(async (client, { pool }) => {
      const planId = await seedPlan(pool);
      await ownBattlefield(pool);
      const calls = draftWorld([draft()], [unit("growth")], before());
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      const writes = actionsOf(calls);
      expect(writes.map((call) => call.body.action_type)).toEqual(["world_commit_period_goal", "world_confirm_period_goal"]);
      expect(writes[0].body.target).toEqual({ object_id: "<period-goal-2>", revision_id: "<revision-20>", expected_version: 1 });
      expect(writes[0].body.params).toEqual({
        on_behalf_of: { principal_id: instance.people["yu-siyi"], external_record_id: `tianshu:plan-sign:${planId}`, external_confirmed_at: "2026-10-08T21:22:05+08:00" },
      });
      expect(writes[1].body).toMatchObject({
        target: { object_id: "<period-goal-2>", expected_version: 2 },
        params: { outcome: "accepted", on_behalf_of: { principal_id: instance.people["liu-minghua"], external_record_id: `tianshu:plan-sign:${planId}` } },
      });
      // 回执里本体实际用的委托照存，开代记后读回核对。
      expect((await pool.query("SELECT action_type, status, delegation_event_id FROM world_sync_ledger ORDER BY id")).rows).toEqual([
        { action_type: "world_commit_period_goal", status: "committed", delegation_event_id: `<delegation:${instance.people["yu-siyi"]}>` },
        { action_type: "world_confirm_period_goal", status: "committed", delegation_event_id: `<delegation:${instance.people["liu-minghua"]}>` },
      ]);
      service.schedule();
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(2);
      await service.close();
    });
  });

  it("签发之后才改过、或签发之后被退回草稿的不代承诺，交 RU DRI 本人", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      await ownBattlefield(pool);
      const events = {
        "<period-goal-2>": [...before()["<period-goal-2>"], { event_id: "<revise-3>", kind: "object.revised", recorded_at: "2026-10-09T01:00:00Z" }],
        "<period-goal-3>": [
          { event_id: "<create-3>", kind: "object.created", recorded_at: "2026-10-01T02:00:00Z" },
          { event_id: "<returned-3>", kind: "confirm", outcome: "returned", recorded_at: "2026-10-09T01:00:00Z" },
        ],
      };
      const calls = draftWorld([draft(), draft({ object_id: "<period-goal-3>", lifecycle: { status: "draft", event_id: "<returned-3>" } })], [unit("growth")], events);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(0);
      await service.close();
    });
  });

  it("对不上唯一一位战场 DRI 就不代承诺：域里没有挂天枢战场的单元、战场 DRI 没有本体主体、同一域对上两位", async () => {
    const cases: { owner: string; units: unknown[] }[] = [
      { owner: "yu-siyi", units: [unit("growth", "<domain:agents>")] },
      { owner: "someone-else", units: [unit("growth")] },
      { owner: "yu-siyi", units: [unit("growth"), unit("other")] },
    ];
    for (const { owner, units } of cases) {
      await withWorld(async (client, { pool }) => {
        await seedPlan(pool);
        await ownBattlefield(pool, owner);
        await pool.query("INSERT INTO battlefield_config (id, version, name, six_month_outcome, owner_id) VALUES ('other', 1, '另一战场', '六个月目标', 'liu-renhao')");
        const calls = draftWorld([draft()], units, before());
        const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
        await service.idle();
        expect(actionsOf(calls)).toHaveLength(0);
        await service.close();
      });
    }
  });

  it("代承诺 403（委托没登记或没覆盖这个域）：台账如实记失败、不重试，也不代确认", async () => {
    await withWorld(async (client, { pool }) => {
      await seedPlan(pool);
      await ownBattlefield(pool);
      const calls = draftWorld([draft()], [unit("growth")], before(), forbidden);
      const service = createWorldPeriodGoalService(pool, client, ceo, 60_000);
      await service.idle();
      expect((await pool.query("SELECT action_type, status, error_code FROM world_sync_ledger")).rows)
        .toEqual([{ action_type: "world_commit_period_goal", status: "failed", error_code: "FORBIDDEN" }]);
      service.schedule();
      await service.idle();
      expect(actionsOf(calls)).toHaveLength(1);
      await service.close();
    });
  });
});
