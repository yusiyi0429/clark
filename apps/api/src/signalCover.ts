import { isIP } from "node:net";

/**
 * 信号封面图：采集时给没有配图的来源补一张原文封面（像刷公众号那样，卡片上有图）。
 * 顺序：检索服务返回的图片 → 原文页 og:image / twitter:image / 公众号 msg_cdn_url → 正文容器里的首图。
 * 只认 http(s) 绝对地址（相对地址按原文页补全后再判）；站点 logo、图标、头像、二维码、跟踪像素和过小的图一律不要。
 * 抓取有超时、失败只是没有图，绝不影响信号入库。
 */

export const COVER_FETCH_TIMEOUT_MS = 4_000;
/** 原文页只读前 1.5MB：meta 都在 head 里，正文首图也基本在前段。 */
const MAX_PAGE_BYTES = 1_500_000;
/** 宽或高小于这个像素的图不当封面（图标、头像、分享按钮）。 */
const MIN_COVER_SIDE = 200;

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 地址里带这些词的多半是版式图：logo、图标、头像、二维码、占位/默认分享图、跟踪像素。 */
const NON_CONTENT_HINT = /(?:^|[^a-z])(?:logo|logos|icon|icons|favicon|sprite|avatar|headimg|head_img|portrait|qrcode|qr_code|placeholder|default|blank|spacer|pixel|tracking|beacon|transparent|loading|emoji|badge|share-icon|weixinfixed)(?:[^a-z]|$)|1x1|\/f2e\//i;
const NON_CONTENT_ALT = /头像|logo|图标|二维码|icon|avatar/i;
const BAD_EXTENSION = /\.(?:svg|ico|gif)(?:$|[?#])|wx_fmt=gif|[?&]type=gif\b/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** 内网、本机与保留地址不抓：原文页和图片地址都来自外部网页，不能被拿来探内网。 */
export function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  } else if (kind === 6) {
    if (host === "::1" || host === "::" || /^(?:fc|fd|fe80)/.test(host) || host.startsWith("::ffff:")) return false;
  } else if (!host.includes(".")) {
    return false;
  }
  return true;
}

/** 把候选地址补成绝对地址：只接受 http(s)（协议相对地址跟随原文页协议）。 */
function absolute(raw: string, pageUrl: string): string | null {
  const value = decodeEntities(raw.trim());
  if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return null;
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const href = url.toString();
    return href.length <= 1000 ? href : null;
  } catch {
    return null;
  }
}

/** 封面过滤：版式图、矢量/动图、明确标了小尺寸的图都不要。 */
export function isLikelyCoverImage(src: string, size: { width?: number; height?: number; alt?: string } = {}): boolean {
  if (!isPublicHttpUrl(src)) return false;
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 地址里有不成对的 %：按原样判断
  }
  if (NON_CONTENT_HINT.test(decoded) || BAD_EXTENSION.test(decoded)) return false;
  if (size.alt && NON_CONTENT_ALT.test(size.alt)) return false;
  if (size.width !== undefined && size.width > 0 && size.width < MIN_COVER_SIDE) return false;
  if (size.height !== undefined && size.height > 0 && size.height < MIN_COVER_SIDE) return false;
  if (size.width === 1 || size.height === 1) return false;
  return true;
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function pixels(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^\s*(\d+)(?:px)?\s*$/i);
  return match ? Number(match[1]) : undefined;
}

