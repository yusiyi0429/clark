import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("retired CompanyMemory MCP", () => {
  it("does not expose the old endpoint, while personal MCP and API health remain available", async () => {
    const t = await createTestApp();
    try {
      const retired = await t.app.inject({ method: "POST", url: "/mcp/company-memory", headers: { authorization: "Bearer mcp-token-test" }, payload: {} });
      expect(retired.statusCode).toBe(404);
      const health = await t.app.inject({ url: "/api/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe("ok");
      expect(health.json().dependencies.companyConfigured).toBe(false);
      expect(health.json().dependencies).not.toHaveProperty("companyMemoryMcp");
      expect((await t.app.inject({ method: "POST", url: "/mcp/me", payload: {} })).statusCode).toBe(401);
    } finally { await t.close(); }
  });
});
