import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { SeenMarksResponse } from "@warmap/contracts";
import { createTestApp, TEST_MEMBER, type TestApp } from "./helpers.js";

async function keys(t: TestApp, cookie: string): Promise<string[]> {
  const response = await t.app.inject({ method: "GET", url: "/api/me/seen-marks", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  expect(Value.Check(SeenMarksResponse, response.json())).toBe(true);
  return response.json().keys;
}

describe("看过的更新与演示", () => {
  it("requires a session", async () => {
    const t = await createTestApp();
    try {
      for (const [method, url] of [
        ["GET", "/api/me/seen-marks"],
        ["POST", "/api/me/seen-marks/tour:execution-items"],
        ["DELETE", "/api/me/seen-marks/tour:execution-items"],
      ] as const) {
        expect((await t.app.inject({ method, url, headers: { origin: t.publicOrigin } })).statusCode).toBe(401);
      }
    } finally { await t.close(); }
  });

  it("marks idempotently, rejects unknown keys, clears, and keeps people apart", async () => {
    let current = new Date("2026-09-30T08:00:00.000Z");
    const t = await createTestApp({}, undefined, { monthlyNow: () => current });
    try {
      const member = await t.memberCookie();
      const ceo = await t.loginCookie();
      const post = (cookie: string, key: string) =>
        t.app.inject({ method: "POST", url: `/api/me/seen-marks/${key}`, headers: { cookie, origin: t.publicOrigin } });

      expect(await keys(t, member)).toEqual([]);

      const first = await post(member, "release:0.4.2");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ keys: ["release:0.4.2"] });
      current = new Date(current.getTime() + 60_000);
      expect((await post(member, "tour:execution-items")).json()).toEqual({ keys: ["release:0.4.2", "tour:execution-items"] });
      current = new Date(current.getTime() + 60_000);
      expect((await post(member, "release:0.4.2")).json()).toEqual({ keys: ["release:0.4.2", "tour:execution-items"] });
      expect(await t.sql("SELECT key, seen_at FROM person_seen_marks WHERE key = 'release:0.4.2'"))
        .toEqual([{ key: "release:0.4.2", seen_at: new Date("2026-09-30T08:00:00.000Z") }]);

      expect((await post(member, "tour:mission-card:owner-confirmation-v2")).statusCode).toBe(200);
      expect((await t.app.inject({ method: "DELETE", url: "/api/me/seen-marks/tour:mission-card:owner-confirmation-v2", headers: { cookie: member, origin: t.publicOrigin } })).statusCode).toBe(204);
      for (const bad of ["hack:x", "release:", "release:V1", "tour:other", "tour:mission-card:unknown", "tour:mission-card:owner-confirmation-v3"]) {
        const denied = await post(member, bad);
        expect(denied.statusCode).toBe(400);
        expect(denied.json().code).toBe("INVALID_INPUT");
      }
      expect((await t.app.inject({ method: "DELETE", url: "/api/me/seen-marks/hack:x", headers: { cookie: member, origin: t.publicOrigin } })).statusCode).toBe(400);

      expect(await keys(t, ceo)).toEqual([]);
      expect((await post(ceo, "release:0.4.2")).json()).toEqual({ keys: ["release:0.4.2"] });

      const cleared = await t.app.inject({ method: "DELETE", url: "/api/me/seen-marks/release:0.4.2", headers: { cookie: member, origin: t.publicOrigin } });
      expect(cleared.statusCode).toBe(204);
      expect(await keys(t, member)).toEqual(["tour:execution-items"]);
      expect(await keys(t, ceo)).toEqual(["release:0.4.2"]);
      expect(await t.sql("SELECT key FROM person_seen_marks WHERE person_id = $1", [TEST_MEMBER.personId])).toEqual([{ key: "tour:execution-items" }]);
    } finally { await t.close(); }
  });

  it("remembers the mission card tour per person, idempotently, and can reset it", async () => {
    const t = await createTestApp();
    try {
      const member = await t.memberCookie();
      const ceo = await t.loginCookie();
      const request = { method: "POST" as const, url: "/api/me/seen-marks/tour:mission-card", headers: { cookie: member, origin: t.publicOrigin } };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await t.app.inject(request);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ keys: ["tour:mission-card"] });
      }
      expect(await keys(t, member)).toEqual(["tour:mission-card"]);
      expect(await keys(t, ceo)).toEqual([]);
      const cleared = await t.app.inject({ method: "DELETE", url: request.url, headers: request.headers });
      expect(cleared.statusCode).toBe(204);
      expect(await keys(t, member)).toEqual([]);
    } finally { await t.close(); }
  });
});