/** style="width:30px;height:30px" 这类内联尺寸。 */
function styleSize(style: string | undefined, prop: "width" | "height"): number | undefined {
  const match = style?.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`, "i"));
  return match ? Number(match[1]) : undefined;
}

/** 这些容器里的图才算「正文首图」；页面其他位置（推荐流、作者卡、导航）的图不当封面。 */
const ARTICLE_CONTAINER = /<(?:article|div|section)\b[^>]*(?:\bid\s*=\s*["'](?:js_content|content|article|article-content|artibody|main-content)["']|\bclass\s*=\s*["'][^"']*\b(?:rich_media_content|article-content|article_content|article-body|article_body|articleContent|post_body|post-content|post_content|entry-content|content-article|art_content|news-content|news_content|detail-content|text-content)\b[^"']*["'])[^>]*>/i;

/**
 * 从原文页 HTML 里挑封面：meta（og:image、twitter:image、itemprop=image、image_src）→ 公众号 msg_cdn_url → 正文容器首图。
 * 每个候选都过 isLikelyCoverImage，站点默认分享图（例如网易的 weixinfixed 占位）会被跳过，继续看下一个候选。
 */
export function extractCoverImage(html: string, pageUrl: string): string | null {
  const head = html.replace(/<!--[\s\S]*?-->/g, "");
  const metas: { src: string; width?: number; height?: number }[] = [];
  let metaWidth: number | undefined;
  let metaHeight: number | undefined;
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop") ?? "").toLowerCase();
    const content = attr(tag, "content");
    if (!content) continue;
    if (key === "og:image:width") metaWidth = pixels(content);
    else if (key === "og:image:height") metaHeight = pixels(content);
    else if (["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src", "image"].includes(key)) {
      const src = absolute(content, pageUrl);
      if (src) metas.push({ src });
    }
  }
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(tag, "rel") ?? "").toLowerCase() !== "image_src") continue;
    const src = absolute(attr(tag, "href") ?? "", pageUrl);
    if (src) metas.push({ src });
  }
  // og:image:width/height 描述的是 og:image 本身
  if (metas[0]) Object.assign(metas[0], { width: metaWidth, height: metaHeight });
  const wechat = head.match(/var\s+msg_cdn_url\s*=\s*["']([^"']+)["']/);
  if (wechat) {
    const src = absolute(wechat[1], pageUrl);
    if (src) metas.push({ src });
  }
  for (const meta of metas) {
    if (isLikelyCoverImage(meta.src, meta)) return meta.src;
  }

  const body = head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, "");
  const container = body.match(ARTICLE_CONTAINER);
  if (!container) return null;
  const start = container.index! + container[0].length;
  const scope = body.slice(start, containerEnd(body, start, container[0].match(/^<(\w+)/)![1]));
  let checked = 0;
  for (const [tag] of scope.matchAll(/<img\b[^>]*>/gi)) {
    if (++checked > 20) break;
    const raw = attr(tag, "data-src") ?? attr(tag, "data-original") ?? attr(tag, "data-actualsrc") ?? attr(tag, "src");
    const src = raw ? absolute(raw, pageUrl) : null;
    if (!src) continue;
    const style = attr(tag, "style");
    if (style && /display\s*:\s*none/i.test(style)) continue;
    const size = {
      width: pixels(attr(tag, "width")) ?? pixels(attr(tag, "data-w")) ?? styleSize(style, "width"),
      height: pixels(attr(tag, "height")) ?? pixels(attr(tag, "data-h")) ?? styleSize(style, "height"),
      alt: attr(tag, "alt"),
    };
    if (isLikelyCoverImage(src, size)) return src;
  }
  return null;
}

/** 正文容器的闭合位置：按同名标签深度配对；配不上就当没有正文容器（返回 start，范围为空）。 */
function containerEnd(html: string, start: number, tag: string): number {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return start;
}

/** 按字节上限读响应正文；超出就截断（meta 在前面，截断不影响判断）。 */
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  // 图片地址是 ASCII：GBK 页面按 UTF-8 解码也不影响地址本身
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, limit));
}

export type CoverImageFetcher = (pageUrl: string, signal?: AbortSignal) => Promise<string | null>;

/** 抓原文页取封面；超时、非 HTML、HTTP 错误、网络错误都只返回 null。 */
export function createCoverImageFetcher({
  fetch: fetchImpl = fetch,
  timeoutMs = COVER_FETCH_TIMEOUT_MS,
}: { fetch?: typeof fetch; timeoutMs?: number } = {}): CoverImageFetcher {
  return async (pageUrl, signal) => {
    if (!isPublicHttpUrl(pageUrl)) return null;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(pageUrl, {
        signal: combined,
        redirect: "follow",
        headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const type = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (type && !type.includes("html")) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const html = await readLimited(response, MAX_PAGE_BYTES);
      return extractCoverImage(html, response.url || pageUrl);
    } catch {
      return null;
    }
  };
}

/** 并发取一组原文页的封面；单个失败不影响其他。 */
export async function fetchCovers(
  urls: string[],
  fetcher: CoverImageFetcher,
  { concurrency = 4, signal }: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<Map<string, string>> {
  const covers = new Map<string, string>();
  const queue = [...new Set(urls)];
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const url = queue.shift()!;
      const cover = await fetcher(url, signal).catch(() => null);
      if (cover) covers.set(url, cover);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return covers;
}

/** 图片代理接受的类型；SVG 不代理（可带脚本）。 */
const PROXY_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
export const PROXY_IMAGE_LIMIT = 8 * 1024 * 1024;
export const PROXY_FETCH_TIMEOUT_MS = 8_000;

/** CDN 偶尔回 application/octet-stream：按文件头认出常见位图格式。 */
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export type ProxiedImage =
  | { ok: true; type: string; body: Buffer }
  | { ok: false; status: 404 | 413 | 502; message: string };

/**
 * 图片代理的抓取：国内站多有 Referer 防盗链，先带原文页做 Referer，被拒（403/404 等）再不带 Referer 重试一次。
 * 只返回位图，限制大小，带超时。调用方只能传 source_images 里登记过的地址。
 */
export async function fetchProxiedImage(
  imageUrl: string,
  referer: string,
  { fetch: fetchImpl = fetch, timeoutMs = PROXY_FETCH_TIMEOUT_MS, limit = PROXY_IMAGE_LIMIT }: { fetch?: typeof fetch; timeoutMs?: number; limit?: number } = {},
): Promise<ProxiedImage> {
  if (!isPublicHttpUrl(imageUrl)) return { ok: false, status: 404, message: "原文图片不存在" };
  const attempt = async (withReferer: boolean): Promise<Response | null> => {
    try {
      return await fetchImpl(imageUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": BROWSER_UA,
          accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
          ...(withReferer && isPublicHttpUrl(referer) ? { referer } : {}),
        },
      });
    } catch {
      return null;
    }
  };
  let source = await attempt(true);
  if (!source || !source.ok) {
    await source?.body?.cancel().catch(() => undefined);
    source = await attempt(false);
  }
  if (!source) return { ok: false, status: 502, message: "原文图片抓取失败" };
  if (!source.ok) {
    await source.body?.cancel().catch(() => undefined);
    return { ok: false, status: 502, message: "原文图片不可用" };
  }
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await source.body?.cancel().catch(() => undefined);
    return { ok: false, status: 413, message: "原文图片过大" };
  }
  const reader = source.body?.getReader();
  if (!reader) return { ok: false, status: 502, message: "原文图片读取失败" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, message: "原文图片过大" };
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, status: 502, message: "原文图片读取失败" };
  }
  const body = Buffer.concat(chunks);
  const declaredType = source.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const type = PROXY_IMAGE_TYPES.has(declaredType) ? declaredType : sniffImageType(body);
  if (!type) return { ok: false, status: 502, message: "原文图片不可用" };
  return { ok: true, type, body };
}
