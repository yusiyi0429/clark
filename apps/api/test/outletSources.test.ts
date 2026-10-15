import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { RadarSources, RADAR_OUTLETS, type TRadarSourceItem } from "@warmap/contracts";
import { createOutletFeedAdapter, extractArticleContent, resolveConfiguredOutletIds } from "../src/outletSources.js";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title> <![CDATA[Nvidia quarterly results beat forecasts]]></title>
  <link>https://www.ft.com/content/aaa</link>
  <pubDate>Mon, 15 Sep 2026 09:00:00 GMT</pubDate>
  <description><![CDATA[Chipmaker reported revenue above consensus.]]></description></item>
<item><title><![CDATA[Old story outside window]]></title>
  <link>https://www.ft.com/content/bbb</link>
  <pubDate>Tue, 01 Jan 2019 09:00:00 GMT</pubDate>
  <description><![CDATA[stale]]></description></item>
<item><title><![CDATA[Impostor: same name, different publisher]]></title>
  <link>https://www.cnbctv18.com/markets/ccc</link>
  <pubDate>Mon, 15 Sep 2026 10:00:00 GMT</pubDate>
  <description><![CDATA[licenced outlet, must be rejected]]></description></item>
<item><title><![CDATA[Subdomain should be owned]]></title>
  <link>https://ftalphaville.ft.com/2026/09/15/ddd</link>
  <pubDate>Mon, 15 Sep 2026 11:00:00 GMT</pubDate>
  <description><![CDATA[FT Alphaville note]]></description></item>
</channel></rss>`;

const NEWS_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://www.reuters.com/business/energy/aramco-boost-exports-2026-09-15/</loc>
  <news:publication_date>2026-09-15T07:06:07.592Z</news:publication_date>
  <news:title><![CDATA[Aramco to boost exports from Strait of Hormuz to 60 million bbl]]></news:title></url>
<url><loc>https://not-reuters.example.com/copy</loc>
  <news:publication_date>2026-09-15T08:00:00.000Z</news:publication_date>
  <news:title><![CDATA[Impostor domain]]></news:title></url>
</urlset>`;

const WINDOW_HOURS = 168;
// fixture 的时间是固定的绝对时间；把 adapter 时钟钉在同一天，否则时间窗会随真实日历漂移出窗口。
const FIXED_NOW = Date.parse("2026-09-21T12:00:00Z");

