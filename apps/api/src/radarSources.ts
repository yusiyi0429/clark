import type { TRadarSourceItem } from "@warmap/contracts";
import type { RadarWebAdapter, RadarWechatAdapter } from "./radar.js";

type Fetch = typeof fetch;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Provider response missing ${field}`);
  return value;
}

export function createBraveRadarWebAdapter({
  apiKey,
  endpoint = "https://api.search.brave.com/res/v1/web/search",
  fetch: fetchImpl = fetch,
}: {
  apiKey?: string;
  endpoint?: string;
  fetch?: Fetch;
}): RadarWebAdapter {
  return {
    configured: Boolean(apiKey),
    async search(input, signal): Promise<TRadarSourceItem[]> {
      if (!apiKey) throw new Error("Web Search provider is not configured");
      const url = new URL(endpoint);
      const domainFilter = input.domains?.map((domain) => `site:${domain}`).join(" OR ");
      url.searchParams.set("q", domainFilter ? `${input.query} ${domainFilter}` : input.query);
      url.searchParams.set("count", "20");
      const response = await fetchImpl(url, {
        signal,
        headers: { accept: "application/json", "x-subscription-token": apiKey },
      });
      if (!response.ok) throw new Error(`Brave Search failed with HTTP ${response.status}`);
      const body = await response.json() as { web?: { results?: unknown[] } };
      if (!Array.isArray(body.web?.results)) throw new Error("Brave Search returned an invalid response");
      return body.web.results.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          sourceType: "web" as const,
          title: text(row.title, "title"),
          url: text(row.url, "url"),
          publishedAt: text(row.page_age ?? row.published_at, "publishedAt"),
          excerpt: text(row.description, "excerpt"),
          sourceRef: { type: "web-search" as const, provider: "brave", query: input.query },
        };
      });
    },
  };
}

export function createWechatAccountHttpAdapter({
  endpoint,
  credentials,
  fetch: fetchImpl = fetch,
}: {
  endpoint?: string;
  credentials?: string;
  fetch?: Fetch;
}): RadarWechatAdapter {
  return {
    configured: Boolean(endpoint && credentials),
    async fetchLatest(input, signal): Promise<TRadarSourceItem[]> {
      if (!endpoint || !credentials) throw new Error("WeChat account provider is not configured");
      const url = new URL(endpoint);
      url.searchParams.set("accountId", input.accountId);
      const response = await fetchImpl(url, {
        signal,
        headers: { accept: "application/json", authorization: `Bearer ${credentials}` },
      });
      if (!response.ok) throw new Error(`WeChat account provider failed with HTTP ${response.status}`);
      const body = await response.json() as { articles?: unknown[] };
      if (!Array.isArray(body.articles)) throw new Error("WeChat account provider returned an invalid response");
      return body.articles.map((item) => {
        const row = item as Record<string, unknown>;
        return {
          sourceType: "wechat-account" as const,
          title: text(row.title, "title"),
          url: text(row.url, "url"),
          publishedAt: text(row.publishedAt, "publishedAt"),
          excerpt: text(row.excerpt, "excerpt"),
          sourceRef: {
            type: "wechat-account" as const,
            provider: "wechat-http",
            accountId: input.accountId,
            accountName: input.accountName,
          },
        };
      });
    },
  };
}
