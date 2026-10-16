import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { isLikelyCoverImage, isPublicHttpUrl } from "./signalCover.js";

/**
 * 原文正文：段落之间空一行（与阅读器按空行分段一致），配图按 after = 跟在第几段之后插入。
 * 上限与 RadarSourceItem 一致：正文 10,000 字、配图 12 张，图片只留 https 绝对地址。
 */
export type ArticleContent = { text: string; images: { src: string; after: number }[] };

export const ARTICLE_MAX_CHARS = 10_000;
export const ARTICLE_MAX_IMAGES = 12;
/** 正文少于这个字数多半是导航页、登录墙或提取失败，不当全文。 */
export const ARTICLE_MIN_CHARS = 200;
export const ARTICLE_FETCH_TIMEOUT_MS = 8_000;
/** 原文页只读前 3MB：再大的页面正文也基本在前段，超出部分截掉。 */
const ARTICLE_MAX_BYTES = 3_000_000;
/** 检索条目每轮扫描至多抓这么多篇原文页。 */
export const SEARCH_FULL_TEXT_LIMIT = 15;

const EMPTY: ArticleContent = { text: "", images: [] };
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷", middot: "·", bull: "•",
  mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»",
  yen: "¥", euro: "€", pound: "£", cent: "¢", sect: "§",
};

/** 单遍解码 HTML 实体：常用命名实体 + 十进制 `&#NNN;` + 十六进制 `&#xHH;`；不认识的原样保留，不二次解码。 */
export function decodeHtml(value: string): string {
  return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (entity, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name] ?? entity;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// section：转载自公众号的正文常把文字直接放在 <section> 里；其余是 Readability 输出里常见的块级容器
const BLOCK_TAG = /^<\/?(?:p|div|h[1-6]|li|blockquote|figcaption|section|article|figure|pre|ul|ol|table|tr|dd|dt|header|footer|main)\b/i;

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function pixels(value: string | undefined): number | undefined {
  const match = value?.match(/^\s*(\d+)(?:px)?\s*$/i);
  return match ? Number(match[1]) : undefined;
}

/** 配图地址：懒加载属性优先，相对地址按原文页补全；只留 https、≤1000 字符。 */
function imageSrc(tag: string, pageUrl: string | undefined): string | null {
  for (const name of ["data-src", "data-original", "data-actualsrc", "src"]) {
    const raw = attr(tag, name);
    if (!raw || /^\s*(?:data|javascript|blob):/i.test(raw)) continue;
    try {
      const url = new URL(decodeHtml(raw.trim()), pageUrl);
      const href = url.toString();
      return url.protocol === "https:" && href.length <= 1000 ? href : null;
    } catch {
      return null;
    }
  }
  return null;
}

const squash = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "");

/**
 * 正文 HTML 片段 → 段落流 + 按位配图。按文档顺序切段：块级标签分段、`<br>` 换行、源码空白折叠；
 * 图在段中时跟随当前段，否则跟随上一段。10k 截断后落在被截掉段落之后的配图不再保留。
 * `filterImages`：通用提取时去掉图标、头像、二维码、动图等版式图（量子位容器内的图原样保留）。
 * `dropTitles`：第一段与这些标题相同时去掉（标题已在卡片上）。
 */
export function paragraphsFromHtml(
  html: string,
  { pageUrl, filterImages = false, dropTitles = [] }: { pageUrl?: string; filterImages?: boolean; dropTitles?: (string | null | undefined)[] } = {},
): ArticleContent {
  const paragraphs: string[] = [];
  const images: { src: string; after: number }[] = [];
  const seen = new Set<string>();
  let current = "";
  const flush = () => {
    const paragraph = current.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
    if (paragraph) paragraphs.push(paragraph);
    current = "";
  };
  for (const [token] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (!token.startsWith("<")) current += decodeHtml(token.replace(/\s+/g, " "));
    else if (/^<br\b/i.test(token)) current += "\n";
    else if (BLOCK_TAG.test(token)) flush();
    else if (/^<img\b/i.test(token) && images.length < ARTICLE_MAX_IMAGES) {
      const src = imageSrc(token, pageUrl);
      if (!src || seen.has(src)) continue;
      if (filterImages && !isLikelyCoverImage(src, { width: pixels(attr(token, "width")), height: pixels(attr(token, "height")), alt: attr(token, "alt") })) continue;
      seen.add(src);
      images.push({ src, after: Math.max(0, paragraphs.length - (current.trim() ? 0 : 1)) });
    }
  }
  flush();
  // 页面 <title> 常带站名后缀（「标题 - 示例新闻」「标题_网易科技」）：去掉后缀再比
  const titles = new Set(dropTitles.flatMap((title) => [title, title?.split(/\s+[-|–—]\s+|_/)[0]]).map(squash).filter(Boolean));
  let shift = 0;
  if (paragraphs.length > 1 && titles.has(squash(paragraphs[0]))) {
    paragraphs.shift();
    shift = 1;
  }
  const text = paragraphs.join("\n\n").slice(0, ARTICLE_MAX_CHARS);
  const kept = text ? text.split(/\n{2,}/).length : 0;
  return {
    text,
    images: images.map((image) => ({ src: image.src, after: Math.max(0, image.after - shift) })).filter((image) => image.after < kept),
  };
}

