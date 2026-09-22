import type { TRadarOutlet, TRadarSourceItem, TRadarSources } from "@warmap/contracts";
import { RADAR_OUTLETS } from "@warmap/contracts";
import type { RadarOutletAdapter } from "./radar.js";

/** 归属判定：host === d || host.endsWith("." + d)。ftalphaville.ft.com、online.wsj.com 因此自动覆盖。 */
/** 当前 Radar 配置中的启用 outletId；显式请求只能是已启用的白名单成员。 */
export function resolveConfiguredOutletIds(sources: TRadarSources, requested?: string[]): string[] {
  const known = new Set(RADAR_OUTLETS.map((outlet) => outlet.outletId));
  const enabled = new Set((sources.outlets ?? []).filter((source) => source.enabled).flatMap((source) => source.outlets));
  for (const id of enabled) if (!known.has(id)) throw new Error(`Radar outlet config contains unknown outletId: ${id}`);
  const ids = requested?.length ? requested : [...enabled];
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Unknown outletId: ${id}`);
    if (!enabled.has(id)) throw new Error(`Outlet ${id} is not enabled in Radar config`);
  }
  return [...new Set(ids)];
}

function ownedHost(url: string, domains: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

/** 发布时间无法解析为合法时刻时不伪造；该条目会被时间窗管线外的丢弃规则剔除。 */
function iso(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 文章页正文提取（量子位 WordPress：`<div class="article">…</div>`）。
 * 块级标签转空行保留段落；同时按文档顺序收集 https 配图及其段落位置（after = 前一段索引）。
 * 拿不到容器时返回空结果，由调用方诚实退回 feed 摘要。
 */
export function extractArticleContent(html: string): { text: string; images: { src: string; after: number }[] } {
  const container = html.match(/<div[^>]*class="[^"]*\barticle\b[^"]*"[^>]*>/i);
  if (!container) return { text: "", images: [] };
  const start = container.index! + container[0].length;
  const body = html.slice(start, start + 300_000);
  // 配图位置：图片前出现过的块级闭合数 − 1 ≈ 它跟在第几段之后
  const closeRe = /<\/(?:p|div|h[1-6]|li|blockquote|figcaption)>/gi;
  const imgRe = /<img[^>]+src="(https:\/\/[^"\s]+)"[^>]*>/gi;
  const images: { src: string; after: number }[] = [];
  let seen: RegExpExecArray | null;
  for (const match of body.matchAll(imgRe)) {
    if (images.length >= 12) break;
    closeRe.lastIndex = 0;
    let closes = 0;
    while ((seen = closeRe.exec(body)) && seen.index < match.index) closes += 1;
    images.push({ src: match[1].slice(0, 1000), after: Math.max(0, closes - 1) });
  }
  const text = decodeHtml(body)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|figcaption)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n ?\n(?: ?\n)+/g, "\n\n")
    .split("\n").map((line) => line.trim()).join("\n")
    .replace(/^\n+|\n+$/g, "")
    .slice(0, 10_000);
  return { text, images };
}

/** fullText outlet：逐条抓文章页提取全文与配图；失败或无正文时诚实退回 feed 摘要，不用抓取时间或标题冒充。 */
async function fetchFullText(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ text: string; images: { src: string; after: number }[] }> {
  try {
    const response = await fetchImpl(url, {
      signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)" },
    });
    if (!response.ok) return { text: "", images: [] };
    return extractArticleContent(await response.text());
  } catch {
    return { text: "", images: [] };
  }
}

/**
 * 发布方级来源（方案 A）：直取这 7 家自己的 RSS / news-sitemap，在本地做归属校验与时间窗过滤。
 * 博查实测不支持 site:/includeDomains，且索引里没有这 7 家（299 条命中 0 条），
 * 所以「全网检索 + 白名单过滤」召回必然为 0，这条路不能替代发布方渠道。
 */
export function createOutletFeedAdapter(options: {
  outlets?: readonly TRadarOutlet[];
  /** 单家单次扫描的条数上限；防止 economist 300 条把 assess 批次数顶穿。 */
  limit?: number;
  fetch?: typeof fetch;
  /** 时间窗基准时钟；默认真实时钟，测试注入固定时间以对齐 fixture。 */
  now?: () => number;
}): RadarOutletAdapter {
  const catalog = options.outlets ?? RADAR_OUTLETS;
  // 3 × 7 家 = 21；Radar 再设全局 20 条硬上限，至多 4 个 assess batch。
  const limit = options.limit ?? 3;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    configured: true,
    async fetchLatest({ outletIds, lookbackHours }, signal): Promise<TRadarSourceItem[]> {
      const wanted = catalog.filter((outlet) => outletIds.includes(outlet.outletId));
      const earliest = now() - lookbackHours * 60 * 60 * 1000;
      const items: TRadarSourceItem[] = [];
      for (const outlet of wanted) {
        const perOutlet = new Map<string, TRadarSourceItem>();
        for (const channel of outlet.channels) {
          if (signal?.aborted) break;
          let response: Response;
          try {
            response = await fetchImpl(channel.url, {
              signal,
              headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)" },
            });
          } catch {
            continue;
          }
          if (!response.ok) continue;
          const text = await response.text().catch(() => "");
          const blocks = channel.kind === "news-sitemap"
            ? text.match(/<url>[\s\S]*?<\/url>/g) ?? []
            : text.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
          for (const block of blocks) {
            const title = tag(block, channel.kind === "news-sitemap" ? "news:title" : "title");
            const link = tag(block, channel.kind === "news-sitemap" ? "loc" : "link");
            const publishedAt = iso(tag(block, channel.kind === "news-sitemap" ? "news:publication_date" : "pubDate"));
            // Reuters 的 news-sitemap 没有 description：excerpt 退回标题，并如实标注，不用正文抓取冒充
            const excerpt = tag(block, "description") || title;
            if (!title || !link || !publishedAt) continue;
            if (!ownedHost(link, outlet.articleDomains)) continue;
            const at = Date.parse(publishedAt);
            if (!Number.isFinite(at) || at < earliest) continue;
            perOutlet.set(link, {
              sourceType: "outlet",
              title: title.slice(0, 500),
              url: link,
              publishedAt,
              excerpt: excerpt.slice(0, 10_000),
              sourceRef: {
                type: "outlet",
                provider: "publisher-feed",
                outletId: outlet.outletId,
                outletName: outlet.name,
              },
            });
          }
        }
        // 渠道给的是整份最新列表而非检索结果：每家只保留窗口内最新的 limit 条，
        // 避免 economist 的 300 条把 assess 批次数顶穿。窗口外条目直接丢弃，不逐条报 warning。
        // fullText outlet 只对入选条目抓文章页（每家至多 limit 次），丢弃条目不产生抓取。
        const picked = [...perOutlet.values()]
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
          .slice(0, limit);
        if (outlet.fullText) {
          for (const item of picked) {
            if (signal?.aborted) break;
            const full = await fetchFullText(fetchImpl, item.url, signal);
            if (full.text) {
              item.excerpt = full.text;
              if (full.images.length) item.images = full.images;
            }
          }
        }
        items.push(...picked);
      }
      return items;
    },
  };
}
