import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createTestApp, TEST_CEO } from "./helpers.js";

it("数据质量代理只转发登录者身份；个人 MCP 可读取同一人的补齐记录", async () => {
  const requests: { url: string; owner: string | string[] | undefined; role: string | string[] | undefined }[] = [];
  let failure = false;
  const upstream = createServer((req, res) => {
    expect(req.headers.authorization).toBe("Bearer synthetic-chat-token");
    expect(req.headers.cookie).toBeUndefined();
    requests.push({ url: req.url!, owner: req.headers["x-owner-id"], role: req.headers["x-viewer-role"] });
    res.setHeader("content-type", "application/json");
    if (failure) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "WORLD_SCOPE_CHANGED", message: "world 范围已变化，请重新核对该项" } })); return; }
    res.end(JSON.stringify({ proposals: [] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const t = await createTestApp({ chatServiceUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, internalChatToken: "synthetic-chat-token" });
  try {
    const cookie = await t.loginCookie();
    const response = await t.app.inject({ url: "/api/task-quality/proposals", headers: { cookie, "x-owner-id": "someone-else", "x-viewer-role": "member" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ proposals: [] });
    const token = (await t.app.inject({ method: "POST", url: "/api/me/tokens", headers: { cookie, origin: t.publicOrigin },
      payload: { name: "quality-test", client: "codex", expiresInDays: 30 } })).json().token;
    const rpc = await t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_task_repairs", arguments: { viewerRole: "ceo" } } } });
    expect(rpc.statusCode).toBe(200);
    expect(rpc.json().result.isError).toBe(false);
    expect(JSON.parse(rpc.json().result.content[0].text)).toEqual({ proposals: [] });
    expect(requests).toEqual([
      { url: "/task-quality/proposals", owner: TEST_CEO.personId, role: "ceo" },
      { url: "/task-quality/proposals", owner: TEST_CEO.personId, role: "ceo" },
    ]);
    expect((await t.app.inject({ url: "/api/task-quality/proposals" })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/api/task-quality/status", headers: { cookie } })).json()).toEqual({ enabled: true });
    failure = true;
    const conflict = await t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_task_repair_handoff", arguments: { viewerRole: "ceo", proposalId: "10000000-0000-4000-8000-000000000002" } } } });
    expect(conflict.json().result.isError).toBe(true);
    expect(JSON.parse(conflict.json().result.content[0].text).code).toBe("WORLD_SCOPE_CHANGED");
  } finally { await t.close(); await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); }); }
});

it("没接数据质量服务时入口开关为关，接口照旧返回 503", async () => {
  const t = await createTestApp();
  try {
    const cookie = await t.loginCookie();
    expect((await t.app.inject({ url: "/api/task-quality/status" })).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/api/task-quality/status", headers: { cookie } })).json()).toEqual({ enabled: false });
    expect((await t.app.inject({ url: "/api/task-quality/proposals", headers: { cookie } })).statusCode).toBe(503);
  } finally { await t.close(); }
});
