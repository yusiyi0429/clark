import { describe, expect, it } from "vitest";
import {
  createArticleFetcher,
  decodeHtmlBytes,
  extractReadableArticle,
  fetchArticles,
  fullTextKeepsQuotes,
  looksLikePaywall,
} from "../src/articleText.js";
import { isFullTextSource } from "../src/signals.js";

const PARAGRAPHS = [
  "某云厂商今天宣布下调企业版大模型调用价格，输入价格降到每百万词元 0.8 元，输出价格降到每百万词元 2 元，降幅超过六成。",
  "公司表示，此次调价覆盖全部企业客户，已签年框的客户按新价格自动结算，不需要重新签约，也不影响已承诺的服务等级。",
  "分析人士认为，这一轮降价会迫使同行跟进，中小模型厂商的利润空间将被进一步压缩，行业可能进入新一轮价格竞争。",
  "该公司同时披露，下季度将开放私有化部署版本，面向金融、政务等对数据合规要求较高的行业，首批试点客户已经确定。",
];

/** 新闻页样张：导航、侧栏推荐、页脚都在正文外；正文里一张相对地址的图、一张 http 图、一个图标、一张懒加载图。 */
function newsPage(charsetMeta = '<meta charset="utf-8">') {
  return `<!doctype html><html><head>${charsetMeta}<title>企业版大模型降价六成 - 示例新闻</title>
<script>window.track = "广告脚本";</script><style>.x{color:red}</style></head>
<body>
<header><nav><a href="/">首页</a> <a href="/tech">科技</a> <a href="/finance">财经</a> <a href="/login">登录</a></nav></header>
<div class="layout">
  <main><article class="post">
    <h1>企业版大模型降价六成</h1>
    <p>${PARAGRAPHS[0]}</p>
    <p><img src="/uploads/2026/price-chart.jpg" width="800" height="450" alt="价格对比"></p>
    <p>${PARAGRAPHS[1]}</p>
    <p><img src="http://insecure.example.com/plain.jpg" width="800"><img src="https://static.example.com/share-icon.png" width="24" height="24"></p>
    <p>${PARAGRAPHS[2]}<br>记者 张三</p>
    <figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://img.example.com/lazy/booth.jpg" width="900"></figure>
    <p>${PARAGRAPHS[3]}</p>
  </article></main>
  <aside class="sidebar"><h3>热门文章</h3><ul><li><a href="/a">别的新闻一</a></li><li><a href="/b">别的新闻二</a></li></ul></aside>
</div>
<footer><p>版权所有 © 示例新闻网 京ICP备00000000号</p></footer>
</body></html>`;
}

/** 手写的 GBK 字节：「中文雷达」= D6D0 CEC4 C0D7 B4EF，「。」= A1A3。 */
const GBK_SENTENCE = [0xd6, 0xd0, 0xce, 0xc4, 0xc0, 0xd7, 0xb4, 0xef, 0xa1, 0xa3];
function gbkPage(meta: string): Uint8Array {
  const ascii = (text: string) => [...Buffer.from(text, "ascii")];
  const paragraph = [...ascii("<p>"), ...Array.from({ length: 30 }, () => GBK_SENTENCE).flat(), ...ascii("</p>")];
  return Uint8Array.from([
    ...ascii(`<html><head>${meta}<title>t</title></head><body><article>`),
    ...paragraph, ...paragraph, ...paragraph,
    ...ascii("</article></body></html>"),
  ]);
}

const htmlResponse = (body: string | Uint8Array, init: { status?: number; type?: string; headers?: Record<string, string> } = {}) =>
  new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...init.headers } });

