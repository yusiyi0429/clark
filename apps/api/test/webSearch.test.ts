import { describe, expect, it } from "vitest";
import { createBochaWebSearchAdapter } from "../src/webSearch.js";

describe("Bocha Web Search adapter public seam", () => {
  it("returns title, URL and excerpt and maps freshness to Bocha buckets", async () => {
    const requests: { authorization: string | null; body: Record<string, unknown> }[] = [];
    const adapter = createBochaWebSearchAdapter({
      apiKey: "bocha-key",
      endpoint: "https://bocha.invalid/web-search",
      fetch: async (_input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({
          code: 200,
          data: { webPages: { value: [
            { name: "公告", url: "https://example.com/a", summary: "长摘要", datePublished: "2026-05-01T08:00:00+08:00" },
            { name: "无摘要", url: "https://example.com/b", snippet: "", summary: "" },
            { name: "坏 URL", url: "not-a-url", summary: "有摘要" },
          ] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await adapter.search({ query: "市场变化", freshness: "week" }, new AbortController().signal);
    expect(result.warnings).toEqual([]);
    expect(result.results).toEqual([{
      title: "公告",
      url: "https://example.com/a",
      publishedAt: "2026-05-01T00:00:00.000Z",
      excerpt: "长摘要",
      provider: "bocha",
    }]);
    expect(requests[0].authorization).toBe("Bearer bocha-key");
    expect(requests[0].body).toMatchObject({ query: "市场变化", summary: true, freshness: "oneWeek" });
  });

  it("surfaces HTTP 200 business errors instead of returning an empty result set", async () => {
    const adapter = createBochaWebSearchAdapter({
      apiKey: "bocha-key",
      endpoint: "https://bocha.invalid/web-search",
      fetch: async () => new Response(JSON.stringify({ code: 403, message: "余额不足" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(adapter.search({ query: "x" }, new AbortController().signal)).rejects.toThrow(/code=403/);
  });

  it("redacts the API key if a provider error body echoes it", async () => {
    const adapter = createBochaWebSearchAdapter({
      apiKey: "bocha-secret-key-abcdef",
      endpoint: "https://bocha.invalid/web-search",
      fetch: async () => new Response(`invalid token bocha-secret-key-abcdef`, { status: 401 }),
    });
    const error = await adapter.search({ query: "x" }, new AbortController().signal).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 401/);
    expect((error as Error).message).not.toContain("bocha-secret-key-abcdef");
  });

  it("fails honestly when the API key is missing", async () => {
    const adapter = createBochaWebSearchAdapter({});
    await expect(adapter.search({ query: "x" }, new AbortController().signal)).rejects.toThrow(/BOCHA_API_KEY/);
  });
});

describe("Bocha request spacing and 429 retry", () => {
  const T0 = Date.parse("2026-09-25T00:00:00.000Z");
  const ok = () => new Response(JSON.stringify({ code: 200, data: { webPages: { value: [
    { name: "公告", url: "https://example.com/a", summary: "摘要" },
  ] } } }), { status: 200, headers: { "content-type": "application/json" } });
  const limited = (headers?: Record<string, string>) => () =>
    new Response("You have reached the request limit", { status: 429, headers });

  // 假时钟：sleep 只推进时间不真实等待；starts 记录每次请求发出时刻，wakes 记录每次等待的目标时刻
  function harness(responses: (() => Response)[] = []) {
    let clock = T0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const wakes: number[] = [];
    const adapter = createBochaWebSearchAdapter({
      apiKey: "bocha-key",
      endpoint: "https://bocha.invalid/web-search",
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        wakes.push(clock + ms);
        clock += ms;
      },
      fetch: async () => {
        starts.push(clock);
        return (responses.shift() ?? ok)();
      },
    });
    return { adapter, starts, sleeps, wakes };
  }
  const signal = () => new AbortController().signal;

  it("spaces consecutive request starts at least 1100ms apart, including concurrent callers", async () => {
    const sequential = harness();
    await sequential.adapter.search({ query: "a" }, signal());
    await sequential.adapter.search({ query: "b" }, signal());
    await sequential.adapter.search({ query: "c" }, signal());
    expect(sequential.starts).toEqual([T0, T0 + 1100, T0 + 2200]);

    // 并发调用（雷达扫描与对话 web_search 同时发起）按顺序占用间隔槽位
    const concurrent = harness();
    await Promise.all(["a", "b", "c"].map((query) => concurrent.adapter.search({ query }, signal())));
    expect(concurrent.wakes).toEqual([T0 + 1100, T0 + 2200]);
  });

  it("retries HTTP 429 after a 1s backoff and still respects the spacing", async () => {
    const { adapter, starts, sleeps } = harness([limited(), ok]);
    const result = await adapter.search({ query: "x" }, signal());
    expect(result.results).toHaveLength(1);
    expect(starts).toEqual([T0, T0 + 1100]);
    expect(sleeps).toEqual([1000, 100]);
  });

  it("gives up after two 429 retries (1s then 2s) and keeps the HTTP 429 error shape", async () => {
    const { adapter, starts, sleeps } = harness([limited(), limited(), limited(), ok]);
    await expect(adapter.search({ query: "x" }, signal()))
      .rejects.toThrow(/^Bocha Search HTTP 429: You have reached the request limit$/);
    expect(starts).toEqual([T0, T0 + 1100, T0 + 3100]);
    expect(sleeps).toEqual([1000, 100, 2000]);
  });

  it("honors Retry-After in seconds or as an HTTP date, capped at 10s", async () => {
    const cases: [Record<string, string>, number][] = [
      [{ "retry-after": "3" }, 3000],
      [{ "retry-after": new Date(T0 + 5000).toUTCString() }, 5000],
      [{ "retry-after": "60" }, 10_000],
    ];
    for (const [headers, wait] of cases) {
      const { adapter, starts, sleeps } = harness([limited(headers), ok]);
      await adapter.search({ query: "x" }, signal());
      expect(sleeps).toEqual([wait]);
      expect(starts).toEqual([T0, T0 + wait]);
    }
  });

  it("does not retry non-429 errors", async () => {
    const { adapter, starts, sleeps } = harness([() => new Response("upstream down", { status: 500 }), ok]);
    await expect(adapter.search({ query: "x" }, signal())).rejects.toThrow(/^Bocha Search HTTP 500: upstream down$/);
    expect(starts).toEqual([T0]);
    expect(sleeps).toEqual([]);
  });
});
