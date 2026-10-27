import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("本人个人资料", () => {
  it("旧账号默认空白，本人可保存、重读和清空，不修改其他人的资料", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const own = () => t.app.inject({ method: "GET", url: "/api/me/profile", headers: { cookie } });
      const save = (gender: unknown) => t.app.inject({ method: "PATCH", url: "/api/me/profile",
        headers: { cookie, origin: t.publicOrigin }, payload: { gender } });
      const before = await own();
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({ gender: null });
      expect((await save("  自行描述  ")).json()).toMatchObject({ gender: "自行描述" });
      expect((await own()).json()).toMatchObject({ gender: "自行描述" });
      const other = await t.app.inject({ method: "GET", url: "/api/me/profile", headers: { cookie: await t.loginCookie() } });
      expect(other.json()).toMatchObject({ gender: null });
      expect((await save("")).json()).toMatchObject({ gender: null });
      expect((await own()).json()).toMatchObject({ gender: null });
    } finally { await t.close(); }
  });

  it("仅登录本人可读写，校验长度，不能通过 personId 修改别人", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/me/profile" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "PATCH", url: "/api/me/profile", headers: { origin: t.publicOrigin }, payload: { gender: "女" } })).statusCode).toBe(401);
      const cookie = await t.memberCookie();
      const patch = (payload: unknown) => t.app.inject({ method: "PATCH", url: "/api/me/profile", headers: { cookie, origin: t.publicOrigin }, payload });
      expect((await patch({ gender: "x".repeat(41) })).statusCode).toBe(400);
      expect((await patch({ gender: {} })).statusCode).toBe(400);
      expect((await patch({})).statusCode).toBe(400);
      expect((await patch({ gender: "不愿透露", personId: "person-fixture-001" })).json()).toMatchObject({ gender: "不愿透露" });
      const ceo = await t.app.inject({ method: "GET", url: "/api/me/profile", headers: { cookie: await t.loginCookie() } });
      expect(ceo.json()).toMatchObject({ gender: null });
      expect((await patch({ gender: null })).json()).toMatchObject({ gender: null });
    } finally { await t.close(); }
  });
});
