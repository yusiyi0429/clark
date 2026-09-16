import type {
  TWebSearchInput as WebSearchInput,
  TWebSearchResponse as WebSearchResponse,
  TWebSearchResult as WebSearchResult,
} from "@warmap/contracts";

export type WebSearchAdapter = {
  search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchResponse>;
};

export const unavailableWebSearchAdapter: WebSearchAdapter = {
  async search() {
    throw new Error("Web Search provider is not configured; set BOCHA_API_KEY");
  },
};

export type BochaWebSearchOptions = {
  apiKey?: string;
  /** 默认博查 Web Search 端点；测试可指向本地 stub。 */
  endpoint?: string;
  /** 单次返回条数（博查默认 10，上限 50）。 */
  count?: number;
  fetch?: typeof fetch;
};

const DEFAULT_ENDPOINT = "https://api.bochaai.com/v1/web-search";
// WebSearchInput.freshness → 博查 freshness 枚举（见 frontend/src/lib/research/search.ts 既有实现）。
const FRESHNESS: Record<NonNullable<WebSearchInput["freshness"]>, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
};

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 博查可能返回 `2026-05-01T08:00:00+08:00` 等格式；无法解析为合法时刻时不伪造发布时间。 */
function dateTime(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/**
 * 唯一 Web Search Provider（Ticket 16 决策）：博查。
 * 响应是「HTTP 200 + 业务 code」风格，配额/权限错误可能仍是 200，所以显式检查 code。
 */
export function createBochaWebSearchAdapter({
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  count = 20,
  fetch: fetchImpl = fetch,
}: BochaWebSearchOptions): WebSearchAdapter & { configured: boolean } {
  return {
    configured: Boolean(apiKey),
    async search(input, signal): Promise<WebSearchResponse> {
      if (!apiKey) throw new Error("Web Search provider 未配置 BOCHA_API_KEY");
      const query = input.domains?.length
        ? `${input.query} ${input.domains.map((domain) => `site:${domain}`).join(" OR ")}`
        : input.query;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          count,
          summary: true,
          ...(input.freshness ? { freshness: FRESHNESS[input.freshness] } : {}),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // 提供商错误体可能回显 Authorization：按已知 key 精确抹除后再进错误信息
        const safeDetail = (apiKey ? detail.split(apiKey).join("***") : detail).slice(0, 200);
        throw new Error(`Bocha Search HTTP ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`);
      }
      const body = obj(await response.json());
      const code = body.code;
      if (code !== undefined && code !== null && String(code) !== "200") {
        throw new Error(`Bocha Search code=${String(code)}: ${str(body.message) || str(body.msg)}`.slice(0, 300));
      }
      const data = Object.keys(obj(body.data)).length > 0 ? obj(body.data) : body;
      const pages = obj(data.webPages).value;
      const results: WebSearchResult[] = [];
      for (const raw of Array.isArray(pages) ? pages : []) {
        const item = obj(raw);
        const title = str(item.name);
        const url = str(item.url);
        const excerpt = str(item.summary) || str(item.snippet);
        if (!title || !url || !excerpt) continue;
        try {
          new URL(url);
        } catch {
          continue;
        }
        const publishedAt = dateTime(item.datePublished);
        results.push({ title, url, excerpt, provider: "bocha", ...(publishedAt ? { publishedAt } : {}) });
      }
      return { results, warnings: results.length === 0 ? ["Bocha 未返回可用的 title/URL/excerpt 结果"] : [] };
    },
  };
}
