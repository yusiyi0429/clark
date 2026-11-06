import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raw, pair, api, startTestRunner, ORIGIN } from "./helpers.js";

describe("本机 API 的安全检查", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  beforeAll(async () => { t = await startTestRunner(); token = await pair(t.port); });
  afterAll(async () => { await t.cleanup(); });

  it("Host 不是 127.0.0.1/localhost 加本端口：421（防 DNS 重绑定）", async () => {
    expect((await raw(t.port, { path: "/v1/health", headers: { host: "evil.example", origin: ORIGIN } })).status).toBe(421);
    expect((await raw(t.port, { path: "/v1/health", headers: { host: "127.0.0.1:1", origin: ORIGIN } })).status).toBe(421);
    expect((await raw(t.port, { path: "/v1/health", headers: { host: `localhost:${t.port}`, origin: ORIGIN } })).status).toBe(200);
  });

  it("没有 Origin、Origin: null、别的来源：403，且不回跨域头", async () => {
    for (const headers of [{}, { origin: "null" }, { origin: "https://evil.example" }, { origin: "http://tk.tokenkingos.com" }] as Record<string, string>[]) {
      const r = await raw(t.port, { path: "/v1/status", headers: { ...headers, "x-tianshu-local-token": token } });
      expect(r.status).toBe(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("预检：白名单来源回本来源（不是通配），别的来源 403", async () => {
    const ok = await raw(t.port, { method: "OPTIONS", path: "/v1/sessions", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-tianshu-local-token" } });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(String(ok.headers["access-control-allow-headers"])).toContain("x-tianshu-local-token");
    const bad = await raw(t.port, { method: "OPTIONS", path: "/v1/sessions", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("口令：health 不要口令但会说口令无效；其余接口没口令或口令错 401", async () => {
    const h = await raw(t.port, { path: "/v1/health", headers: { origin: ORIGIN } });
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ app: "tianshu-local", protocol: 1, tokenValid: false });
    expect((await raw(t.port, { path: "/v1/health", headers: { origin: ORIGIN, "x-tianshu-local-token": token } })).body.tokenValid).toBe(true);
    expect((await raw(t.port, { path: "/v1/status", headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await raw(t.port, { path: "/v1/status", headers: { origin: ORIGIN, "x-tianshu-local-token": "0".repeat(64) } })).status).toBe(401);
    expect((await api(t.port, token, "GET", "/v1/status")).status).toBe(200);
  });

  it("口令放在地址里不算数", async () => {
    expect((await raw(t.port, { path: `/v1/status?token=${token}`, headers: { origin: ORIGIN } })).status).toBe(401);
  });

  it("只收 JSON：表单式 POST 带口令也 415，一个会话都开不出来", async () => {
    const r = await raw(t.port, { method: "POST", path: "/v1/sessions", headers: { origin: ORIGIN, "x-tianshu-local-token": token, "content-type": "application/x-www-form-urlencoded" }, body: "title=x" });
    expect(r.status).toBe(415);
    const text = await raw(t.port, { method: "POST", path: "/v1/sessions", headers: { origin: ORIGIN, "x-tianshu-local-token": token, "content-type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(415);
    expect((await api(t.port, token, "GET", "/v1/sessions")).body.sessions).toEqual([]);
  });

  it("配对口令只给一次；本机点拒绝就拿不到口令", async () => {
    const start = await raw(t.port, { method: "POST", path: "/v1/pairings", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
    expect(start.body.code).toMatch(/^\d{4}$/);
    let first: any;
    for (let i = 0; i < 50 && !first?.token; i++) {
      first = (await raw(t.port, { path: `/v1/pairings/${start.body.pairingId}`, headers: { origin: ORIGIN } })).body;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(first.token).toBeTruthy();
    const second = (await raw(t.port, { path: `/v1/pairings/${start.body.pairingId}`, headers: { origin: ORIGIN } })).body;
    expect(second).toEqual({ status: "approved" });

    const denying = await startTestRunner({ approvePairing: false });
    try {
      const s = await raw(denying.port, { method: "POST", path: "/v1/pairings", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" });
      let st: any;
      for (let i = 0; i < 50 && st?.status !== "denied"; i++) {
        st = (await raw(denying.port, { path: `/v1/pairings/${s.body.pairingId}`, headers: { origin: ORIGIN } })).body;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(st).toEqual({ status: "denied" });
    } finally {
      await denying.cleanup();
    }
  });

  it("取消配对后口令作废", async () => {
    const t2 = await pair(t.port);
    expect((await api(t.port, t2, "DELETE", "/v1/pairing")).status).toBe(200);
    expect((await api(t.port, t2, "GET", "/v1/status")).status).toBe(401);
  });

  it("网页不能改允许的来源，也不能直接写文件夹路径", async () => {
    const r = await api(t.port, token, "PATCH", "/v1/settings", { allowedOrigins: ["https://evil.example"] });
    expect(r.status).toBe(400);
    const f = await api(t.port, token, "POST", "/v1/folders", { path: "C:/" });
    expect(f.status).toBe(404);
  });

  it("内部回报接口：浏览器请求（带 Origin）和错密钥都拒", async () => {
    const id = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": "x", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});