/**
 * 通用正文提取（任意新闻 / 博客页）：linkedom 建 DOM，@mozilla/readability 找正文容器并清掉导航、推荐、页脚，
 * 再按 paragraphsFromHtml 切段取图。提取不到、页面过大或解析出错都返回空结果，由调用方诚实退回摘要。
 */
export function extractReadableArticle(html: string, pageUrl: string, title?: string): ArticleContent {
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  try {
    const { document } = parseHTML(cleaned);
    const article = new Readability(document as never, { charThreshold: 200, maxElemsToParse: 30_000, disableJSONLD: true }).parse();
    if (!article?.content) return EMPTY;
    return paragraphsFromHtml(article.content, { pageUrl, filterImages: true, dropTitles: [title, article.title] });
  } catch {
    return EMPTY;
  }
}

/** 登录墙 / 付费墙的常见字样：正文不长又出现这些字时，拿到的只是墙，不是全文。 */
const PAYWALL_HINT = /登录后(?:查看|阅读|可阅读|可查看)|登录查看全文|订阅后(?:查看|阅读)|付费(?:阅读|内容|订阅)|开通会员|会员专享|购买后(?:阅读|查看)|剩余\s*\d+%\s*未读|subscribe (?:now )?to (?:continue|read)|(?:sign|log) in to (?:continue|read)|for subscribers only|already a subscriber|create a free account to continue/i;
const LOGIN_PATH = /\/(?:login|signin|sign-in|sign_in|passport|sso)(?:[/?#.]|$)/i;

/** 正文像登录墙 / 付费墙：短正文里出现付费、登录字样。 */
export function looksLikePaywall(text: string): boolean {
  return text.length < 3_000 && PAYWALL_HINT.test(text);
}

/** 编码：Content-Type 的 charset 优先，其次页面前 4KB 的 `<meta charset>`；带 UTF-8 BOM 的按 UTF-8。国内站常见 gbk / gb2312。 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType = ""): string {
  let label = "utf-8";
  if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
    label = contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1]
      ?? head.match(/<meta\b[^>]*charset\s*=\s*["']?([\w.:-]+)/i)?.[1]
      ?? "utf-8";
  }
  try {
    return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, limit);
}

export type ArticleFetcher = (url: string, input?: { title?: string; signal?: AbortSignal }) => Promise<ArticleContent | null>;

/**
 * 抓原文页取全文：只抓公网 http(s)，跳转逐跳复核（最多 4 跳），单页超时、只读前 3MB、只认 HTML；
 * 正文少于 200 字、像登录墙 / 付费墙、落到登录页的一律返回 null。任何失败都只返回 null，不抛错。
 */
export function createArticleFetcher({
  fetch: fetchImpl = fetch,
  timeoutMs = ARTICLE_FETCH_TIMEOUT_MS,
  maxBytes = ARTICLE_MAX_BYTES,
}: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}): ArticleFetcher {
  return async (url, { title, signal } = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      let target = url;
      for (let hop = 0; hop <= 4; hop += 1) {
        if (!isPublicHttpUrl(target) || LOGIN_PATH.test(new URL(target).pathname)) return null;
        const response = await fetchImpl(target, {
          signal: combined,
          redirect: "manual",
          headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml", "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          const location = response.headers.get("location");
          if (!location) return null;
          target = new URL(location, target).toString();
          continue;
        }
        const type = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!response.ok || !/html/.test(type)) {
          await response.body?.cancel().catch(() => undefined);
          return null;
        }
        const html = decodeHtmlBytes(await readLimited(response, maxBytes), type);
        const article = extractReadableArticle(html, target, title);
        if (article.text.length < ARTICLE_MIN_CHARS || looksLikePaywall(article.text)) return null;
        return article;
      }
      return null;
    } catch {
      return null;
    }
  };
}

/** 并发抓一组原文页（去重、至多 limit 篇）；单篇失败不影响其他，返回 url → 全文。 */
export async function fetchArticles(
  pages: { url: string; title?: string }[],
  fetcher: ArticleFetcher,
  { limit = SEARCH_FULL_TEXT_LIMIT, concurrency = 4, signal }: { limit?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<Map<string, ArticleContent>> {
  const found = new Map<string, ArticleContent>();
  const queue = [...new Map(pages.map((page) => [page.url, page])).values()].slice(0, limit);
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const page = queue.shift()!;
      const article = await fetcher(page.url, { title: page.title, signal }).catch(() => null);
      if (article?.text) found.set(page.url, article);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return found;
}

/**
 * 检索条目能不能换成全文：全文不短于检索摘要（也不少于 200 字），并且逐字包含研判时引用的每一句原文。
 * 引文是模型对着检索摘要选出来的；全文里找不到同一句就保留摘要，保证 evidenceQuote 始终是原文的子串。
 */
export function fullTextKeepsQuotes(summary: string, article: ArticleContent | undefined, quotes: string[]): article is ArticleContent {
  return Boolean(article)
    && article!.text.length >= Math.max(ARTICLE_MIN_CHARS, summary.length)
    && quotes.every((quote) => article!.text.includes(quote));
}
