import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true), readFileSync: vi.fn(() => "API_SERVER_URL=http://api.test:4001\nM2_SERVER_URL=http://m2.test:4334\nPI_API_KEY=private-test-key\n") }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("root environment configuration", () => {
  it("reads development proxy addresses without exposing server secrets", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVER_URL", undefined);
    vi.stubEnv("M2_SERVER_URL", undefined);
    vi.stubEnv("PI_API_KEY", undefined);
    const { default: config } = await import("../next.config");
    const routes = await config.rewrites!();
    expect(routes).toContainEqual({ source: "/api/:path*", destination: "http://api.test:4001/api/:path*" });
    expect(routes).toContainEqual({ source: "/m2/:path*", destination: "http://m2.test:4334/m2/:path*" });
    expect(process.env.PI_API_KEY).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  it("keeps process environment precedence and leaves production routing to Caddy", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVER_URL", "http://override.test:4002");
    const { default: config } = await import("../next.config");
    expect(await config.rewrites!()).toContainEqual({ source: "/api/:path*", destination: "http://override.test:4002/api/:path*" });
    vi.stubEnv("NODE_ENV", "production");
    expect(await config.rewrites!()).toEqual([]);
  });
});