function adapter(rss = RSS, sitemap = NEWS_SITEMAP, limit?: number) {
  return createOutletFeedAdapter({
    ...(limit === undefined ? {} : { limit }),
    now: () => FIXED_NOW,
    fetch: (async (url: string | URL | globalThis.Request) => {
      const target = String(url);
      const body = target.includes("ft.com") ? rss : target.includes("reuters.com") ? sitemap : "";
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as typeof fetch,
  });
}

function sourceType(items: TRadarSourceItem[]) {
  return items.map((item) => item.sourceRef.type === "outlet" ? item : null);
}

describe("发布方级来源 outlets", () => {
  it("radar_config 现有旧行（无 outlets 字段）必须继续通过契约校验，否则整个 Radar 停摆", () => {
    const legacy = {
      sites: [{ id: "site-web-all", name: "全网", enabled: true }],
      wechatAccounts: [],
    };
    expect(Value.Check(RadarSources, legacy)).toBe(true);
    expect(Value.Check(RadarSources, {
      ...legacy,
      outlets: [{ id: "outlet-finance", name: "全球财经媒体", enabled: true, outlets: ["ft", "reuters"] }],
    })).toBe(true);
    expect(Value.Check(RadarSources, {
      ...legacy,
      outlets: [{ id: "bad", name: "bad", enabled: true, outlets: [] }],
    })).toBe(false);
  });

  it("白名单目录：9 家，每家都配了渠道；量子位标记全文抓取", () => {
    expect(RADAR_OUTLETS.map((outlet) => outlet.outletId)).toEqual([
      "bbc", "wsj", "bloomberg", "reuters", "ft", "cnbc", "economist", "qbitai", "theinformation",
    ]);
    expect(RADAR_OUTLETS.find((outlet) => outlet.outletId === "qbitai")?.fullText).toBe(true);
    for (const outlet of RADAR_OUTLETS) {
      expect(outlet.articleDomains.length).toBeGreaterThan(0);
      expect(outlet.channels.length).toBeGreaterThan(0);
    }
  });

  it("只解析当前配置中启用的白名单 outletId", () => {
    const sources = {
      sites: [],
      wechatAccounts: [],
      outlets: [{ id: "global-finance", name: "全球财经媒体", enabled: true, outlets: ["bbc", "ft"] }],
    };
    expect(resolveConfiguredOutletIds(sources)).toEqual(["bbc", "ft"]);
    expect(resolveConfiguredOutletIds(sources, ["ft"])).toEqual(["ft"]);
    expect(() => resolveConfiguredOutletIds(sources, ["reuters"])).toThrow("not enabled");
    expect(() => resolveConfiguredOutletIds({ ...sources, outlets: [{ ...sources.outlets[0], outlets: ["fake"] }] })).toThrow("unknown outletId");
  });

  it("抓取后做归属校验、时间窗过滤与单家上限", async () => {
    const runtime = adapter();
    const items = await runtime.fetchLatest({ outletIds: ["ft", "reuters"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    const outlets = sourceType(items);
    expect(outlets.every((item) => item !== null)).toBe(true);

    const urls = items.map((item) => item.url);
    // 归属：真 ft.com、子域 ftalphaville.ft.com、真 reuters.com 都收
    expect(urls).toContain("https://www.ft.com/content/aaa");
    expect(urls).toContain("https://ftalphaville.ft.com/2026/09/15/ddd");
    expect(urls).toContain("https://www.reuters.com/business/energy/aramco-boost-exports-2026-09-15/");
    // 被许可方 / 仿冒域名必须拒收
    expect(urls.some((url) => url.includes("cnbctv18.com"))).toBe(false);
    expect(urls.some((url) => url.includes("not-reuters.example.com"))).toBe(false);
    // 窗口外的旧条目必须丢弃
    expect(urls.some((url) => url.includes("/bbb"))).toBe(false);
    // 每家一个 sourceRef，且 outletName 是中文名
    expect(items.find((item) => item.url.includes("/aaa"))?.sourceRef).toMatchObject({
      type: "outlet", provider: "publisher-feed", outletId: "ft", outletName: "金融时报",
    });
  });

  it("Reuters 无 description 时 excerpt 退回标题（如实标注，不用抓取冒充）", async () => {
    const items = await adapter().fetchLatest({ outletIds: ["reuters"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    const reuters = items.find((item) => item.url.includes("aramco"));
    expect(reuters?.excerpt).toBe("Aramco to boost exports from Strait of Hormuz to 60 million bbl");
    expect(reuters?.sourceRef).toMatchObject({ type: "outlet", outletId: "reuters", outletName: "路透社" });
  });

  it("单家条数上限生效，防止大 feed 顶穿 assess 批次数", async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      `<item><title><![CDATA[Story ${index}]]></title><link>https://www.ft.com/content/s${index}</link>` +
      `<pubDate>Wed, 16 Sep 2026 0${index % 10}:00:00 GMT</pubDate><description><![CDATA[d]]></description></item>`).join("");
    const items = await adapter(many, "", 5).fetchLatest({ outletIds: ["ft"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    expect(items).toHaveLength(5);
  });

  it("默认每家只保留 3 条，Radar 的全局上限再负责跨家兜底", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      `<item><title><![CDATA[Story ${index}]]></title><link>https://www.ft.com/content/d${index}</link>` +
      `<pubDate>Wed, 16 Sep 2026 0${index % 10}:00:00 GMT</pubDate><description><![CDATA[d]]></description></item>`).join("");
    const items = await adapter(many, "").fetchLatest({ outletIds: ["ft"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    expect(items).toHaveLength(3);
  });

  it("渠道全挂时返回空数组，由上层报 warning，不回落到全网检索", async () => {
    const runtime = createOutletFeedAdapter({
      fetch: (async () => { throw new Error("fetch failed"); }) as typeof fetch,
    });
    const items = await runtime.fetchLatest({ outletIds: ["bbc"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    expect(items).toEqual([]);
  });

  it("fullText outlet：入选条目抓文章页提取全文，抓取失败诚实退回 feed 摘要", async () => {
    const qbitaiRss = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title><![CDATA[GPT-6 开源]]></title>
  <link>https://www.qbitai.com/2026/09/493218.html</link>
  <pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate>
  <description><![CDATA[摘要 teaser]]></description></item>
</channel></rss>`;
    const article = `<html><body><div class="article"><p>第一段：具身智能体进展。</p><img src="https://cdn.qbitai.com/one.jpg"><p>第二段：开源社区反响。</p><img src="https://cdn.qbitai.com/two.jpg"></div></body></html>`;
    const badArticle = `<html><body><div>无正文容器</div></body></html>`;
    let articleFetches = 0;
    const runtime = createOutletFeedAdapter({
      now: () => FIXED_NOW,
      fetch: (async (url: string | URL | globalThis.Request) => {
        const target = String(url);
        articleFetches += 1;
        const body = target.endsWith("/feed")
          ? qbitaiRss
          : target.endsWith("ok.html") ? article : badArticle;
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as typeof fetch,
    });
    const items = await runtime.fetchLatest(
      { outletIds: ["qbitai"], lookbackHours: WINDOW_HOURS },
      new AbortController().signal,
    );
    // 目录里的真实 URL 抓不到（测试 fetch 返回 badArticle）→ 退回摘要，不冒充
    expect(items[0].excerpt).toBe("摘要 teaser");
    expect(items[0].title).toBe("GPT-6 开源");
    // 逐条记下：这条没抓到全文，阅读页不能再按目录把它标成发布方原文
    expect(items[0].sourceRef).toMatchObject({ outletId: "qbitai", fullText: false });

    const qbitai = RADAR_OUTLETS.find((outlet) => outlet.outletId === "qbitai")!;
    const runtimeOk = createOutletFeedAdapter({
      outlets: [{ ...qbitai, channels: [{ kind: "rss", url: "https://www.qbitai.com/feed" }] }],
      now: () => FIXED_NOW,
      fetch: (async (url: string | URL | globalThis.Request) => {
        const target = String(url);
        const body = target.endsWith("/feed")
          ? qbitaiRss.replace("493218.html", "ok.html")
          : article;
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as typeof fetch,
    });
    const full = await runtimeOk.fetchLatest(
      { outletIds: ["qbitai"], lookbackHours: WINDOW_HOURS },
      new AbortController().signal,
    );
    expect(full[0].excerpt).toBe("第一段：具身智能体进展。\n\n第二段：开源社区反响。");
    expect(full[0].images).toEqual([
      { src: "https://cdn.qbitai.com/one.jpg", after: 0 },
      { src: "https://cdn.qbitai.com/two.jpg", after: 1 },
    ]);
    expect(full[0].sourceRef).toMatchObject({ outletId: "qbitai", fullText: true });
    expect(articleFetches).toBeGreaterThanOrEqual(1);
  });

  it("fullText outlet：改版后找不到量子位正文容器时退到通用提取；通用提取也不足 200 字仍退回摘要", async () => {
    const qbitai = RADAR_OUTLETS.find((outlet) => outlet.outletId === "qbitai")!;
    const rss = (slug: string) => `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title><![CDATA[改版文章]]></title><link>https://www.qbitai.com/2026/09/${slug}.html</link>
  <pubDate>Mon, 21 Sep 2026 09:00:00 GMT</pubDate><description><![CDATA[摘要 teaser]]></description></item>
</channel></rss>`;
    const paragraph = (n: number) => `<p>第${n}段：新版页面把正文放进了 main 里的 article 标签，旧的 div.article 容器已经不存在了，通用提取仍要取到完整正文。</p>`;
    const redesigned = `<html><body><nav><a href="/">首页</a></nav><main><article><h1>改版文章</h1>${paragraph(1)}<img src="/wp-content/uploads/a.jpg" width="800">${paragraph(2)}${paragraph(3)}</article></main><footer>页脚</footer></body></html>`;
    const run = (slug: string, page: string) => createOutletFeedAdapter({
      outlets: [{ ...qbitai, channels: [{ kind: "rss", url: "https://www.qbitai.com/feed" }] }],
      now: () => FIXED_NOW,
      fetch: (async (url: string | URL | globalThis.Request) => {
        const body = String(url).endsWith("/feed") ? rss(slug) : page;
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as typeof fetch,
    }).fetchLatest({ outletIds: ["qbitai"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);

    const [generic] = await run("redesigned", redesigned);
    expect(generic.excerpt.split(/\n{2,}/)[0].startsWith("第1段")).toBe(true);
    expect(generic.excerpt).not.toContain("首页");
    expect(generic.images).toEqual([{ src: "https://www.qbitai.com/wp-content/uploads/a.jpg", after: 0 }]);
    expect(generic.sourceRef).toMatchObject({ fullText: true });

    const [short] = await run("short", "<html><body><article><p>只有一句。</p></article></body></html>");
    expect(short.excerpt).toBe("摘要 teaser");
    expect(short.sourceRef).toMatchObject({ fullText: false });
  });

  it("Atom：链接取 rel=alternate（或不写 rel）的 href，时间取 published 或 updated，摘要取 summary 或 content 并去标签", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Information</title>
  <link rel="self" href="https://www.theinformation.com/feed"/>
  <updated>2026-09-21T10:00:00Z</updated>
  <entry>
    <title>OpenAI Weighs New Pricing for Enterprise Agents</title>
    <link rel="alternate" type="text/html" href="https://www.theinformation.com/articles/openai-weighs-new-pricing"/>
    <id>tag:theinformation.com,2026:1</id>
    <published>2026-09-21T09:00:00Z</published>
    <updated>2026-09-21T09:30:00Z</updated>
    <summary type="html">&lt;p&gt;OpenAI is discussing &amp;amp; testing a new price tier.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title type="html">Nvidia&apos;s Next Chip</title>
    <link href="https://www.theinformation.com/articles/nvidia-next-chip"/>
    <updated>2026-09-20T08:00:00Z</updated>
    <content type="html">&lt;div&gt;&lt;p&gt;Nvidia plans&lt;/p&gt;&lt;p&gt;a new chip.&lt;/p&gt;&lt;/div&gt;</content>
  </entry>
  <entry>
    <title>Enclosure first</title>
    <link rel="enclosure" href="https://cdn.theinformation.com/a.mp3"/>
    <link rel="alternate" href="https://www.theinformation.com/articles/podcast"/>
    <published>2026-09-19T08:00:00Z</published>
  </entry>
  <entry>
    <title>Impostor</title>
    <link rel="alternate" href="https://theinformation.example.net/copy"/>
    <published>2026-09-21T08:00:00Z</published>
    <summary>should be rejected</summary>
  </entry>
  <entry>
    <title>Stale</title>
    <link rel="alternate" href="https://www.theinformation.com/articles/old"/>
    <published>2019-01-01T00:00:00Z</published>
  </entry>
</feed>`;
    const runtime = createOutletFeedAdapter({
      now: () => FIXED_NOW,
      limit: 10,
      fetch: (async (url: string | URL | globalThis.Request) => {
        const body = String(url) === "https://www.theinformation.com/feed" ? atom : "";
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as typeof fetch,
    });
    const items = await runtime.fetchLatest({ outletIds: ["theinformation"], lookbackHours: WINDOW_HOURS }, new AbortController().signal);
    const sourceRef = { type: "outlet", provider: "publisher-feed", outletId: "theinformation", outletName: "The Information" };
    expect(items).toEqual([
      {
        sourceType: "outlet", title: "OpenAI Weighs New Pricing for Enterprise Agents",
        url: "https://www.theinformation.com/articles/openai-weighs-new-pricing", publishedAt: "2026-09-21T09:00:00.000Z",
        excerpt: "OpenAI is discussing & testing a new price tier.", sourceRef,
      },
      {
        sourceType: "outlet", title: "Nvidia's Next Chip",
        url: "https://www.theinformation.com/articles/nvidia-next-chip", publishedAt: "2026-09-20T08:00:00.000Z",
        excerpt: "Nvidia plans a new chip.", sourceRef,
      },
      {
        sourceType: "outlet", title: "Enclosure first",
        url: "https://www.theinformation.com/articles/podcast", publishedAt: "2026-09-19T08:00:00.000Z",
        excerpt: "Enclosure first", sourceRef,
      },
    ]);
  });

  it("extractArticleContent：段落保留、script 剔除、只取 https 图、10k 截断", () => {
    // 截断之后的段落连同其配图一起丢弃
    const html = `<div class="article"><p>段落一</p><img src="https://cdn.example/a.jpg"><script>alert(1)</script><p>段落二</p><img src="http://bad.example/b.jpg">${"长".repeat(20_000)}<p>尾段</p><img src="https://cdn.example/c.jpg"></div>`;
    const content = extractArticleContent(html);
    expect(content.text).not.toContain("alert");
    expect(content.text.startsWith("段落一\n\n段落二")).toBe(true);
    expect(content.text.length).toBeLessThanOrEqual(10_000);
    expect(content.images).toEqual([{ src: "https://cdn.example/a.jpg", after: 0 }]);
  });

  it("extractArticleContent：先剥标签再完整解码实体（命名、十进制、十六进制），不二次解码", () => {
    const html = `<div class="article"><p>&copy; 2026 &#8220;引号&#8221; &#x2019; &mdash; &hellip; &lt;b&gt;不是标签&lt;/b&gt; &amp;lt;p&amp;gt;</p></div>`;
    expect(extractArticleContent(html).text).toBe("© 2026 “引号” ’ — … <b>不是标签</b> &lt;p&gt;");
  });
});

describe("量子位文章页真实样张", () => {
  // 真实页面裁剪而来：正文容器原样保留，容器外有作者其他文章、分享框、相关阅读、热门文章、注释掉的搜索框和页脚
  const page = readFileSync(fileURLToPath(new URL("./fixtures/qbitai-article.html", import.meta.url)), "utf8");

  it("正文止于文章容器的配对闭合：不含标题/作者行、版权声明、容器外列表与页脚，也不漏 `-->` 或未解码实体", () => {
    const { text } = extractArticleContent(page);
    const paragraphs = text.split(/\n{2,}/);
    expect(paragraphs[0]).toBe("联想天禧AI携全场景多端产品矩阵亮相阿里云栖大会");
    expect(paragraphs.at(-1)).toBe("本文由联想提供，量子位获授权转载，观点归原作者所有。");
    expect(paragraphs).toHaveLength(13);
    expect(text).toContain("本届大会以”智以致用”为主题");
    expect(text).toContain("从”团队”到”人+Agent”：组织的最小生产单元正在改写");
    for (const junk of ["-->", "&#", "&copy;", "版权所有", "寻求报道", "扫码关注", "扫码分享", "相关阅读", "热门文章", "搜索", "2026-09-23", "来源："]) {
      expect(text).not.toContain(junk);
    }
  });

  it("配图只取正文容器内的图，位置与正文按空行切出的段落对齐", () => {
    const { text, images } = extractArticleContent(page);
    expect(images).toEqual([
      { src: "https://i.qbitai.com/wp-content/uploads/2026/09/34d00d924786c2817e8d9ad91d4de4fa.jpeg", after: 1 },
      { src: "https://i.qbitai.com/wp-content/uploads/2026/09/47e8cf2cbccf0677048df959b3ee4162.jpeg", after: 3 },
      { src: "https://i.qbitai.com/wp-content/uploads/2026/09/9e7c8160bed3eac0f26192ae5881f3ac.png", after: 7 },
      { src: "https://i.qbitai.com/wp-content/uploads/2026/09/1a17a21e7fbb4fa7c289502115c4104d.png", after: 10 },
    ]);
    const paragraphs = text.split(/\n{2,}/);
    expect(paragraphs[1].startsWith("9月22日至24日")).toBe(true);
    expect(paragraphs[3].startsWith("联想天禧AI战略生态部负责人刘琳琳")).toBe(true);
    expect(paragraphs[7].startsWith("把视野放大到整个行业")).toBe(true);
    expect(paragraphs[10].startsWith("产品能力的背后是天禧生态的持续繁荣")).toBe(true);
  });

  it("找不到正文容器时返回空结果，由调用方退回 feed 摘要", () => {
    expect(extractArticleContent(page.replace('<div class="article">', '<div class="post">'))).toEqual({ text: "", images: [] });
  });
});

describe("真实渠道快照", () => {
  const fixture = ".scratch/ceo-warmap-mvp/evidence/outlets";
  it("用真实抓取样张验证解析与归属判定（无样张时跳过）", async () => {
    let rss: string;
    let sitemap: string;
    try {
      rss = readFileSync(`${fixture}/ft-world.xml`, "utf8");
      sitemap = readFileSync(`${fixture}/reuters-news-sitemap.xml`, "utf8");
    } catch {
      return;
    }
    const runtime = createOutletFeedAdapter({
      outlets: RADAR_OUTLETS.filter((outlet) => ["ft", "reuters"].includes(outlet.outletId)),
      limit: 20,
      now: () => FIXED_NOW,
      fetch: (async (url: string | URL | globalThis.Request) => {
        const target = String(url);
        const body = target.includes("ft.com") ? rss : target.includes("reuters.com") ? sitemap : "";
        return { ok: true, status: 200, text: async () => body } as Response;
      }) as typeof fetch,
    });
    const items = await runtime.fetchLatest({ outletIds: ["ft", "reuters"], lookbackHours: 24 * 30 }, new AbortController().signal);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.sourceRef.type).toBe("outlet");
      expect(item.title.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(item.publishedAt))).toBe(true);
      expect(item.excerpt.length).toBeGreaterThan(0);
    }
    const hosts = new Set(items.map((item) => new URL(item.url).hostname.replace(/^www\./, "")));
    expect([...hosts].some((host) => host === "ft.com" || host.endsWith(".ft.com"))).toBe(true);
    expect([...hosts].some((host) => host === "reuters.com" || host.endsWith(".reuters.com"))).toBe(true);
    // 归属不可越界：任何一条的 host 都必须落在它所声明 outlet 的 articleDomains 内
    const byId = new Map(RADAR_OUTLETS.map((outlet) => [outlet.outletId, outlet]));
    for (const item of items) {
      if (item.sourceRef.type !== "outlet") continue;
      const outlet = byId.get(item.sourceRef.outletId);
      const host = new URL(item.url).hostname.toLowerCase().replace(/^www\./, "");
      expect(outlet?.articleDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))).toBe(true);
    }
  });
});
