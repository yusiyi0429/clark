// 云端令牌被拒：同步回 401 时本机当成没关联（网页会自己重新关联），发件箱留着、原因留着，关联上以后接着发。
// 会话的天枢 MCP 碰到 401 时用同步接口确认一次：同步也 401 才算被拒（/mcp/me 不认设备令牌时不能把关联弄掉）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const OLD = "token-old-0123456789abcdef";
const NEW = "token-new-0123456789abcdef";

/** 假天枢：同步只认 valid 这个令牌；/mcp/me 按 mcpStatus 回。 */
function fakeCloud() {
  const state = { valid: NEW, mcpStatus: 200, items: [] as any[], syncCalls: 0 };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/local-runner/sync") {
      state.syncCalls += 1;
      if (auth !== `Bearer ${state.valid}`) return json({ error: "unauthorized" }, 401);
      const body = JSON.parse(init.body);
      state.items.push(...body.items);
      return json({ accepted: body.items.map((i: any) => i.key), rejected: [] });
    }
    if (url.pathname === "/mcp/me") return json({}, state.mcpStatus);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { impl, state };
}

async function setup() {
  const work = tempDir("tl-rej-");
  const cloud = fakeCloud();
  const t = await startTestRunner({ pickFolder: work, fetchImpl: cloud.impl });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  const link = (tk: string) => call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: tk });
  const view = async () => (await call("GET", "/v1/cloud")).body;
  const open = async (title: string) => (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: work, firstMessage: `做 ${title}` })).body;
  /** 以会话里天枢 MCP 的身份调一次（经本机程序转发到 /mcp/me）。 */
  const mcp = async (id: string) => {
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    return raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/cloud-mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  };
  return { t, cloud, call, link, view, open, mcp };
}

describe("云端令牌被拒", { timeout: 30_000 }, () => {
  it("闲着、没有待发的条目，设备在插件页被吊销：到点的心跳（一批空的）回 401，当成没关联；网页拿新令牌重新关联后心跳正常、原因清掉（11/07 第二遍真跑的路径）", async () => {
    const h = await setup();
    const beatAfter = async (ms: number) => {
      // 定时器每分钟做的就是这一步；闲着满 5 分钟才真发
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + ms);
      try { await h.t.runner.outbox.heartbeat(); } finally { vi.useRealTimers(); }
    };
    try {
      h.cloud.state.valid = OLD;
      expect((await h.link(OLD)).status).toBe(200);
      await h.t.runner.outbox.heartbeat();
      expect(h.cloud.state.syncCalls).toBe(1);
      expect(await h.view()).toMatchObject({ linked: true, outbox: { pending: 0, lastError: null } });

      h.cloud.state.valid = NEW; // 吊销：旧令牌云端不认了
      await h.t.runner.outbox.heartbeat(); // 刚同步过，不到 5 分钟不发
      expect([h.cloud.state.syncCalls, (await h.view()).linked]).toEqual([1, true]);
      await beatAfter(5 * 60_000 + 1_000);
      expect(h.cloud.state.syncCalls).toBe(2);
      const v = await until(async () => { const x = await h.view(); return x.linked ? null : x; });
      expect(v).toMatchObject({ apiBaseUrl: null, outbox: { pending: 0, lastError: "云端令牌无效，请在天枢网页里重新连接本机" } });
      expect((await h.call("GET", "/v1/status")).body.cloud.linked).toBe(false);

      // 网页看到没关联，拿新令牌重新关联（插件页就是这样做的）
      expect((await h.link(NEW)).status).toBe(200);
      await beatAfter(5 * 60_000 + 1_000);
      expect(await h.view()).toMatchObject({ linked: true, outbox: { pending: 0, lastError: null } });
    } finally {
      vi.useRealTimers();
      await h.t.cleanup();
    }
  });

  it("同步回 401：当成没关联、原因留着、发件箱不丢；重新关联后接着发", async () => {
    const h = await setup();
    try {
      expect((await h.link(OLD)).status).toBe(200);
      const a = await h.open("A");
      const v = await until(async () => { const x = await h.view(); return x.linked ? null : x; });
      expect(v.apiBaseUrl).toBeNull();
      expect(v.outbox.pending).toBeGreaterThan(0);
      expect(v.outbox.lastError).toBe("云端令牌无效，请在天枢网页里重新连接本机");
      expect((await h.call("GET", "/v1/status")).body.cloud.linked).toBe(false);
      expect(h.cloud.state.items).toEqual([]);

      // 网页重新关联（新令牌）：攒着的条目发上去，错误清掉
      expect((await h.link(NEW)).status).toBe(200);
      const after = await until(async () => { const x = await h.view(); return x.outbox.pending === 0 ? x : null; });
      expect(after).toMatchObject({ linked: true, outbox: { lastError: null } });
      expect(h.cloud.state.items.some((i) => i.sessionId === a.id && i.type === "status")).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("会话的天枢 MCP 回 401：同步还认这个令牌就不动关联；同步也不认了才当成没关联", async () => {
    const h = await setup();
    try {
      expect((await h.link(NEW)).status).toBe(200);
      const a = await h.open("A");
      await until(async () => (await h.view()).outbox.pending === 0);
      h.cloud.state.mcpStatus = 401;
      const calls = h.cloud.state.syncCalls;
      expect((await h.mcp(a.id)).status).toBe(401);
      await until(() => h.cloud.state.syncCalls > calls); // 用同步接口确认了一次
      expect((await h.view()).linked).toBe(true);

      h.cloud.state.valid = "token-other-0123456789abcdef"; // 设备令牌被吊销
      expect((await h.mcp(a.id)).status).toBe(401);
      const v = await until(async () => { const x = await h.view(); return x.linked ? null : x; });
      expect(v.outbox.lastError).toBe("云端令牌无效，请在天枢网页里重新连接本机");
    } finally {
      await h.t.cleanup();
    }
  });
});
