import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TWebSearchInput } from "@warmap/contracts";
import { runWebSearch, WEB_SEARCH_PER_DAY, WEB_SEARCH_PER_MINUTE } from "../src/mcpWebSearch.js";
import { createTestApp, TEST_MEMBER } from "./helpers.js";

const NOW = new Date("2026-11-06T02:00:00.000Z");
const signal = new AbortController().signal;

describe("MCP web_search", { timeout: 30_000 }, () => {
  it("用服务器上的博查搜，结果去重、截短；每次真搜记一行；每人每分钟、每天有上限；没接通、搜失败、参数不对各回各的错", async () => {
    const t = await createTestApp();
    try {
      const q = (text: string, params?: unknown[]) => t.pool.query(text, params);
      const asked: TWebSearchInput[] = [];
      const long = "长".repeat(600);
      const search = { configured: true, async search(input: TWebSearchInput) {
        asked.push(input);
        if (input.query === "坏了") throw new Error("Bocha Search HTTP 500");
        return { results: [
          { title: "甲", url: "https://a.example/1", excerpt: long, provider: "bocha", publishedAt: "2026-11-05T00:00:00.000Z", imageUrl: "https://a.example/1.png" },
          { title: "甲again", url: "https://a.example/1", excerpt: "重复", provider: "bocha" },
          ...Array.from({ length: 10 }, (_, index) => ({ title: `乙${index}`, url: `https://b.example/${index}`, excerpt: "短", provider: "bocha" })),
        ], warnings: [] };
      } };
      const me = { personId: TEST_MEMBER.personId, client: "local" };
      const run = (args: unknown, at = NOW, who = me, adapter = search) => runWebSearch({ q, search: adapter, now: at }, who, args, signal);

      const found = await run({ query: "新加坡 天气", freshness: "day", domains: ["nea.gov.sg"] });
      expect(asked[0]).toEqual({ query: "新加坡 天气", freshness: "day", domains: ["nea.gov.sg"] });
      if (!found.ok) throw new Error(found.message);
      expect(found.value.results).toHaveLength(8);
      expect(found.value.results[0]).toEqual({ title: "甲", url: "https://a.example/1", excerpt: `${"长".repeat(500)}…`, publishedAt: "2026-11-05T00:00:00.000Z" });
      expect(found.value.results[1].title).toBe("乙0");

      expect(await run({ query: "" })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await run({ query: "x", extra: 1 })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
      expect(await run({ query: "x" }, NOW, me, { configured: false, search: search.search })).toMatchObject({ ok: false, code: "WEB_SEARCH_NOT_CONFIGURED" });
      const failed = await run({ query: "坏了" });
      expect(failed).toMatchObject({ ok: false, code: "WEB_SEARCH_FAILED" });
      expect(JSON.stringify(failed)).not.toContain("Bocha");
      expect(await t.sql("SELECT person_id,client,ok,result_count FROM web_search_calls ORDER BY ok DESC")).toEqual([
        { person_id: TEST_MEMBER.personId, client: "local", ok: true, result_count: 8 },
        { person_id: TEST_MEMBER.personId, client: "local", ok: false, result_count: null },
      ]);

      // 每分钟：这一分钟已经两次，再 8 次到上限，第 11 次拒；一分钟后又能搜；别人不受影响。
      for (let index = 2; index < WEB_SEARCH_PER_MINUTE; index++) expect((await run({ query: `第${index}次` })).ok).toBe(true);
      expect(await run({ query: "超了" })).toMatchObject({ ok: false, code: "RATE_LIMITED" });
      expect((await run({ query: "别人" }, NOW, { personId: "person-other", client: "codex" })).ok).toBe(true);
      expect((await run({ query: "过一分钟" }, new Date(NOW.getTime() + 61_000))).ok).toBe(true);
      expect(asked.filter((input) => input.query === "超了")).toEqual([]);

      // 每天（上海时间）：凑满当天的额度，当天再搜拒；上海时间第二天 0 点以后又能搜。
      await t.sql(`INSERT INTO web_search_calls(id,person_id,client,at,ok,result_count)
        SELECT gen_random_uuid(),$1,'local',$2::timestamptz-make_interval(mins=>5+n),TRUE,8 FROM generate_series(1,$3::int) n`,
      [TEST_MEMBER.personId, NOW, WEB_SEARCH_PER_DAY - WEB_SEARCH_PER_MINUTE - 1]);
      expect(await run({ query: "今天满了" }, new Date(NOW.getTime() + 3 * 60_000))).toMatchObject({ ok: false, code: "RATE_LIMITED" });
      expect((await run({ query: "第二天" }, new Date("2026-11-06T16:00:00.000Z"))).ok).toBe(true);
    } finally { await t.close(); }
  });

  it("挂在 /mcp/me：个人令牌和本机程序的设备令牌都能调，说明里多一句；没配博查时不列", async () => {
    const asked: TWebSearchInput[] = [];
    const search = { async search(input: TWebSearchInput) {
      asked.push(input);
      return { results: [{ title: "新加坡天气", url: "https://www.nea.gov.sg/weather", excerpt: "晴", provider: "bocha" }], warnings: [] };
    } };
    const t = await createTestApp({}, undefined, { webSearch: search });
    try {
      const cookie = await t.memberCookie();
      const call = (method: "POST", url: string, payload: Record<string, unknown>) => t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, payload });
      const personal = (await call("POST", "/api/me/tokens", { name: "Claude Code", client: "claude", expiresInDays: null })).json().token as string;
      const device = randomUUID();
      const local = (await call("POST", "/api/me/local-devices", { deviceId: device, name: "我的电脑", os: "win32" })).json().token as string;
      const mcp = (token: string, id: number, method: string, params?: Record<string, unknown>) => t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } });
      const initialized = (await mcp(personal, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
      expect(initialized.result.instructions).toContain("web_search");
      expect((await mcp(personal, 2, "tools/list")).json().result.tools.map((tool: { name: string }) => tool.name)).toContain("web_search");
      expect((await mcp(local, 3, "tools/list")).json().result.tools.map((tool: { name: string }) => tool.name)).toContain("web_search");
      for (const [token, query] of [[personal, "新加坡 天气"], [local, "新加坡 今天"]]) {
        const called = (await mcp(token, 4, "tools/call", { name: "web_search", arguments: { query } })).json().result;
        expect(called.isError).toBe(false);
        expect(JSON.parse(called.content[0].text).results).toEqual([{ title: "新加坡天气", url: "https://www.nea.gov.sg/weather", excerpt: "晴" }]);
      }
      expect(asked.map((input) => input.query)).toEqual(["新加坡 天气", "新加坡 今天"]);
      expect(await t.sql("SELECT person_id,client,ok FROM web_search_calls ORDER BY at,client")).toEqual(expect.arrayContaining([
        { person_id: TEST_MEMBER.personId, client: "claude", ok: true }, { person_id: TEST_MEMBER.personId, client: "local", ok: true }]));
      const bad = (await mcp(personal, 5, "tools/call", { name: "web_search", arguments: { query: "" } })).json().result;
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.content[0].text).code).toBe("INVALID_INPUT");
    } finally { await t.close(); }

    const plain = await createTestApp();
    try {
      const cookie = await plain.memberCookie();
      const token = (await plain.app.inject({ method: "POST", url: "/api/me/tokens", headers: { cookie, origin: plain.publicOrigin },
        payload: { name: "Codex", client: "codex", expiresInDays: null } })).json().token as string;
      const listed = await plain.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(listed.json().result.tools.map((tool: { name: string }) => tool.name)).not.toContain("web_search");
    } finally { await plain.close(); }
  });
});