describe("通用正文提取 extractReadableArticle", () => {
  it("只留正文段落：去掉导航、侧栏、页脚和与标题重复的 h1；段间空一行，段内 <br> 换行", () => {
    const { text } = extractReadableArticle(newsPage(), "https://news.example.com/2026/10/price.html", "企业版大模型降价六成");
    const paragraphs = text.split(/\n{2,}/);
    expect(paragraphs[0]).toBe(PARAGRAPHS[0]);
    expect(paragraphs).toContain(PARAGRAPHS[3]);
    expect(paragraphs).toContain(`${PARAGRAPHS[2]}\n记者 张三`);
    for (const junk of ["首页", "热门文章", "别的新闻", "版权所有", "广告脚本", "color:red", "企业版大模型降价六成"]) {
      expect(text).not.toContain(junk);
    }
  });

  it("配图：相对地址按原文页补全为 https，懒加载取 data-src；http 图、图标、data: 占位不要；位置对齐段落", () => {
    const { text, images } = extractReadableArticle(newsPage(), "https://news.example.com/2026/10/price.html");
    const paragraphs = text.split(/\n{2,}/);
    expect(images).toEqual([
      { src: "https://news.example.com/uploads/2026/price-chart.jpg", after: paragraphs.indexOf(PARAGRAPHS[0]) },
      { src: "https://img.example.com/lazy/booth.jpg", after: paragraphs.indexOf(`${PARAGRAPHS[2]}\n记者 张三`) },
    ]);
  });

  it("正文 10,000 字截断，配图不超过 12 张、截断段落之后的图不保留", () => {
    const long = Array.from({ length: 40 }, (_, index) => `<p>${"长".repeat(400)}${index}</p><img src="https://img.example.com/${index}.jpg" width="800">`).join("");
    const { text, images } = extractReadableArticle(`<html><body><article>${long}</article></body></html>`, "https://news.example.com/a");
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(images.length).toBeLessThanOrEqual(12);
    const kept = text.split(/\n{2,}/).length;
    expect(images.every((image) => image.after < kept)).toBe(true);
  });

  it("页面没有正文时提取结果不足 200 字，抓取方据此判为失败", () => {
    expect(extractReadableArticle("<html><body><nav>首页</nav></body></html>", "https://news.example.com/a").text.length).toBeLessThan(200);
    expect(extractReadableArticle("", "https://news.example.com/a").text).toBe("");
  });
});

describe("编码与登录墙", () => {
  it("GBK 页面：meta charset 与 Content-Type charset 都能正确解码", () => {
    expect(decodeHtmlBytes(gbkPage('<meta charset="gbk">'))).toContain("中文雷达。");
    expect(decodeHtmlBytes(gbkPage('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'))).toContain("中文雷达。");
    expect(decodeHtmlBytes(gbkPage(""), "text/html; charset=GBK")).toContain("中文雷达。");
    // 不认识的 charset 退回 UTF-8，不抛错
    expect(decodeHtmlBytes(new TextEncoder().encode("<meta charset=\"x-unknown\"><p>中文</p>"))).toContain("中文");
  });

  it("短正文里出现登录 / 付费字样判为墙；长文偶尔提到不算", () => {
    expect(looksLikePaywall("本文为付费内容，登录后查看全文。")).toBe(true);
    expect(looksLikePaywall("Subscribe to continue reading this article.")).toBe(true);
    expect(looksLikePaywall(`${"正文".repeat(2000)}开通会员`)).toBe(false);
    expect(looksLikePaywall(PARAGRAPHS.join("\n\n"))).toBe(false);
  });
});

