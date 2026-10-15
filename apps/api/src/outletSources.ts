import type { TRadarOutlet, TRadarSourceItem, TRadarSources } from "@warmap/contracts";
import { RADAR_OUTLETS } from "@warmap/contracts";
import type { RadarOutletAdapter } from "./radar.js";
import { RETRIEVE_SOURCES, withRetrieve } from "./tracing.js";
import { ARTICLE_FETCH_TIMEOUT_MS, ARTICLE_MIN_CHARS, decodeHtml, extractReadableArticle, paragraphsFromHtml, type ArticleContent } from "./articleText.js";

// 实体解码与通用正文提取共用一份实现；githubTrending、清理脚本仍从这里取
export { decodeHtml };

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

/** Atom 的链接在属性里：取 rel="alternate" 的 href，不写 rel 的按规范视为 alternate。 */
function atomLink(entry: string): string {
  for (const [link] of entry.matchAll(/<link\b[^>]*>/gi)) {
    const rel = link.match(/\brel=["']([^"']*)["']/i)?.[1];
    const href = link.match(/\bhref=["']([^"']*)["']/i)?.[1];
    if (href && (!rel || rel === "alternate")) return decodeXml(href);
  }
  return "";
}

/** Atom 的 summary／content 常是转义后的 HTML：去掉标签再解码实体，只留文字。 */
function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 发布时间无法解析为合法时刻时不伪造；该条目会被时间窗管线外的丢弃规则剔除。 */
function iso(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

/** 从 `<div …>` 开标签处按 div 嵌套深度找配对的 `</div>`，返回其结束位置；不闭合返回 -1。 */
function matchingDivEnd(html: string, openAt: number): number {
  const divRe = /<(\/?)div\b[^>]*>/gi;
  divRe.lastIndex = openAt;
  let depth = 0;
  for (let tag = divRe.exec(html); tag; tag = divRe.exec(html)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return tag.index + tag[0].length;
  }
  return -1;
}

function removeDiv(html: string, className: string): string {
  const open = html.match(new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "i"));
  const end = open ? matchingDivEnd(html, open.index!) : -1;
  return open && end >= 0 ? html.slice(0, open.index) + html.slice(end) : html;
}

/**
 * 文章页正文提取（量子位 WordPress：`<div class="article">…</div>`）。
 * 先剔除注释/脚本/样式，按 div 深度配对取出正文容器，去掉容器内的标题、作者行与版权声明；
 * 再按文档顺序切段：块级标签分段、`<br>` 换行、源码空白折叠，段间用空行连接（与阅读器按空行分段一致）；
 * 配图只取容器内 https 图，after = 它所跟随段落在同一段落流里的索引。
 * 拿不到容器时返回空结果，由调用方诚实退回 feed 摘要。
 */
export function extractArticleContent(html: string): ArticleContent {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const container = clean.match(/<div[^>]*class="[^"]*\barticle\b[^"]*"[^>]*>/i);
  const end = container ? matchingDivEnd(clean, container.index!) : -1;
  if (!container || end < 0) return { text: "", images: [] };
  // 标题与卡片标题重复；作者/日期行、版权声明是版式，不是正文
  const body = removeDiv(removeDiv(clean.slice(container.index! + container[0].length, end).replace(/<h1\b[\s\S]*?<\/h1>/i, ""), "article_info"), "line_font");
  return paragraphsFromHtml(body);
}

/**
 * fullText outlet：逐条抓文章页提取全文与配图；失败或无正文时诚实退回 feed 摘要，不用抓取时间或标题冒充。
 * 先按量子位正文容器取；改版后找不到容器时退到通用提取，通用提取不足 200 字仍按失败处理。
 */
async function fetchFullText(
  fetchImpl: typeof fetch,
  url: string,
  title: string,
  signal: AbortSignal | undefined,
): Promise<ArticleContent> {
  const timeout = AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)" },
    });
    if (!response.ok) return { text: "", images: [] };
    const html = await response.text();
    const article = extractArticleContent(html);
    if (article.text) return article;
    const generic = extractReadableArticle(html, url, title);
    return generic.text.length >= ARTICLE_MIN_CHARS ? generic : { text: "", images: [] };
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
  const adapter: RadarOutletAdapter = {
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
          const atom = channel.kind === "atom";
          const blocks = channel.kind === "news-sitemap"
            ? text.match(/<url>[\s\S]*?<\/url>/g) ?? []
            : text.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/g : /<item[\s>][\s\S]*?<\/item>/g) ?? [];
          for (const block of blocks) {
            const title = tag(block, channel.kind === "news-sitemap" ? "news:title" : "title");
            const link = atom ? atomLink(block) : tag(block, channel.kind === "news-sitemap" ? "loc" : "link");
            const publishedAt = iso(atom
              ? tag(block, "published") || tag(block, "updated")
              : tag(block, channel.kind === "news-sitemap" ? "news:publication_date" : "pubDate"));
            // Reuters 的 news-sitemap 没有 description：excerpt 退回标题，并如实标注，不用正文抓取冒充
            const excerpt = (atom ? plainText(tag(block, "summary") || tag(block, "content")) : tag(block, "description")) || title;
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
            const full = signal?.aborted ? { text: "", images: [] } : await fetchFullText(fetchImpl, item.url, item.title, signal);
            if (full.text) {
              item.excerpt = full.text;
              if (full.images.length) item.images = full.images;
            }
            // 逐条记下原文是否真是全文：阅读页据此标「发布方原文」还是「原文摘录」，不再按目录推断
            if (item.sourceRef.type === "outlet") item.sourceRef.fullText = Boolean(full.text);
          }
        }
        items.push(...picked);
      }
      return items;
    },
  };
  return {
    configured: adapter.configured,
    // 每次真实读取发布方 feed 一个 retrieve:outlet-feed 节点（雷达、预研、对话共用）。
    fetchLatest: (input, signal) => withRetrieve(RETRIEVE_SOURCES.outletFeed, () => input, () => adapter.fetchLatest(input, signal),
      (items) => ({ items: items.length })),
  };
}
