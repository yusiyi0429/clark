import { describe, expect, it } from "vitest";
import type { TRadarSourceItem } from "@warmap/contracts";
import {
  createCoverImageFetcher,
  extractCoverImage,
  fetchCovers,
  fetchProxiedImage,
  isLikelyCoverImage,
  isPublicHttpUrl,
} from "../src/signalCover.js";
import { getSignalImageSource } from "../src/signals.js";
import { createRadarService } from "../src/radar.js";
import { createBochaRadarWebAdapter } from "../src/radarSources.js";
import { createBochaWebSearchAdapter } from "../src/webSearch.js";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

const PAGE = "https://www.example.com/news/2026/10/a.html";

describe("原文封面解析", () => {
  it("优先取 og:image，相对地址按原文页补成绝对地址", () => {
    expect(extractCoverImage('<head><meta property="og:image" content="https://img.example.com/cover.jpg"></head>', PAGE))
      .toBe("https://img.example.com/cover.jpg");
    expect(extractCoverImage("<meta content='/up/c.png' property='og:image' />", PAGE)).toBe("https://www.example.com/up/c.png");
    expect(extractCoverImage('<meta property="og:image" content="//cdn.example.com/c.jpg?a=1&amp;b=2">', PAGE)).toBe("https://cdn.example.com/c.jpg?a=1&b=2");
    expect(extractCoverImage('<meta name="twitter:image" content="https://img.example.com/t.jpg">', PAGE)).toBe("https://img.example.com/t.jpg");
  });

  it("站点默认分享图、logo、图标、矢量图被跳过，退到正文容器首图", () => {
    const html = `
      <meta property="og:image" content="https://nimg.ws.126.net/?url=https%3A%2F%2Fstatic.ws.126.net%2Ff2e%2Fwap%2Fcommon%2Fimages%2Fweixinfixed1200low.jpg">
      <meta name="twitter:image" content="https://www.example.com/static/logo.png">
      <img src="https://img.example.com/nav-banner.jpg">
      <div class="post_body">
        <img src="https://img.example.com/icon/share.png">
        <img class="hx-avatar" style="width:30px;height:30px;" src="https://img.example.com/u/1.jpg">
        <img src="https://img.example.com/a/chart.svg">
        <img src="https://img.example.com/a/t.gif" width="1" height="1">
        <img alt="作者头像" src="https://img.example.com/a/p.jpg">
        <img data-w="100" data-h="80" src="https://img.example.com/a/small.jpg">
        <img style="display: none;" src="https://img.example.com/a/hidden.jpg">
        <img data-src="https://img.example.com/a/body.jpg" src="data:image/gif;base64,R0lGOD">
      </div>
      <div class="recommend"><img src="https://img.example.com/rec.jpg"></div>`;
    expect(extractCoverImage(html, PAGE)).toBe("https://img.example.com/a/body.jpg");
  });

  it("正文容器之外（推荐流、导航）的图不当封面；没有正文容器就没有图", () => {
    const outside = '<div class="post_body"><p>只有文字</p></div><div class="recommend"><img src="https://img.example.com/rec.jpg"></div>';
    expect(extractCoverImage(outside, PAGE)).toBeNull();
    expect(extractCoverImage('<body><img src="https://img.example.com/x.jpg"></body>', PAGE)).toBeNull();
  });

  it("og:image 标了过小尺寸时不用；公众号页面用 msg_cdn_url 兜底", () => {
    expect(extractCoverImage(
      '<meta property="og:image" content="https://img.example.com/s.jpg"><meta property="og:image:width" content="120">',
      PAGE,
    )).toBeNull();
    expect(extractCoverImage('<script>var msg_cdn_url = "https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg";</script>', "https://mp.weixin.qq.com/s/x"))
      .toBe("https://mmbiz.qpic.cn/mmbiz_jpg/abc/0?wx_fmt=jpeg");
  });

  it("只接受公网 http(s) 地址", () => {
    expect(extractCoverImage('<meta property="og:image" content="javascript:alert(1)">', PAGE)).toBeNull();
    expect(extractCoverImage('<meta property="og:image" content="ftp://img.example.com/a.jpg">', PAGE)).toBeNull();
    expect(isLikelyCoverImage("http://img.example.com/a.jpg")).toBe(true);
    for (const url of ["http://localhost/a.jpg", "http://127.0.0.1/a.jpg", "http://10.0.0.8/a.jpg", "http://192.168.1.2/a.jpg", "http://169.254.169.254/latest", "http://[::1]/a.jpg", "http://intranet/a.jpg", "https://u:p@img.example.com/a.jpg"]) {
      expect(isPublicHttpUrl(url), url).toBe(false);
    }
    expect(isLikelyCoverImage("https://mmbiz.qpic.cn/mmbiz_gif/abc/0?wx_fmt=gif")).toBe(false);
    expect(isLikelyCoverImage("https://img.example.com/favicon.ico")).toBe(false);
    expect(isLikelyCoverImage("https://img.example.com/1x1.png")).toBe(false);
  });
});

