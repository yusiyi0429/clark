import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectorHealthOf, probeCollectorHealth, workdayHours } from "../src/collector.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";

const device = { id: "dev-0001-abcdef", name: "工作机", platform: "windows" as const };
const sources = [
  { source: "codex", status: "ok" as const, coverageUntil: "2026-10-10T01:50:00.000Z", lastNewEvidenceAt: "2026-10-10T01:40:00.000Z", errorCode: null },
  { source: "claude", status: "not_found" as const, coverageUntil: null, lastNewEvidenceAt: null, errorCode: null },
];
const item = (clientEventId = randomUUID()) => ({
  clientEventId, source: "codex", startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T01:40:00.000Z",
  summary: "Tianshu-MVP：补齐采集器上报接口", links: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/1" }], taskHint: "Tianshu-MVP",
});
const report = (items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) => ({
  device, version: "0.1.0", kind: "digest", windowStart: "2026-10-10T00:00:00.000Z", windowEnd: "2026-10-10T01:50:00.000Z", sources, items, ...extra,
});

async function token(f: Fixture, cookie: string, client = "collector") {
  const created = await call(f, cookie, "POST", "/api/me/tokens", { name: "采集器", client, expiresInDays: 90 });
  expect(created.statusCode).toBe(200);
  return created.json() as { token: string; view: { id: string } };
}
/** 本人在天枢同意采集（上手流程的开关走这个接口）。 */
async function consent(f: Fixture, cookie: string, granted = true) {
  const response = await call(f, cookie, "PUT", "/api/me/collector/consent", { granted });
  expect(response.statusCode).toBe(200);
  return response.json().consent as { granted: boolean; updatedAt: string | null };
}
const post = (f: Fixture, url: string, bearer: string | null, payload: unknown) => f.t.app.inject({
  method: "POST", url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, payload: payload as Record<string, unknown>,
});

