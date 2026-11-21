import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";

/**
 * 可以为空的数字（契约 nullable.ts）：Fastify 的类型转换下 null 和 0 都原样保留，"7" 照旧转成 7。
 * 之前 anyOf [integer, null] 会把 null 转成 0（「剩 0%」），null 写前面又会把 0 转成 null。
 */
const quota = (remainingPercent: unknown) => ({ id: "claude", name: "Claude", kind: "subscription", remainingPercent, amounts: [], resetsAt: null, blockedUntil: null,
  updatedAt: "2026-11-06T01:59:00.000Z", windows: [] });

describe("可以为空的数字", { timeout: 60_000 }, () => {
  it("本机同步的 remainingPercent：null、0 原样存，\"7\" 转成 7；预算的 hours：null 原样存，0 不合规则回 400（以前悄悄变成 null），\"7\" 转成 7", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { device, token } = await f.local();
      const report = async (remainingPercent: unknown) => {
        const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${token}` },
          payload: { deviceId: device, runnerVersion: "0.3.0", slots: { max: 3, running: 0, queued: 0 }, items: [], quota: [quota(remainingPercent)] } });
        expect(res.statusCode, res.body).toBe(200);
        return (await f.t.sql("SELECT quota->0->'remainingPercent' AS value FROM local_devices WHERE id=$1", [device]))[0].value;
      };
      expect(await report(null)).toBeNull();
      expect(await report(0)).toBe(0);
      expect(await report("7")).toBe(7);

      const budget = (hours: unknown) => f.call("PUT", "/api/me/tasks/task-open/budget", { mode: "set", hours, weeklyPercent: 20, money: null });
      expect((await budget(null)).json().budget).toMatchObject({ hours: null, weeklyPercent: 20 });
      expect((await budget(0)).statusCode).toBe(400);
      expect((await budget("7")).json().budget).toMatchObject({ hours: 7, weeklyPercent: 20 });
    } finally { await f.close(); }
  });
});
