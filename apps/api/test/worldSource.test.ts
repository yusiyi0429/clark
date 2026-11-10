import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import examples from "./fixtures/world-02.json" with { type: "json" };
import { createTestApp, TEST_CEO } from "./helpers.js";

// 网页出处卡（cite:world:<ref>）读的接口：要登录；按本人授权的域读，范围外和不存在的一样 404；只发 GET。
describe("GET /api/ontology/objects/:id", () => {
  it("returns the granted object for the signed-in person and 404s for people without a grant", async () => {
    const object = structuredClone(examples["1"][2]) as any;
    object.object_id = "mission-1";
    Object.assign(object.business, { object_id: "mission-1", object_type: "Mission", title: "灯塔交付", relations: [] });
    const methods: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://world.test");
      methods.push(`${req.method} ${url.pathname}`);
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/v1/world/objects") res.end(JSON.stringify({ items: [{ ...object.business, domain_id: "<domain:eo>", lifecycle: object.records.lifecycle }], next_cursor: null }));
      else if (url.pathname === "/v1/world/objects/mission-1") res.end(JSON.stringify(object));
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = await mkdtemp(join(tmpdir(), "world-source-"));
    const grants = join(dir, "access.json");
    await writeFile(grants, JSON.stringify({ [TEST_CEO.personId]: ["<domain:eo>"] }));
    const t = await createTestApp({ worldApiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, worldAgentToken: "test-token", companyWorldAccessFile: grants });
    try {
      const get = async (id: string, cookie?: string) => t.app.inject({ method: "GET", url: `/api/ontology/objects/${encodeURIComponent(id)}`, ...(cookie ? { headers: { cookie } } : {}) });
      expect((await get("mission-1")).statusCode).toBe(401);
      const ok = await get("mission-1", await t.loginCookie());
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ref: "mission-1@2", objectId: "mission-1", version: 2, type: "Mission", title: "灯塔交付", status: "草稿" });
      const missing = await get("mission-2", await t.loginCookie());
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "WORLD_OBJECT_NOT_FOUND" });
      const member = await get("mission-1", await t.memberCookie());
      expect(member.statusCode).toBe(404);
      expect(methods.every((line) => line.startsWith("GET ") && !line.endsWith("/context"))).toBe(true);
    } finally {
      await t.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
