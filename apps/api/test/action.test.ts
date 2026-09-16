import { describe, expect, it } from "vitest";
import { signActionId } from "../src/actionToken.js";
import { createTestApp } from "./helpers.js";

describe("action execution boundary", () => {
  async function issueWithDismiss(t: Awaited<ReturnType<typeof createTestApp>>) {
    const cookie = await t.loginCookie();
    const issue = await t.createIssue();
    const res = await t.app.inject({ method: "GET", url: `/api/cards/issues/${issue.objectRef.id}`, headers: { cookie } });
    const card = res.json().cards[0] as { version: number; actions: { actionId: string; actionType: string }[] };
    const action = card.actions.find((candidate) => candidate.actionType === "issue.dismiss")!;
    return { cookie, card, action, issueId: issue.objectRef.id };
  }

  function execute(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, actionId: string, input: unknown) {
    return t.app.inject({
      method: "POST",
      url: "/api/actions/execute",
      headers: { origin: t.publicOrigin, cookie },
      payload: { actionId, input },
    });
  }

  it("actionId is deterministic for the same object version", async () => {
    const t = await createTestApp();
    try {
      const first = await issueWithDismiss(t);
      const second = await t.app.inject({ method: "GET", url: `/api/cards/issues/${first.issueId}`, headers: { cookie: first.cookie } });
      const again = second.json().cards[0].actions.find((candidate: { actionType: string }) => candidate.actionType === "issue.dismiss");
      expect(again.actionId).toBe(first.action.actionId);
    } finally {
      await t.close();
    }
  });

  it("replays are idempotent: fingerprint hit returns the current card before version checks", async () => {
    const t = await createTestApp();
    try {
      const { cookie, card, action } = await issueWithDismiss(t);
      const first = await execute(t, cookie, action.actionId, { reason: "误升级" });
      expect(first.statusCode).toBe(200);
      expect(first.json().cards[0].version).toBe(card.version + 1);

      const replay = await execute(t, cookie, action.actionId, { reason: "误升级" });
      expect(replay.statusCode).toBe(200);
      // 幂等重放读的是已落库对象，与首次响应的内存时间戳可能相差毫秒，只比对业务状态
      expect(replay.json().cards[0]).toMatchObject({
        version: first.json().cards[0].version,
        objectRef: first.json().cards[0].objectRef,
        payload: { status: "dismissed", dismissReason: "误升级" },
      });
    } finally {
      await t.close();
    }
  });

  it("fingerprint miss on a stale version returns 409 with latestCard", async () => {
    const t = await createTestApp();
    try {
      const { cookie, card, action } = await issueWithDismiss(t);
      expect((await execute(t, cookie, action.actionId, { reason: "误升级" })).statusCode).toBe(200);

      // 相同 actionId、不同 input → 新 fingerprint，未命中效果 → 校验 version → 409
      const res = await execute(t, cookie, action.actionId, { reason: "另一个原因" });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe("VERSION_CONFLICT");
      expect(body.latestCard.version).toBe(card.version + 1);
      expect(body.latestCard.payload.status).toBe("dismissed");
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

      // 合法签名但未注册的 actionType：必须 404，不能静默成功
      const unregistered = signActionId(t.env.sessionSecret, {
        actionType: "home.dismiss_notice",
        objectType: "home",
        objectId: "default",
        objectVersion: 1,
      });
      const unknown = await execute(t, cookie, unregistered, {});
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().code).toBe("UNKNOWN_ACTION");

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

  it("signs deterministic action ids without process state", () => {
    const scope = { actionType: "issue.dismiss", objectType: "issue", objectId: "obj", objectVersion: 7 };
    expect(signActionId("s", scope)).toBe(signActionId("s", { ...scope }));
    expect(signActionId("s", scope)).not.toBe(signActionId("s", { ...scope, objectVersion: 8 }));
    expect(signActionId("s", scope)).not.toBe(signActionId("other", scope));
  });
});
