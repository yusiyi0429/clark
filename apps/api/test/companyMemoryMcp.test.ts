import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { createTestApp, testEnv } from "./helpers.js";

describe("CompanyMemory MCP 已退役", () => {
  it("旧端点不再存在，个人 MCP 与健康检查照常", async () => {
    const t = await createTestApp();
    try {
      const retired = await t.app.inject({ method: "POST", url: "/mcp/company-memory", headers: { authorization: "Bearer mcp-token-test" }, payload: {} });
      expect(retired.statusCode).toBe(404);
      const health = await t.app.inject({ url: "/api/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe("ok");
      expect(health.json().dependencies).toMatchObject({ peopleDirectory: true, companyConfigured: false });
      expect(health.json().dependencies).not.toHaveProperty("companyMemoryMcp");
      expect((await t.app.inject({ method: "POST", url: "/mcp/me", payload: {} })).statusCode).toBe(401);
    } finally { await t.close(); }
  });
});

describe("company-people.v1 seed 装载与诚实失败边界", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "warmap-seed-"));
  afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

  function writeSeed(name: string, content: string): string {
    const path = join(tempRoot, name);
    writeFileSync(path, content);
    return path;
  }


  /** 生产入口语义：buildApp 装载 seed，任何缺失/不合规都必须启动即抛错，不虚构人员或空目录。 */
  async function buildWithSeeds(opts: { people?: string }): Promise<Error> {
    const pool = new Pool({ connectionString: "postgres://localhost:5/no-test-connection" });
    try {
      await buildApp({
        pool,
        env: {
          ...testEnv,
          companyPeopleSeed: opts.people ?? testEnv.companyPeopleSeed,
        },
      });
    } finally {
      await pool.end();
    }
    throw new Error("不应到达：seed 不合规时 buildApp 必须抛错");
  }

  it("人员 seed 文件缺失 → 拒绝启动", async () => {
    await expect(buildWithSeeds({ people: join(tempRoot, "missing.json") })).rejects.toThrow(/人员 seed 不存在/);
  });

  it("schemaVersion 不符 / roles 为空 / personId 重复 → 拒绝启动", async () => {
    const wrongVersion = writeSeed(
      "wrong-version.json",
      JSON.stringify({ schemaVersion: "company-people.v2", people: [{ personId: "p1", displayName: "甲", roles: ["ceo"] }] }),
    );
    await expect(buildWithSeeds({ people: wrongVersion })).rejects.toThrow(/company-people\.v1/);

    const emptyRoles = writeSeed(
      "empty-roles.json",
      JSON.stringify({ schemaVersion: "company-people.v1", people: [{ personId: "p1", displayName: "甲", roles: [] }] }),
    );
    await expect(buildWithSeeds({ people: emptyRoles })).rejects.toThrow(/company-people\.v1/);

    const emptyId = writeSeed(
      "empty-id.json",
      JSON.stringify({ schemaVersion: "company-people.v1", people: [{ personId: "", displayName: "甲", roles: ["ceo"] }] }),
    );
    await expect(buildWithSeeds({ people: emptyId })).rejects.toThrow(/company-people\.v1/);

    const duplicate = writeSeed(
      "duplicate.json",
      JSON.stringify({
        schemaVersion: "company-people.v1",
        people: [
          { personId: "p1", displayName: "甲", roles: ["ceo"] },
          { personId: "p1", displayName: "乙", roles: ["dri"] },
        ],
      }),
    );
    await expect(buildWithSeeds({ people: duplicate })).rejects.toThrow(/重复 personId/);
  });
});
