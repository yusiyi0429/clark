import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { LocalSyncBatchRequest } from "@warmap/contracts";

/**
 * 本机同步里可以为空的数字（契约 nullable.ts）：过和 app.ts 一样的 Fastify 校验（Ajv 开着类型转换）后，null、0 原样，"7" 转成 7。
 * 以前 anyOf [integer, null] 会把 null 转成 0，云端就显示「剩 0%」。
 */
const quota = (remainingPercent: unknown) => ({ id: "tokenhub:gw.example.com", name: "TokenHub", kind: "daily_spend", remainingPercent, amounts: [], windows: [],
  resetsAt: null, blockedUntil: null, updatedAt: "2026-11-07T13:00:00.000Z" });

describe("本机同步的可为空数字", () => {
  it("remainingPercent：null、0 原样进云端，\"7\" 转成 7", async () => {
    const app = Fastify({ logger: false });
    app.post("/sync", { schema: { body: LocalSyncBatchRequest } }, async (req) => ({ value: (req.body as { quota: { remainingPercent: unknown }[] }).quota[0]!.remainingPercent }));
    try {
      const report = async (remainingPercent: unknown) => {
        const res = await app.inject({ method: "POST", url: "/sync", payload: { deviceId: "11111111-1111-4111-8111-111111111111", runnerVersion: "0.3.0",
          slots: { max: 3, running: 0, queued: 0 }, items: [], quota: [quota(remainingPercent)] } });
        expect(res.statusCode, res.body).toBe(200);
        return res.json().value;
      };
      expect(await report(null)).toBeNull();
      expect(await report(0)).toBe(0);
      expect(await report("7")).toBe(7);
    } finally {
      await app.close();
    }
  });
});
