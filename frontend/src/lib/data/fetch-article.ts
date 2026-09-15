/**
 * 他贴进来的那个链接，去把正文取回来。
 *
 * ## 抓不到就照实说，不假装抓到了
 *
 * 这个文件里绝大部分代码是为了**抓不到的那些情况**写的：付费墙、要登录、纯 JS 渲染的
 * 页面、PDF、抓回来一堆导航文字。每一种都得答得出「为什么这张卡上没有正文」，因为屏幕
 * 上要把那句话写出来（`Card.materialNote`）。一个只处理成功路径的抓取器，在失败时会给
 * 一张看起来正常、只是正文碰巧很短的卡 —— 而那份短正文接着会被喂进预研。
 *
 * ## 抽出来的正文是粗抽的，这件事要写在屏幕上
 *
 * 下面那套 `htmlToText` 是删标签加换行，不是 Readability。它会带上「首页 / 登录 / 相关
 * 阅读」这类边栏文字。换成真的正文抽取要拖一个依赖进来（jsdom + readability 是 ~10MB），
 * 而这一版的用法是「一号位随手贴一篇他读到的东西」—— 他自己知道那是什么，参谋读到几句
 * 导航文字不会改变判断。代价必须写在屏幕上，不能省的是那一句交代。
 *
 * ## 为什么要防内网
 *
 * 这个入口拿的是一个**任意 URL**，然后在服务端发请求。不挡的话，`http://127.0.0.1:3000`
 * 或者云上的元信息地址就成了一条从浏览器打到内网的通道。挡法有两层：URL 里的主机名，
 * 和它解析出来的地址。两层都过了才发请求。
 */
import { lookup } from "node:dns/promises";

/** 抓回来的正文，或者一句「为什么没抓到」。 */
export type ArticleFetch =
  | { ok: true; host: string; title: string | null; body: string }
  | { ok: false; host: string; why: string };

/** 整段输入就是一个链接（前后可以有空白，中间不能有别的话）。 */
export const looksLikeUrl = (raw: string): boolean => /^https?:\/\/\S+$/i.test(raw.trim());

/** 六秒。他在等这一下 —— 一个抓十五秒才回来的链接，不如告诉他没抓到。 */
const TIMEOUT_MS = 6000;
/** 2MB。超过这个数的 HTML 里，正文占的比例低到抽出来也没用。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 跳三次。再多是在被人牵着走。 */
const MAX_HOPS = 3;

/**
 * 这个主机名指向内网吗。
 *
 * 两件事分开看：字面上就能认出来的（localhost、10.x、没有点的内网机器名），和要解析
 * 一次才知道的（一个正常域名 A 记录指到 127.0.0.1）。后者解析完再核一次 —— 中间那点
 * 时间差理论上还能被换掉（DNS rebinding），但要堵住它得自己拿 IP 建连接，那不是这一版
 * 该背的复杂度。这里挡的是「一条 URL 就能读到内网」，不是一个有备而来的攻击者。
 */
const isPrivateAddress = (h: string): boolean => {
  const host = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  // 没有点的主机名只在内网里解析得出来（`http://gitlab/`）。
  if (!host.includes(".") && !host.includes(":")) return true;

  // IPv6：回环、链路本地（fe80::/10）、唯一本地（fc00::/7）。
  if (host === "::1" || host === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // 链路本地，云上的元信息地址在这一段
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // 组播和保留段
  }
  return false;
};

/** 解析一次，看它落到哪个地址上。解析不出来当成不安全 —— 抓不到本来也是要照实说的。 */
const resolvesToPrivate = async (host: string): Promise<boolean> => {
  if (isPrivateAddress(host)) return true;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    return true;
  }
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "「",
  rdquo: "」",
  lsquo: "'",
  rsquo: "'",
};

const decodeEntities = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });

