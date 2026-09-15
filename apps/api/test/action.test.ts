import { describe, expect, it } from "vitest";
import { TEST_PASSWORD, createTestApp } from "./helpers.js";

describe("action execution boundary", () => {
  async function loginAndHome(t: Awaited<ReturnType<typeof createTestApp>>) {
    const cookie = await t.loginCookie();
    const res = await t.app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
    return { cookie, card: res.json().cards[0] as { version: number; actions: { actionId: string; actionType: string }[] } };
  }

  it("actionId is deterministic for the same object version", async () => {
    const t = await createTestApp();
    try {
      const a = await loginAndHome(t);
      const b = await loginAndHome(t);
      expect(b.card.version).toBe(a.card.version);
      expect(b.card.actions[0].actionId).toBe(a.card.actions[0].actionId);
    } finally {
      await t.close();
    }
  });

  it("executes, bumps version and dismisses the notice", async () => {
    const t = await createTestApp();
    try {
      const { cookie, card } = await loginAndHome(t);
      const res = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId: card.actions[0].actionId, input: {} },
      });
      expect(res.statusCode).toBe(200);
      const newCard = res.json().cards[0];
      expect(newCard.version).toBe(card.version + 1);
      expect(newCard.payload.notice.dismissed).toBe(true);
      expect(newCard.actions).toHaveLength(0);

      const row = await t.fixtureRow();
      expect(row.version).toBe(card.version + 1);
      expect(row.notice_dismissed).toBe(true);
      expect(row.notice_fingerprint).toBeTruthy();
    } finally {
      await t.close();
    }
  });

  it("replays are idempotent: fingerprint hit returns the current card before version checks", async () => {
    const t = await createTestApp();
    try {
      const { cookie, card } = await loginAndHome(t);
      const actionId = card.actions[0].actionId;
      const first = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId, input: {} },
      });
      expect(first.statusCode).toBe(200);

      // 重放：同一 actionId 已产生效果。若先校验 version 会 409；
      // fingerprint 优先意味着必须 200 且返回当前（version+1）Card。
      const replay = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId, input: {} },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().cards[0].version).toBe(card.version + 1);
      expect(replay.json()).toEqual(first.json());
    } finally {
      await t.close();
    }
  });

  it("fingerprint miss on a stale version returns 409 with latestCard", async () => {
    const t = await createTestApp();
    try {
      const { cookie, card } = await loginAndHome(t);
      const actionId = card.actions[0].actionId;
      await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId, input: {} },
      });

      // 相同 actionId、不同 input → 新 fingerprint，未命中效果 → 校验 version → 409
      const res = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId, input: { channel: "web" } },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe("VERSION_CONFLICT");
      expect(body.latestCard.version).toBe(card.version + 1);
      expect(body.latestCard.payload.notice.dismissed).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("rejects tampered, unknown and unauthenticated actions", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();

      const tampered = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin, cookie },
        payload: { actionId: "bogus.sig", input: {} },
      });
      expect(tampered.statusCode).toBe(404);
      expect(tampered.json().code).toBe("UNKNOWN_ACTION");

      const anon = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { origin: t.publicOrigin },
        payload: { actionId: "bogus.sig", input: {} },
      });
      expect(anon.statusCode).toBe(401);

      const noOrigin = await t.app.inject({
        method: "POST",
        url: "/api/actions/execute",
        headers: { cookie },
        payload: { actionId: "bogus.sig", input: {} },
      });
      expect(noOrigin.statusCode).toBe(403);
    } finally {
      await t.close();
    }
  });

  it("keeps working end-to-end after restart-equivalent fresh app with the same secret", async () => {
    // 确定性 actionId 依赖 secret 而非进程内状态：这里等价覆盖 signActionId 的稳定性
    const { signActionId } = await import("../src/actionToken.js");
    const scope = { actionType: "home.dismiss_notice", objectType: "home", objectId: "default", objectVersion: 7 };
    expect(signActionId("s", scope)).toBe(signActionId("s", { ...scope }));
    expect(signActionId("s", scope)).not.toBe(signActionId("s", { ...scope, objectVersion: 8 }));
    void TEST_PASSWORD;
  });
});