const htmlResponse = (html: string, init: ResponseInit = {}) =>
  new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("原文封面抓取", () => {
  it("抓原文页取 og:image；HTTP 错误、非 HTML、网络错误都只是没有图", async () => {
    const pages: Record<string, () => Response> = {
      "https://a.example.com/ok": () => htmlResponse('<meta property="og:image" content="https://img.example.com/ok.jpg">'),
      "https://a.example.com/404": () => htmlResponse("", { status: 404 }),
      "https://a.example.com/pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
    };
    const fetcher = createCoverImageFetcher({
      fetch: (async (input: string | URL | Request) => {
        const page = pages[String(input)];
        if (!page) throw new TypeError("fetch failed");
        return page();
      }) as typeof fetch,
    });
    expect(await fetcher("https://a.example.com/ok")).toBe("https://img.example.com/ok.jpg");
    expect(await fetcher("https://a.example.com/404")).toBeNull();
    expect(await fetcher("https://a.example.com/pdf")).toBeNull();
    expect(await fetcher("https://a.example.com/down")).toBeNull();
    expect(await fetcher("http://127.0.0.1:4320/api")).toBeNull();
  });

  it("原文页超时按时放弃，不拖住入库", async () => {
    const fetcher = createCoverImageFetcher({
      timeoutMs: 50,
      fetch: ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch,
    });
    const started = Date.now();
    expect(await fetcher("https://slow.example.com/a")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("批量抓取去重，单个抛错不影响其他", async () => {
    let calls = 0;
    const covers = await fetchCovers(["https://a.example.com/1", "https://a.example.com/1", "https://a.example.com/2"], async (url) => {
      calls += 1;
      if (url.endsWith("2")) throw new Error("boom");
      return "https://img.example.com/1.jpg";
    });
    expect(calls).toBe(2);
    expect([...covers]).toEqual([["https://a.example.com/1", "https://img.example.com/1.jpg"]]);
  });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("原文图片代理", () => {
  it("带原文页做 Referer；被防盗链拒绝时不带 Referer 重试一次", async () => {
    const referers: (string | undefined)[] = [];
    const result = await fetchProxiedImage("https://mmbiz.qpic.cn/a/0?wx_fmt=png", "https://mp.weixin.qq.com/s/x", {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const referer = (init?.headers as Record<string, string>).referer;
        referers.push(referer);
        return referer ? new Response("forbidden", { status: 403 }) : new Response(PNG, { headers: { "content-type": "image/png" } });
      }) as typeof fetch,
    });
    expect(referers).toEqual(["https://mp.weixin.qq.com/s/x", undefined]);
    expect(result).toMatchObject({ ok: true, type: "image/png" });
  });

  it("只代理位图：SVG 和网页拒绝，octet-stream 按文件头认出", async () => {
    const respond = (body: BodyInit, type: string) => ({ fetch: (async () => new Response(body, { headers: { "content-type": type } })) as typeof fetch });
    expect(await fetchProxiedImage("https://img.example.com/a", PAGE, respond("<svg onload=x>", "image/svg+xml"))).toMatchObject({ ok: false, status: 502 });
    expect(await fetchProxiedImage("https://img.example.com/a", PAGE, respond("<html>", "text/html"))).toMatchObject({ ok: false, status: 502 });
    expect(await fetchProxiedImage("https://img.example.com/a", PAGE, respond(PNG, "application/octet-stream"))).toMatchObject({ ok: true, type: "image/png" });
  });

  it("超过大小上限拒绝；内网地址不抓", async () => {
    let calls = 0;
    const big = { limit: 8, fetch: (async () => { calls += 1; return new Response(new Uint8Array(64), { headers: { "content-type": "image/jpeg" } }); }) as typeof fetch };
    expect(await fetchProxiedImage("https://img.example.com/big.jpg", PAGE, big)).toMatchObject({ ok: false, status: 413 });
    calls = 0;
    expect(await fetchProxiedImage("http://169.254.169.254/latest/meta-data", PAGE, big)).toMatchObject({ ok: false, status: 404 });
    expect(calls).toBe(0);
  });

  it("只代理 source_images 里登记过的地址：路由不接 URL，越界下标、坏地址、非 UUID 都 404", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const rows = [{ source_url: "https://news.example.com/a", source_images: [{ src: "https://img.example.com/1.jpg", after: 0 }, { src: "javascript:alert(1)", after: 0 }] }];
    const q = (async () => ({ rows })) as unknown as Parameters<typeof getSignalImageSource>[0];
    expect(await getSignalImageSource(q, id, 0)).toEqual({ url: "https://img.example.com/1.jpg", referer: "https://news.example.com/a" });
    expect(await getSignalImageSource(q, id, 1)).toBeNull();
    expect(await getSignalImageSource(q, id, 12)).toBeNull();
    expect(await getSignalImageSource(q, "not-a-uuid", 0)).toBeNull();
  });
});

describe("雷达入库补封面", () => {
  it("没带配图的来源入库时写入原文封面；自带配图的不抓；抓不到的按无图入库", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
        JSON.stringify([{ id: "anchor-market", title: "市场定价", query: "竞争对手 最新定价", location: { type: "battlefield", id: "growth" } }]),
        JSON.stringify({ sites: [{ id: "site-web", name: "公开 Web", enabled: true, domains: ["example.com"] }], wechatAccounts: [] }),
      ]);
      const item = (url: string, images?: TRadarSourceItem["images"]): TRadarSourceItem => ({
        sourceType: "web", title: url, url, publishedAt: "2026-05-01T08:00:00.000Z", excerpt: `原文 ${url}`,
        sourceRef: { type: "web-search", provider: "recorded-web", query: "q" }, ...(images ? { images } : {}),
      });
      const items = [
        item("https://example.com/with-cover"),
        item("https://example.com/own-images", [{ src: "https://img.example.com/own.jpg", after: 2 }]),
        item("https://example.com/no-cover"),
      ];
      const asked: string[] = [];
      const radar = createRadarService({
        pool,
        web: { configured: true, async search() { return items; } },
        assessor: {
          async assess({ sources }) {
            return { candidates: sources.map((source) => ({
              sourceFingerprint: source.sourceFingerprint, anchorId: "anchor-market", summary: `摘要 ${source.url}`,
              strategicImpact: "影响", evidenceQuote: "原文", unknowns: [], score: { relevance: 3, impact: 3, urgency: 3 },
            })) } as never;
          },
        },
        coverImage: async (url) => {
          asked.push(url);
          return url.endsWith("with-cover") ? "https://img.example.com/cover.jpg" : null;
        },
        now: () => new Date("2026-05-02T03:00:00.000Z"),
      });
      expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 3 });
      expect(asked.sort()).toEqual(["https://example.com/no-cover", "https://example.com/with-cover"]);
      const stored = Object.fromEntries((await db.query<{ source_url: string; source_images: unknown }>("SELECT source_url, source_images FROM signals")).rows
        .map((row) => [row.source_url, row.source_images]));
      expect(stored).toEqual({
        "https://example.com/with-cover": [{ src: "https://img.example.com/cover.jpg", after: 0 }],
        "https://example.com/own-images": [{ src: "https://img.example.com/own.jpg", after: 2 }],
        "https://example.com/no-cover": [],
      });
    });
  });

  it("检索服务（博查）返回的配图按 hostPageUrl 对上网页后直接做封面，logo 类不要", async () => {
    const search = createBochaWebSearchAdapter({
      apiKey: "test-key",
      now: () => 0,
      sleep: async () => undefined,
      fetch: (async () => new Response(JSON.stringify({
        code: 200,
        data: {
          webPages: { value: [
            { name: "有图", url: "https://example.com/a", summary: "摘要 a", datePublished: "2026-05-01T08:00:00+08:00" },
            { name: "logo 图", url: "https://example.com/b", summary: "摘要 b", datePublished: "2026-05-01T08:00:00+08:00" },
            { name: "无图", url: "https://example.com/c", summary: "摘要 c", datePublished: "2026-05-01T08:00:00+08:00" },
          ] },
          images: { value: [
            { hostPageUrl: "https://example.com/a", contentUrl: "https://img.example.com/a.jpg" },
            { hostPageUrl: "https://example.com/b", contentUrl: "https://img.example.com/site-logo.png" },
            { hostPageUrl: "https://other.example.com/x", contentUrl: "https://img.example.com/x.jpg" },
          ] },
        },
      }), { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    const results = await createBochaRadarWebAdapter(search).search({ query: "q", lookbackHours: 48 }, new AbortController().signal);
    expect(results.map((result) => [result.url, result.images ?? null])).toEqual([
      ["https://example.com/a", [{ src: "https://img.example.com/a.jpg", after: 0 }]],
      ["https://example.com/b", null],
      ["https://example.com/c", null],
    ]);
  });
});