/**
 * HTML → 纯文本。粗抽，见文件头。
 *
 * 顺序有讲究：先整段删掉不出声的元素（script / style / 以及 nav、footer 这些成段的
 * 边栏），再把块级标签的收尾换成空行 —— 换行必须在删标签**之前**做，否则「一段的结尾」
 * 这个信息就没了，抽出来是一堵没有段落的墙，而预研那一头要靠空行分段。
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|figcaption|td)\s*>/gi, "\n\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** `<title>`，取不到退到第一个 `<h1>`。两个都没有就是 null —— 不从 URL 反推一个。 */
const pickTitle = (html: string): string | null => {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const clean = (v: string) => decodeEntities(v.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  const out = t ? clean(t) : h1 ? clean(h1) : "";
  return out.length > 0 ? out.slice(0, 120) : null;
};

/**
 * 一个 URL → 正文。**不抛** —— 抓不到是这个函数的正常返回值之一，而不是异常：
 * 立案不能因为一个链接打不开就失败（他要提的那件事和那个链接能不能打开是两回事）。
 */
export async function fetchArticle(raw: string): Promise<ArticleFetch> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, host: "", why: "这不是一个能打开的链接。" };
  }
  const host = url.hostname;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, host, why: `只会去打开 http / https 的链接，这条是 ${url.protocol.replace(":", "")}。` };
  }

  let res: Response;
  let hops = 0;
  for (;;) {
    if (await resolvesToPrivate(url.hostname)) {
      return { ok: false, host: url.hostname, why: "这个地址指向内网，参谋不去打开它。" };
    }
    try {
      res = await fetch(url, {
        // 自己跳，每跳之前把上面那两层再核一遍 —— 交给 fetch 自动跳的话，第一跳
        // 是公网、第二跳进内网这种情况就漏过去了。
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // 照实说自己是谁。伪装成浏览器 UA 是在绕对方的规则，不是在读一篇文章。
          "user-agent": "ClarkAgent/1.0 (+一号位贴进来的链接)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.8",
        },
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return {
        ok: false,
        host: url.hostname,
        why: timedOut ? `这个链接 ${TIMEOUT_MS / 1000} 秒没有响应。` : "打不开这个链接。",
      };
    }

    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) break;
    if (++hops > MAX_HOPS) return { ok: false, host: url.hostname, why: "这个链接一直在跳转。" };
    try {
      url = new URL(to, url);
    } catch {
      return { ok: false, host: url.hostname, why: "这个链接跳到了一个打不开的地址。" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, host: url.hostname, why: "这个链接跳到了一个不是网页的地址。" };
    }
  }

  if (!res.ok) {
    // 401/403 单独说：他自己打开是能看的（浏览器里带着登录态），所以「打不开」这句话
    // 在他那边说不通，得说清是哪一种打不开。
    const why =
      res.status === 401 || res.status === 403
        ? "这个链接要登录才看得到，参谋没有登录态。"
        : res.status === 404
          ? "这个链接是 404。"
          : `对方返回 HTTP ${res.status}。`;
    return { ok: false, host: url.hostname, why };
  }

  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = type.includes("html") || type.includes("xml");
  const isText = type.startsWith("text/") || type.includes("json");
  if (!isHtml && !isText) {
    // PDF 是最常撞到的那一种，所以点名。
    const kind = type.split(";")[0] || "未知类型";
    return { ok: false, host: url.hostname, why: `这个链接是 ${kind}，这一版只读网页和纯文本。` };
  }

  const raw8 = await res.arrayBuffer();
  const truncatedBytes = raw8.byteLength > MAX_BYTES;
  const text = new TextDecoder("utf-8").decode(
    truncatedBytes ? raw8.slice(0, MAX_BYTES) : raw8
  );
  const body = isHtml ? htmlToText(text) : text.trim();

  // 抓回来了，但里面没有几个字 —— 通常是纯 JS 渲染的页面或者付费墙。这一种最要
  // 说清楚：不说的话屏幕上就是一张正文只有两行的卡，看不出那两行不是全文。
  if (body.length < 120) {
    return {
      ok: false,
      host: url.hostname,
      why: "这个链接打开了，但页面里取不到成段的正文（可能是要登录，或者正文由脚本渲染）。",
    };
  }

  return { ok: true, host: url.hostname, title: pickTitle(text), body };
}
