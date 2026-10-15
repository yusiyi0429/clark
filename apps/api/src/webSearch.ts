import { setTimeout as delay } from "node:timers/promises";
import type {
  TWebSearchInput as WebSearchInput,
  TWebSearchResponse as WebSearchResponse,
  TWebSearchResult as WebSearchResult,
} from "@warmap/contracts";
import { RETRIEVE_SOURCES, withRetrieve } from "./tracing.js";

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
  /** 请求间隔与 429 退避用的时钟和等待；测试注入假时钟，不真实等待。 */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const DEFAULT_ENDPOINT = "https://api.bochaai.com/v1/web-search";
// 博查按秒限流（HTTP 429 "request limit"）：同一适配器实例的请求起点至少间隔 1100ms。
const MIN_INTERVAL_MS = 1100;
// 仅 HTTP 429 重试，最多 2 次、依次退避 1s/2s；有 Retry-After 时以它为准，上限 10s。
const RETRY_BACKOFF_MS = [1000, 2000];
const MAX_RETRY_AFTER_MS = 10_000;
// WebSearchInput.freshness → 博查 freshness 枚举。
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

/** Retry-After 可以是秒数或 HTTP 日期；无法解析时返回 undefined，走默认退避。 */
function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1000 : Date.parse(value) - nowMs;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : undefined;
}

/**
 * 唯一 Web Search Provider（Ticket 16 决策）：博查。
 * 响应是「HTTP 200 + 业务 code」风格，配额/权限错误可能仍是 200，所以显式检查 code。
 * 请求间隔在实例内生效：雷达与对话 web_search 必须共用同一个实例（server.ts 装配）。
 */
export function createBochaWebSearchAdapter({
  apiKey,
  endpoint = DEFAULT_ENDPOINT,
  count = 20,
  fetch: fetchImpl = fetch,
  now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}: BochaWebSearchOptions): WebSearchAdapter & { configured: boolean } {
  let nextStartAt = 0;
  // 同步占用下一个发送槽位再等待，并发调用者按顺序错开，不会同时醒来
  async function throttle(signal: AbortSignal): Promise<void> {
    const startAt = Math.max(now(), nextStartAt);
    nextStartAt = startAt + MIN_INTERVAL_MS;
    const wait = startAt - now();
    if (wait > 0) await sleep(wait, signal);
  }
  const adapter = {
    configured: Boolean(apiKey),
    async search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchResponse> {
      if (!apiKey) throw new Error("Web Search provider 未配置 BOCHA_API_KEY");
      const query = input.domains?.length
        ? `${input.query} ${input.domains.map((domain) => `site:${domain}`).join(" OR ")}`
        : input.query;
      const init: RequestInit = {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          count,
          summary: true,
          ...(input.freshness ? { freshness: FRESHNESS[input.freshness] } : {}),
        }),
      };
      const send = async () => {
        await throttle(signal);
        return fetchImpl(endpoint, init);
      };
      let response = await send();
      for (const backoff of RETRY_BACKOFF_MS) {
        if (response.status !== 429) break;
        await response.body?.cancel();
        await sleep(retryAfterMs(response.headers.get("retry-after"), now()) ?? backoff, signal);
        response = await send();
      }
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
      // 博查的 images 与网页结果分开返回：只认 hostPageUrl 与某条网页完全对得上的图，不把别家的图张冠李戴。
      const imageByPage = new Map<string, string>();
      const imageList = obj(data.images).value;
      for (const raw of Array.isArray(imageList) ? imageList : []) {
        const image = obj(raw);
        const host = str(image.hostPageUrl);
        const src = str(image.contentUrl) || str(image.thumbnailUrl);
        if (host && /^https?:\/\//.test(src) && src.length <= 1000 && !imageByPage.has(host)) imageByPage.set(host, src);
      }
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
        const imageUrl = imageByPage.get(url);
        results.push({ title, url, excerpt, provider: "bocha", ...(publishedAt ? { publishedAt } : {}), ...(imageUrl ? { imageUrl } : {}) });
      }
      return { results, warnings: results.length === 0 ? ["Bocha 未返回可用的 title/URL/excerpt 结果"] : [] };
    },
  };
  return {
    configured: adapter.configured,
    // 每次真实博查请求一个 retrieve:web-search 节点（对话、预研、雷达共用这个实例）。
    search: (input, signal) => withRetrieve(RETRIEVE_SOURCES.webSearch, () => ({ query: input.query, domains: input.domains, freshness: input.freshness }),
      () => adapter.search(input, signal), (response) => ({ results: response.results.map((item) => ({ title: item.title, url: item.url })), warnings: response.warnings })),
  };
}
