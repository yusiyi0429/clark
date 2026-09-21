import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { RadarSources, RADAR_OUTLETS, type TRadarSourceItem } from "@warmap/contracts";import { createOutletFeedAdapter, extractArticleText, resolveConfiguredOutletIds } from "../src/outletSources.js";

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

function adapter(rss = RSS, sitemap = NEWS_SITEMAP, limit?: number) {
  return createOutletFeedAdapter({
    ...(limit === undefined ? {} : { limit }),
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

  it("白名单目录：8 家，每家都配了渠道；量子位标记全文抓取", () => {
    expect(RADAR_OUTLETS.map((outlet) => outlet.outletId)).toEqual([
      "bbc", "wsj", "bloomberg", "reuters", "ft", "cnbc", "economist", "qbitai",
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
    const article = `<html><body><div class="article"><p>第一段：具身智能体进展。</p><p>第二段：开源社区反响。</p></div></body></html>`;
    const badArticle = `<html><body><div>无正文容器</div></body></html>`;
    let articleFetches = 0;
    const runtime = createOutletFeedAdapter({
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

    const qbitai = RADAR_OUTLETS.find((outlet) => outlet.outletId === "qbitai")!;
    const runtimeOk = createOutletFeedAdapter({
      outlets: [{ ...qbitai, channels: [{ kind: "rss", url: "https://www.qbitai.com/feed" }] }],
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
    expect(articleFetches).toBeGreaterThanOrEqual(1);
  });

  it("extractArticleText：段落保留、script 剔除、10k 截断", () => {
    const html = `<div class="article"><p>段落一</p><script>alert(1)</script><p>段落二</p>${"长".repeat(20_000)}</div>`;
    const text = extractArticleText(html);
    expect(text).not.toContain("alert");
    expect(text.startsWith("段落一\n\n段落二")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(10_000);
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
