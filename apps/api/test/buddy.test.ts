import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("本人的伙伴", () => {
  it("新人没有伙伴；本人保存后读回一致，会话里也带上；别人看不到", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const own = () => t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie } });
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/buddy",
        headers: { cookie, origin: t.publicOrigin }, payload });
      const before = await own();
      expect(before.statusCode).toBe(200);
      expect(before.json()).toBeNull();
      const saved = await save({ name: "  团团 ", form: "panda" });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ name: "团团", form: "panda" });
      expect((await own()).json()).toEqual({ name: "团团", form: "panda" });
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
      expect(session.json()).toMatchObject({ buddy: { name: "团团", form: "panda" } });
      expect((await save({ name: "蓝蓝", form: "alive" })).json()).toEqual({ name: "蓝蓝", form: "alive" });
      expect((await save({ name: "Miles", form: "miles" })).json()).toEqual({ name: "Miles", form: "miles" });
      expect((await own()).json()).toEqual({ name: "Miles", form: "miles" });
      const other = await t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie: await t.loginCookie() } });
      expect(other.json()).toBeNull();
    } finally { await t.close(); }
  });

  it("只有登录的本人能读写；名字按宽度算 1–12（汉字、大写字母算 2），外形要在清单里", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/me/buddy" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "PUT", url: "/api/me/buddy", headers: { origin: t.publicOrigin },
        payload: { name: "团团", form: "panda" } })).statusCode).toBe(401);
      const cookie = await t.memberCookie();
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/buddy",
        headers: { cookie, origin: t.publicOrigin }, payload });
      expect((await save({ name: "   ", form: "panda" })).statusCode).toBe(400);
      for (const tooWide of ["一二三四五六七", "abcdefghijklo", "WWWWWWW", "Annab 小明小", "一二三四五六a"]) {
        expect((await save({ name: tooWide, form: "panda" })).statusCode).toBe(400);
      }
      expect((await save({ name: "团团", form: "cat" })).statusCode).toBe(400);
      expect((await save({ name: "团团" })).statusCode).toBe(400);
      expect((await t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie } })).json()).toBeNull();
      for (const widest of ["一二三四五六", "abcdefghijkl", "WWWWWW", "Anna 小明小", " 一二三四五a "]) {
        expect((await save({ name: widest, form: "classic" })).json()).toEqual({ name: widest.trim(), form: "classic" });
      }
    } finally { await t.close(); }
  });
});
