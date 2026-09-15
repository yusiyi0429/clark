import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, SessionResponse } from "@warmap/contracts";
import { TEST_PASSWORD, createTestApp } from "./helpers.js";

describe("CEO login → fixture card journey", () => {
  it("rejects wrong password and unauthenticated card access", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const bad = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: "wrong" },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toMatchObject({ code: "INVALID_CREDENTIALS", retryable: false });

      const anon = await app.inject({ method: "GET", url: "/api/cards/home" });
      expect(anon.statusCode).toBe(401);
      expect(anon.json()).toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await t.close();
    }
  });

  it("issues an HttpOnly Secure SameSite=Strict cookie and serves the fixture card", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: TEST_PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      expect(Value.Check(SessionResponse, login.json())).toBe(true);

      const setCookie = login.headers["set-cookie"] as string;
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");

      const cookie = setCookie.split(";")[0];
      const res = await app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Value.Check(Card, body.cards[0])).toBe(true);
      expect(body.cards[0].kind).toBe("home");
      expect(body.cards[0].version).toBe(1);
      expect(body.cards[0].actions).toHaveLength(1);
      expect(body.cards[0].actions[0].actionType).toBe("home.dismiss_notice");

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        headers: { cookie },
      });
      expect(session.json()).toEqual({ authenticated: true });
    } finally {
      await t.close();
    }
  });

  it("GET /api/cards/home performs no writes", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const cookie = await t.loginCookie();
      const first = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
      const row1 = await t.fixtureRow();
      const second = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
      const row2 = await t.fixtureRow();
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(row1).toEqual(row2);
    } finally {
      await t.close();
    }
  });

  it("logout clears the session", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const cookie = await t.loginCookie();
      const out = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { origin: t.publicOrigin, cookie },
      });
      expect(out.statusCode).toBe(200);
      const after = await app.inject({
        method: "GET",
        url: "/api/cards/home",
        headers: { cookie: out.headers["set-cookie"] as string },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("rejects writes without a same-origin header", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: "https://evil.example" },
        payload: { password: TEST_PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "ORIGIN_MISMATCH" });
    } finally {
      await t.close();
    }
  });

  it("rate limits login attempts per IP", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin: t.publicOrigin },
          payload: { password: "wrong" },
        });
        expect(r.statusCode).toBe(401);
      }
      const sixth = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin: t.publicOrigin },
        payload: { password: TEST_PASSWORD },
      });
      expect(sixth.statusCode).toBe(429);
    } finally {
      await t.close();
    }
  });

  it("service tokens are a separate boundary from the CEO session", async () => {
    const t = await createTestApp();
    const { app } = t;
    try {
      const noToken = await app.inject({ method: "POST", url: "/mcp/company-memory" });
      expect(noToken.statusCode).toBe(401);

      const wrongToken = await app.inject({
        method: "POST",
        url: "/mcp/company-memory",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` },
      });
      expect(wrongToken.statusCode).toBe(401);

      const mcp = await app.inject({
        method: "POST",
        url: "/mcp/company-memory",
        headers: { authorization: `Bearer ${t.env.mcpServiceToken}` },
      });
      expect(mcp.statusCode).toBe(501);

      // CEO cookie 不能访问服务边界
      const cookie = await t.loginCookie();
      const ceoAsService = await app.inject({
        method: "POST",
        url: "/api/dri/issues",
        headers: { cookie },
      });
      expect(ceoAsService.statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });
});
