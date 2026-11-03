import { describe, expect, it } from "vitest";
import { call, executionFixture } from "./executionFixture.js";

// 周五兜底提醒（周五 18:00 起本周没有外部 Agent 进展就提醒同步）10/31 关掉：进展只在本人明确要求时写，天枢不再催。
describe("周五兜底提醒已关", () => {
  it("周五 18:00 后本周没同步、也没连接，首页照样不带同步提醒", async () => {
    const f = await executionFixture();
    try {
      f.setNow(new Date("2026-10-09T10:00:00Z")); // 周五 18:00
      const home = await call(f, f.member, "GET", "/api/me/home");
      expect(home.statusCode).toBe(200);
      expect(home.json()).not.toHaveProperty("weeklySync");
    } finally { await f.t.close(); }
  });
});
