import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;

describe("通知栏背景", () => {
  it("没选过是雾蓝；选预设、上传图、换回预设再选回我的图，都跟着本人走；图只有本人拿得到", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const own = () => t.app.inject({ method: "GET", url: "/api/me/rail-background", headers: { cookie } });
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/rail-background", headers: { cookie, origin: t.publicOrigin }, payload });
      const image = (who = cookie) => t.app.inject({ method: "GET", url: "/api/me/rail-background/image", headers: { cookie: who } });
      expect((await own()).json()).toEqual({ choice: "mist", imageVersion: null });
      expect((await image()).statusCode).toBe(404);
      expect((await save({ choice: "custom" })).statusCode).toBe(400);
      expect((await save({ choice: "dusk" })).json()).toEqual({ choice: "dusk", imageVersion: null });

      const uploaded = await save({ choice: "custom", image: dataUrl("image/jpeg", JPEG) });
      expect(uploaded.statusCode).toBe(200);
      const version = uploaded.json().imageVersion as string;
      expect(uploaded.json()).toEqual({ choice: "custom", imageVersion: expect.any(String) });
      const served = await image();
      expect(served.statusCode).toBe(200);
      expect(served.headers["content-type"]).toBe("image/jpeg");
      expect(served.headers["cache-control"]).toContain("immutable");
      expect(served.rawPayload.equals(JPEG)).toBe(true);

      expect((await save({ choice: "pine" })).json()).toEqual({ choice: "pine", imageVersion: version });
      expect((await save({ choice: "custom" })).json()).toEqual({ choice: "custom", imageVersion: version });
      expect((await own()).json()).toEqual({ choice: "custom", imageVersion: version });

      const other = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: "/api/me/rail-background", headers: { cookie: other } })).json()).toEqual({ choice: "mist", imageVersion: null });
      expect((await image(other)).statusCode).toBe(404);
    } finally { await t.close(); }
  });

  it("只有登录的本人能读写；预设要在清单里，只收 JPEG、PNG、WebP，图不能超过 3 MB", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/me/rail-background" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "GET", url: "/api/me/rail-background/image" })).statusCode).toBe(401);
      const cookie = await t.memberCookie();
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/rail-background", headers: { cookie, origin: t.publicOrigin }, payload });
      expect((await save({ choice: "rainbow" })).statusCode).toBe(400);
      expect((await save({ choice: "dusk", image: dataUrl("image/jpeg", JPEG) })).statusCode).toBe(400);
      expect((await save({ choice: "custom", image: dataUrl("image/svg+xml", Buffer.from("<svg/>")) })).statusCode).toBe(400);
      expect((await save({ choice: "custom", image: "not an image" })).statusCode).toBe(400);
      const tooBig = await save({ choice: "custom", image: dataUrl("image/png", Buffer.alloc(3 * 1024 * 1024 + 1)) });
      expect(tooBig.statusCode).toBe(413);
      expect((await t.app.inject({ method: "GET", url: "/api/me/rail-background", headers: { cookie } })).json()).toEqual({ choice: "mist", imageVersion: null });
      expect((await save({ choice: "custom", image: dataUrl("image/webp", JPEG) })).json()).toMatchObject({ choice: "custom" });
    } finally { await t.close(); }
  });
});
