import { decodeHtml } from "./outletSources.js";

/** GitHub Trending 的一条上榜仓库。榜单没有逐条发布时间，只有上榜日，由调用方按扫描当天记。 */
export type TrendingRepo = {
  fullName: string;
  url: string;
  /** 仓库没写描述时为 null，不编。 */
  description: string | null;
  language: string | null;
  /** 「N stars today／this week／this month」里的 N；榜单版本不同，时段跟着 since 变。 */
  starsInPeriod: number | null;
};

export type TrendingSince = "daily" | "weekly" | "monthly";

export type GithubTrendingReader = {
  read(source: { language: string | null; since: TrendingSince }, signal: AbortSignal): Promise<{ repos: TrendingRepo[]; warnings: string[] }>;
};

const USER_AGENT = "Tianshu-PersonalRadar/1.0 (+reads github.com/trending once per scan)";

function text(html: string | undefined): string {
  return decodeHtml((html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 解析 `article.Box-row`：仓库全名、链接、描述、语言、时段内 star。结构对不上的行直接跳过。 */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const rows = html.match(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi) ?? [];
  return rows.flatMap((row) => {
    const heading = row.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*\bhref="\/([\w.-]+)\/([\w.-]+)"/i);
    if (!heading) return [];
    const fullName = `${heading[1]}/${heading[2]}`;
    const description = text(row.match(/<p\b[^>]*class="[^"]*\bcol-9\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const language = text(row.match(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/i)?.[1]);
    const stars = row.match(/([\d,]+)\s+stars?\s+(?:today|this week|this month)/i);
    return [{
      fullName,
      url: `https://github.com/${fullName}`,
      description: description || null,
      language: language || null,
      starsInPeriod: stars ? Number(stars[1].replace(/,/g, "")) : null,
    }];
  });
}

/** 没有榜单行时区分「今天就是空榜」和「页面结构变了」；两种都要写 warning，不能静默。 */
export function emptyTrendingWarning(html: string): string {
  return /don[’']t have any trending repositories/i.test(html)
    ? "GitHub Trending 这一版今天是空榜"
    : "GitHub Trending 页面结构可能变了，没有解析出上榜仓库";
}

export function trendingPageUrl({ language, since }: { language: string | null; since: TrendingSince }): string {
  const url = new URL(`https://github.com/trending${language ? `/${encodeURIComponent(language)}` : ""}`);
  if (since !== "daily") url.searchParams.set("since", since);
  return url.toString();
}

/** 每次扫描只读一页：有超时、两次请求之间至少间隔 minIntervalMs、带 User-Agent。 */
export function createGithubTrendingReader({
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  minIntervalMs = 2_000,
  sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
}: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): GithubTrendingReader {
  let nextAllowedAt = 0;
  return {
    async read(source, signal) {
      const wait = nextAllowedAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Date.now() + minIntervalMs;
      const response = await fetchImpl(trendingPageUrl(source), {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) throw new Error(`GitHub Trending 返回 HTTP ${response.status}`);
      const html = await response.text();
      const repos = parseTrendingHtml(html);
      return { repos, warnings: repos.length ? [] : [emptyTrendingWarning(html)] };
    },
  };
}
