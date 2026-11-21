import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;

describe("头像", () => {
  it("本人换上照片后别人也看得到；换图版本就变；删掉回到没有照片", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const other = await t.loginCookie();
      const me = (await t.app.inject({ method: "GET", url: "/api/me/profile", headers: { cookie } })).json().personId as string;
      const save = (image: string) => t.app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie, origin: t.publicOrigin }, payload: { image } });
      const versions = async (who = other) => (await t.app.inject({ method: "GET", url: "/api/people/avatars", headers: { cookie: who } })).json().avatars as Record<string, string>;
      const photo = () => t.app.inject({ method: "GET", url: `/api/people/${encodeURIComponent(me)}/avatar`, headers: { cookie: other } });

      expect(await versions()).toEqual({});
      expect((await photo()).statusCode).toBe(404);

      const saved = await save(dataUrl("image/jpeg", JPEG));
      expect(saved.statusCode).toBe(200);
      const first = saved.json().version as string;
      expect(await versions()).toEqual({ [me]: first });
      const served = await photo();
      expect(served.headers["content-type"]).toBe("image/jpeg");
      expect(served.headers["cache-control"]).toContain("immutable");
      expect(served.rawPayload.equals(JPEG)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = (await save(dataUrl("image/png", JPEG))).json().version as string;
      expect(second).not.toBe(first);
      expect((await photo()).headers["content-type"]).toBe("image/png");

      expect((await t.app.inject({ method: "DELETE", url: "/api/me/avatar", headers: { cookie, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect(await versions()).toEqual({});
      expect((await photo()).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  it("要登录；只收 JPEG、PNG、WebP，不能超过 512 KB", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/people/avatars" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "GET", url: "/api/people/someone/avatar" })).statusCode).toBe(401);
      const cookie = await t.memberCookie();
      const save = (image: string) => t.app.inject({ method: "PUT", url: "/api/me/avatar", headers: { cookie, origin: t.publicOrigin }, payload: { image } });
      expect((await save(dataUrl("image/svg+xml", Buffer.from("<svg/>")))).statusCode).toBe(400);
      expect((await save("not an image")).statusCode).toBe(400);
      expect((await save(dataUrl("image/jpeg", Buffer.alloc(512 * 1024 + 1)))).statusCode).toBe(413);
      expect((await t.app.inject({ method: "GET", url: "/api/people/avatars", headers: { cookie } })).json()).toEqual({ avatars: {} });
    } finally { await t.close(); }
  });
});