describe("本机采集器上报", () => {
  it("心跳与上报写本人名下；重放同一 clientEventId 只记一次", async () => {
    const f = await executionFixture();
    try {
      const { token: bearer } = await token(f, f.member);
      const beat = await post(f, "/api/collector/heartbeat", bearer, { device, version: "0.1.0", sources });
      expect(beat.statusCode).toBe(200);
      const health = await f.t.sql("SELECT person_id,source,source_status,last_success_at,coverage_until FROM collector_health ORDER BY source");
      expect(health.map((row) => [row.person_id, row.source, row.source_status])).toEqual([
        ["person-fixture-002", "claude", "not_found"], ["person-fixture-002", "codex", "ok"]]);
      expect(health[0].last_success_at).toBeNull();
      expect(health[1].last_success_at).not.toBeNull();

      const items = [item(), item()];
      // 没同意采集：工作段一律不收（本机留着下次再发），心跳照收。
      const refused = await post(f, "/api/collector/reports", bearer, report(items));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("COLLECTOR_CONSENT_REQUIRED");
      expect((await post(f, "/api/collector/reports", bearer, report([]))).statusCode).toBe(200);
      expect((await call(f, f.member, "GET", "/api/me/collector/consent")).json()).toEqual({ consent: { granted: false, updatedAt: null } });
      expect(await consent(f, f.member)).toMatchObject({ granted: true });
      const inventory = { scheduledTasks: [{ name: "TkosWorldCollector", schedule: "每 30 分钟", command: null }],
        feishuDocs: [{ url: "https://example.feishu.cn/docx/abc", title: null, readAt: "2026-10-10T01:00:00.000Z" }] };
      const first = await post(f, "/api/collector/reports", bearer, report(items, { inventory }));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ accepted: 2, duplicates: 0 });
      const replay = await post(f, "/api/collector/reports", bearer, report([...items, item()], { kind: "catchup" }));
      expect(replay.json()).toMatchObject({ accepted: 1, duplicates: 2 });
      expect((await f.t.sql("SELECT count(*) AS n FROM collector_items WHERE person_id='person-fixture-002'"))[0].n).toBe("3");
      expect((await f.t.sql("SELECT kind,item_key,read_at FROM local_inventory ORDER BY kind"))).toMatchObject([
        { kind: "feishu_doc", item_key: "https://example.feishu.cn/docx/abc" }, { kind: "scheduled_task", item_key: "TkosWorldCollector" }]);

      const bad = await post(f, "/api/collector/reports", bearer, report([{ ...item(), endedAt: "2026-10-09T00:00:00.000Z" }]));
      expect(bad.statusCode).toBe(400);
    } finally { await f.t.close(); }
  });

  it("鉴权：没有令牌、错令牌、非采集器令牌、撤销后都是 401；采集器令牌不能连 MCP", async () => {
    const f = await executionFixture();
    try {
      const body = { device, version: "0.1.0", sources };
      expect((await post(f, "/api/collector/heartbeat", null, body)).statusCode).toBe(401);
      expect((await post(f, "/api/collector/heartbeat", null, { garbage: true })).statusCode).toBe(401);
      expect((await post(f, "/api/collector/heartbeat", `tsm_${"0".repeat(32)}_${"a".repeat(43)}`, body)).statusCode).toBe(401);
      const codex = await token(f, f.member, "codex");
      expect((await post(f, "/api/collector/reports", codex.token, report([item()]))).statusCode).toBe(401);
      const collector = await token(f, f.member);
      const mcp = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${collector.token}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(mcp.statusCode).toBe(401);
      expect((await call(f, f.member, "DELETE", `/api/me/tokens/${collector.view.id}`)).statusCode).toBe(204);
      expect((await post(f, "/api/collector/heartbeat", collector.token, body)).statusCode).toBe(401);
      expect((await f.t.sql("SELECT count(*) AS n FROM collector_health"))[0].n).toBe("0");
    } finally { await f.t.close(); }
  });

  it("只能写本人：请求体里夹带的人被忽略，同一 clientEventId 在两个人名下互不影响", async () => {
    const f = await executionFixture();
    try {
      const member = await token(f, f.member), third = await token(f, f.third);
      await consent(f, f.member); await consent(f, f.third);
      const shared = item();
      const smuggled = { ...report([{ ...shared, personId: "person-fixture-003" } as never]), personId: "person-fixture-003" };
      expect((await post(f, "/api/collector/reports", member.token, smuggled)).json()).toMatchObject({ accepted: 1 });
      expect((await post(f, "/api/collector/reports", third.token, report([{ ...shared, summary: "丙的工作" }]))).json()).toMatchObject({ accepted: 1, duplicates: 0 });
      const rows = await f.t.sql("SELECT person_id,summary,token_id FROM collector_items ORDER BY person_id");
      expect(rows.map((row) => [row.person_id, row.summary, row.token_id])).toEqual([
        ["person-fixture-002", shared.summary, member.view.id], ["person-fixture-003", "丙的工作", third.view.id]]);
      expect((await f.t.sql("SELECT DISTINCT person_id FROM collector_health ORDER BY person_id")).map((row) => row.person_id))
        .toEqual(["person-fixture-002", "person-fixture-003"]);
    } finally { await f.t.close(); }
  });

  it("健康探测：工作日超过 26 小时记黄、超过 50 小时记红，周末不计", async () => {
    // 2026-10-09 是周五。周五 20:00 到周一 10:00（北京时间）只有 14 个工作日小时。
    expect(workdayHours(new Date("2026-10-09T12:00:00Z"), new Date("2026-10-12T02:00:00Z"))).toBe(14);
    expect(collectorHealthOf(26)).toBe("green");
    expect(collectorHealthOf(27)).toBe("yellow");
    expect(collectorHealthOf(51)).toBe("red");
    const f = await executionFixture();
    try {
      const { token: bearer } = await token(f, f.member);
      await post(f, "/api/collector/heartbeat", bearer, { device, version: "0.1.0", sources });
      const query = async (sql: string, params?: unknown[]) => ({ rows: await f.t.sql(sql, params) }) as never;
      const read = async () => (await f.t.sql("SELECT source,health FROM collector_health ORDER BY source")).map((row) => [row.source, row.health]);
      await probeCollectorHealth(query, new Date("2026-10-11T02:00:00Z"));
      expect(await read()).toEqual([["claude", "green"], ["codex", "green"]]);
      await f.t.sql("UPDATE collector_health SET last_success_at='2026-10-12T00:00:00Z'"); // 周一 08:00
      await probeCollectorHealth(query, new Date("2026-10-13T03:00:00Z"));
      expect(await read()).toEqual([["claude", "green"], ["codex", "yellow"]]);
      await probeCollectorHealth(query, new Date("2026-10-14T03:00:00Z"));
      expect(await read()).toEqual([["claude", "green"], ["codex", "red"]]);
      // 再次成功同步立即回到绿色。
      await post(f, "/api/collector/heartbeat", bearer, { device, version: "0.1.0", sources });
      expect(await read()).toEqual([["claude", "green"], ["codex", "green"]]);
    } finally { await f.t.close(); }
  });
});
