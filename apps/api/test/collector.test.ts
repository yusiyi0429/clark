import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectorHealthOf, workdayHours } from "../src/collector.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";

const device = { id: "dev-0001-abcdef", name: "工作机", platform: "windows" as const };
const sources = [{ source: "codex", status: "ok" as const, coverageUntil: "2026-10-10T01:50:00.000Z", lastNewEvidenceAt: "2026-10-10T01:40:00.000Z", errorCode: null }];
const inventory = { scheduledTasks: [{ name: "周报汇总", schedule: "Daily", command: null }],
  feishuDocs: [{ url: "https://example.feishu.cn/docx/abc", title: null, readAt: "2026-10-10T01:00:00.000Z" }] };
const report = {
  device, version: "0.2.0", kind: "digest", windowStart: "2026-10-10T00:00:00.000Z", windowEnd: "2026-10-10T01:50:00.000Z", sources, inventory,
  items: [{ clientEventId: randomUUID(), source: "codex", startedAt: "2026-10-10T00:00:00.000Z", endedAt: "2026-10-10T01:40:00.000Z",
    summary: "Tianshu-MVP：补齐采集器上报接口", links: [], taskHint: "Tianshu-MVP" }],
};
const post = (f: Fixture, url: string, bearer: string | null, payload: unknown) => f.t.app.inject({
  method: "POST", url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, payload: payload as Record<string, unknown>,
});
const counts = async (f: Fixture) => (await f.t.sql(`SELECT (SELECT count(*)::int FROM collector_health) AS health, (SELECT count(*)::int FROM collector_items) AS items,
  (SELECT count(*)::int FROM local_inventory) AS inventory, (SELECT count(*)::int FROM collector_scans) AS scans`))[0];

describe("本机采集器已下线", () => {
  it("旧版采集器的心跳和上报一律 410：有没有令牌、请求体对不对都一样，什么都不记", async () => {
    const f = await executionFixture();
    try {
      await f.t.sql("INSERT INTO collector_consents (person_id, granted, updated_at) VALUES ('person-fixture-002', true, now())");
      const created = await call(f, f.member, "POST", "/api/me/tokens", { name: "采集器", client: "collector", expiresInDays: 90 });
      const bearer = created.json().token as string;
      for (const [url, body] of [["/api/collector/heartbeat", { device, version: "0.2.0", sources, inventory }], ["/api/collector/reports", report]] as const) {
        for (const [token, payload] of [[bearer, body], [null, body], [null, { garbage: true }], [`tsm_${"0".repeat(32)}_${"a".repeat(43)}`, body]] as const) {
          const response = await post(f, url, token, payload);
          expect(response.statusCode).toBe(410);
          expect(response.json()).toMatchObject({ code: "COLLECTOR_RETIRED", message: "本机采集器已停用，请在天枢 设置 › 卸载本机采集器 里复制命令卸载" });
        }
      }
      expect(await counts(f)).toEqual({ health: 0, items: 0, inventory: 0, scans: 0 });
    } finally { await f.t.close(); }
  });

  it("一行安装命令、采集器文件和同意开关的接口都没有了", async () => {
    const f = await executionFixture();
    try {
      for (const url of ["/api/collector/install.ps1", "/api/collector/install.sh", "/api/collector/files/tkos_collector.py"])
        expect((await f.t.app.inject({ method: "GET", url })).statusCode).toBe(404);
      expect((await call(f, f.member, "GET", "/api/me/collector/consent")).statusCode).toBe(404);
      expect((await call(f, f.member, "PUT", "/api/me/collector/consent", { granted: true })).statusCode).toBe(404);
    } finally { await f.t.close(); }
  });

  it("本人的采集器状态照旧可读：以前连上过的设备都在（设置页据此给卸载命令），别人看不到", async () => {
    const f = await executionFixture();
    try {
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json())
        .toEqual({ consent: false, devices: [], scannedAt: null, inventory: { scheduledTasks: 0, feishuDocs: 0, memoryFiles: 0 } });
      await f.t.sql(`INSERT INTO collector_health(person_id,device_id,source,device_name,platform,collector_version,first_seen_at,last_attempt_at,source_status)
        VALUES('person-fixture-002',$1,'codex',$2,$3,'0.2.0','2026-10-01T01:00:00Z','2026-10-28T01:00:00Z','ok')`, [device.id, device.name, device.platform]);
      expect((await call(f, f.member, "GET", "/api/me/collector/status")).json().devices)
        .toEqual([{ id: device.id, name: "工作机", platform: "windows", lastSeenAt: "2026-10-28T01:00:00.000Z" }]);
      expect((await call(f, f.third, "GET", "/api/me/collector/status")).json().devices).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("管理员视图沿用的工作日小时数：工作日超过 26 小时记黄、超过 50 小时记红，周末不计", () => {
    // 2026-10-09 是周五。周五 20:00 到周一 10:00（北京时间）只有 14 个工作日小时。
    expect(workdayHours(new Date("2026-10-09T12:00:00Z"), new Date("2026-10-12T02:00:00Z"))).toBe(14);
    expect(collectorHealthOf(26)).toBe("green");
    expect(collectorHealthOf(27)).toBe("yellow");
    expect(collectorHealthOf(51)).toBe("red");
  });
});
