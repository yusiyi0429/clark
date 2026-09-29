import { describe, expect, it } from "vitest";
import { TEST_MEMBER, createTestApp } from "./helpers.js";

/** 演示入口只在时间机器里配置；正式环境没有 demoLoginId，接口不存在。 */
describe("demo entry", () => {
  it("is absent without demoLoginId", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/auth/demo" })).statusCode).toBe(404);
      const post = await t.app.inject({ method: "POST", url: "/api/auth/demo", headers: { origin: t.publicOrigin } });
      expect(post.statusCode).toBe(404);
      expect(post.headers["set-cookie"]).toBeUndefined();
    } finally { await t.close(); }
  });

  it("signs the configured demo account in without a passcode, same-origin only", async () => {
    const t = await createTestApp({ demoLoginId: TEST_MEMBER.loginId });
    try {
      const probe = await t.app.inject({ method: "GET", url: "/api/auth/demo" });
      expect(probe.statusCode).toBe(200);
      expect(probe.json().displayName).toEqual(expect.any(String));
      expect((await t.app.inject({ method: "POST", url: "/api/auth/demo", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
      const entered = await t.app.inject({ method: "POST", url: "/api/auth/demo", headers: { origin: t.publicOrigin } });
      expect(entered.statusCode).toBe(200);
      expect(entered.json()).toMatchObject({ authenticated: true, role: "member" });
      const cookie = String(entered.headers["set-cookie"]).split(";")[0];
      const session = (await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).json();
      expect(session).toMatchObject({ authenticated: true, personId: TEST_MEMBER.personId });
    } finally { await t.close(); }
  });
});
