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
