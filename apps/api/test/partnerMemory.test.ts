import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp } from "./helpers.js";

const CHAT_TOKEN = "chat-token-test";

/** 假 Chat 的 GET /memories：凭据不对 401；按 x-owner-id 回各人的；status 给了就整个接口按它失败。 */
async function fakeChat(memories: Record<string, unknown[]>, status = 200) {
  const requests: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${CHAT_TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "内部服务凭据无效" } });
    if (req.method !== "GET" || req.url !== "/memories") return send(404, { error: { code: "NOT_FOUND", message: "没有这个接口" } });
    if (status !== 200) return send(status, { error: { code: "INTERNAL", message: "出错了" } });
    send(200, { memories: memories[String(req.headers["x-owner-id"])] ?? [] });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const memory = (id: string, extra: Record<string, unknown> = {}) => ({ id, category: "preference", text: `记忆 ${id}`, project: null, tentative: false,
  updatedAt: "2026-11-02T08:00:00.000Z", ...extra });

describe("「我的记忆」页的伙伴记住的（GET /api/me/memory/partner）", () => {
  it("没接 Chat：available=false、items 为空；没登录 401", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/me/memory/partner" })).statusCode).toBe(401);
      const response = await t.app.inject({ method: "GET", url: "/api/me/memory/partner", headers: { cookie: await t.loginCookie() } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ available: false, items: [] });
    } finally {
      await t.close();
    }
  });

  it("接了 Chat：CEO、成员各按自己的身份和视角读，照 Chat 的顺序只回约定的字段", async () => {
    const chat = await fakeChat({
      [TEST_CEO.personId]: [
        memory("m2", { category: "project_background", text: "灯塔试点四周，先跑华夏", project: "灯塔", tentative: true, ownerId: TEST_CEO.personId, status: "active" }),
        memory("m1", { category: "feedback_instruction", text: "汇报先给结论" }),
      ],
      [TEST_MEMBER.personId]: [memory("m3", { category: "research_decision", text: "定价先按席位" })],
    });
    const t = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: chat.url });
    try {
      const ceo = await t.app.inject({ method: "GET", url: "/api/me/memory/partner", headers: { cookie: await t.loginCookie() } });
      expect(ceo.statusCode).toBe(200);
      expect(ceo.json()).toEqual({ available: true, items: [
        { id: "m2", category: "project_background", text: "灯塔试点四周，先跑华夏", project: "灯塔", tentative: true, updatedAt: "2026-11-02T08:00:00.000Z" },
        { id: "m1", category: "feedback_instruction", text: "汇报先给结论", project: null, tentative: false, updatedAt: "2026-11-02T08:00:00.000Z" },
      ] });
      const member = await t.app.inject({ method: "GET", url: "/api/me/memory/partner", headers: { cookie: await t.memberCookie() } });
      expect(member.json()).toEqual({ available: true, items: [
        { id: "m3", category: "research_decision", text: "定价先按席位", project: null, tentative: false, updatedAt: "2026-11-02T08:00:00.000Z" },
      ] });
      expect(chat.requests.map((request) => [request.url, request.headers["x-owner-id"], request.headers["x-viewer-role"]])).toEqual([
        ["/memories", TEST_CEO.personId, "ceo"], ["/memories", TEST_MEMBER.personId, "member"]]);
      // 浏览器的 Cookie 不转给 Chat。
      expect(chat.requests.every((request) => request.headers.cookie === undefined)).toBe(true);
    } finally {
      await t.close();
      await chat.close();
    }
  });

  it("Chat 出错、连不上：按天枢的错误格式回 Chat 转来的码（502 CHAT_FAILED、503 CHAT_UNAVAILABLE）", async () => {
    const broken = await fakeChat({}, 500);
    const failing = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: broken.url });
    try {
      const response = await failing.app.inject({ method: "GET", url: "/api/me/memory/partner", headers: { cookie: await failing.loginCookie() } });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "CHAT_FAILED", retryable: false, requestId: expect.any(String) });
    } finally {
      await failing.close();
      await broken.close();
    }

    const gone = await fakeChat({});
    await gone.close();
    const t = await createTestApp({ internalChatToken: CHAT_TOKEN, chatServiceUrl: gone.url });
    try {
      const response = await t.app.inject({ method: "GET", url: "/api/me/memory/partner", headers: { cookie: await t.loginCookie() } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "CHAT_UNAVAILABLE", message: "对话服务暂时连不上。", retryable: false });
    } finally {
      await t.close();
    }
  });
});