describe("原文页抓取 createArticleFetcher", () => {
  it("抓到 GBK 新闻页：按 meta charset 解码后提取全文", async () => {
    const fetcher = createArticleFetcher({ fetch: (async () => htmlResponse(gbkPage('<meta charset="gbk">'), { type: "text/html" })) as typeof fetch });
    const article = await fetcher("https://news.example.com/gbk.html");
    expect(article?.text).toContain("中文雷达。中文雷达。");
  });

  it("跟随跳转并逐跳复核；跳到内网、非 HTML、HTTP 错误、正文过短、登录墙、登录页一律返回 null", async () => {
    const pages: Record<string, () => Response> = {
      "https://news.example.com/moved": () => new Response(null, { status: 301, headers: { location: "/2026/10/price.html" } }),
      "https://news.example.com/2026/10/price.html": () => htmlResponse(newsPage()),
      "https://news.example.com/to-intranet": () => new Response(null, { status: 302, headers: { location: "http://10.0.0.8/admin" } }),
      "https://news.example.com/pdf": () => htmlResponse("%PDF-1.7", { type: "application/pdf" }),
      "https://news.example.com/gone": () => htmlResponse("not found", { status: 404 }),
      "https://news.example.com/short": () => htmlResponse("<html><body><article><p>只有一句话。</p></article></body></html>"),
      "https://news.example.com/paywall": () => htmlResponse(`<html><body><article><p>${"导语".repeat(60)}</p><p>本文为付费内容，登录后查看全文。</p></article></body></html>`),
      "https://news.example.com/to-login": () => new Response(null, { status: 302, headers: { location: "https://passport.example.com/login?next=/a" } }),
    };
    const asked: string[] = [];
    const fetcher = createArticleFetcher({
      fetch: (async (url: string | URL | globalThis.Request) => {
        asked.push(String(url));
        const page = pages[String(url)];
        if (!page) throw new Error(`unexpected fetch ${String(url)}`);
        return page();
      }) as typeof fetch,
    });
    const moved = await fetcher("https://news.example.com/moved");
    expect(moved?.text.split(/\n{2,}/)[0]).toBe(PARAGRAPHS[0]);
    expect(moved?.images[0].src).toBe("https://news.example.com/uploads/2026/price-chart.jpg");
    for (const url of ["/to-intranet", "/pdf", "/gone", "/short", "/paywall", "/to-login"]) {
      expect(await fetcher(`https://news.example.com${url}`)).toBeNull();
    }
    expect(await fetcher("http://127.0.0.1/a")).toBeNull();
    expect(await fetcher("ftp://news.example.com/a")).toBeNull();
    expect(asked).not.toContain("http://10.0.0.8/admin");
    expect(asked.some((url) => url.includes("passport.example.com") || url.startsWith("http://127.0.0.1") || url.startsWith("ftp:"))).toBe(false);
  });

  it("单页超时与外部中止：返回 null，不抛错", async () => {
    const hanging = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
    expect(await createArticleFetcher({ fetch: hanging, timeoutMs: 20 })("https://news.example.com/slow")).toBeNull();
    const abort = new AbortController();
    const pending = createArticleFetcher({ fetch: hanging, timeoutMs: 60_000 })("https://news.example.com/slow", { signal: abort.signal });
    abort.abort();
    expect(await pending).toBeNull();
  });

  it("fetchArticles：去重、每轮至多 15 篇，单篇失败不影响其他", async () => {
    const asked: string[] = [];
    const found = await fetchArticles(
      Array.from({ length: 20 }, (_, index) => ({ url: `https://news.example.com/${index}` })).concat({ url: "https://news.example.com/0" }),
      async (url) => {
        asked.push(url);
        if (url.endsWith("/3")) throw new Error("boom");
        return url.endsWith("/4") ? null : { text: `全文 ${url}`, images: [] };
      },
    );
    expect(asked).toHaveLength(15);
    expect(found.size).toBe(13);
    expect(found.has("https://news.example.com/3")).toBe(false);
  });

  it("全文必须不短于摘要且逐字包含全部引文，才可替换检索摘要", () => {
    const article = { text: PARAGRAPHS.join("\n\n"), images: [] };
    expect(fullTextKeepsQuotes("短摘要", article, ["输入价格降到每百万词元 0.8 元", "首批试点客户已经确定"])).toBe(true);
    expect(fullTextKeepsQuotes("短摘要", article, ["检索摘要里改写过的句子"])).toBe(false);
    expect(fullTextKeepsQuotes("长".repeat(article.text.length + 1), article, [])).toBe(false);
    expect(fullTextKeepsQuotes("短摘要", { text: "太短", images: [] }, [])).toBe(false);
    expect(fullTextKeepsQuotes("短摘要", undefined, [])).toBe(false);
  });
});

describe("isFullTextSource：逐条标记优先，旧行退回目录", () => {
  it("采集时记下的 fullText 说了算；没有标记的旧行只有目录标 fullText 的发布方（量子位）算全文", () => {
    expect(isFullTextSource({ type: "wechat-account", provider: "wechat-mcp", accountId: "a", accountName: "n", fullText: true })).toBe(true);
    expect(isFullTextSource({ type: "wechat-account", provider: "wechat-mcp", accountId: "a", accountName: "n" })).toBe(false);
    expect(isFullTextSource({ type: "web-search", provider: "bocha", query: "q", fullText: true })).toBe(true);
    expect(isFullTextSource({ type: "web-search", provider: "bocha", query: "q" })).toBe(false);
    // 量子位：本条抓取失败时明确记 false，不再被目录推断成全文；旧行没有标记仍按目录算全文
    expect(isFullTextSource({ type: "outlet", provider: "publisher-feed", outletId: "qbitai", outletName: "量子位", fullText: false })).toBe(false);
    expect(isFullTextSource({ type: "outlet", provider: "publisher-feed", outletId: "qbitai", outletName: "量子位" })).toBe(true);
    expect(isFullTextSource({ type: "outlet", provider: "publisher-feed", outletId: "bloomberg", outletName: "彭博" })).toBe(false);
    expect(isFullTextSource(null)).toBe(false);
  });
});
