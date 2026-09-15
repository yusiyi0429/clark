/**
 * 抓链接那一支。
 *
 * 这几条盯的是**失败路径**，因为那是这个文件真正的内容：抓不到的时候屏幕上要出现一句
 * 说得清的话（`Card.materialNote`），而不是一张正文碰巧很短的卡。成功路径只钉一条
 * ——「标签删掉、段落留住」，因为段落是预研那一头分段读的依据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 解析永远落到一个公网地址上。不 mock 的话这几条会真的去查 DNS：查得通与否取决于
// 跑单测那台机器有没有网，而这里要验的不是网。
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "inside.example.com") return [{ address: "10.0.0.7", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  },
}));

const { fetchArticle, htmlToText, looksLikeUrl } = await import("./fetch-article");

const reply = (body: string, init: { status?: number; type?: string; location?: string } = {}) =>
  new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": init.type ?? "text/html; charset=utf-8",
      ...(init.location ? { location: init.location } : {}),
    },
  });

/** 够长的一篇 —— 抓回来不到 120 字会被判成「取不到成段的正文」。 */
const LONG = "成都二手房的抽佣比例从 2.5% 降到了 2%。".repeat(12);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("整段是不是一个链接", () => {
  it("只认整段就是一个 http(s) 链接的那一种", () => {
    expect(looksLikeUrl("https://example.com/a")).toBe(true);
    expect(looksLikeUrl("  http://example.com  ")).toBe(true);
    // 一句话里夹着一个网址 —— 那是一句话，不是一个链接。
    expect(looksLikeUrl("看这个 https://example.com/a 你怎么想")).toBe(false);
    expect(looksLikeUrl("ftp://example.com/a")).toBe(false);
  });
});

describe("HTML 抽成文本", () => {
  it("删标签、留段落", () => {
    const out = htmlToText(
      `<html><head><title>T</title><style>.a{}</style></head><body>` +
        `<nav>首页 登录</nav><p>第一段。</p><p>第二段 &amp; 第三句。</p>` +
        `<script>x=1</script></body></html>`,
    );
    // 段落之间必须留下空行：预研那一头是按空行分段读的。
    expect(out).toBe("第一段。\n\n第二段 & 第三句。");
    // script / style / nav 整段消失，不是只删掉标签留下里面的字。
    expect(out).not.toContain("x=1");
    expect(out).not.toContain("首页");
  });
});

describe("抓不到的那些情况，每一种都要说得清", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(`<p>${LONG}</p>`)));
  });

  it("指向内网的地址不去打开", async () => {
    for (const url of ["http://127.0.0.1:3000/x", "http://192.168.1.1/", "http://gitlab/x"]) {
      const got = await fetchArticle(url);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.why).toContain("内网");
    }
    // 一次请求都没发出去。
    expect(fetch).not.toHaveBeenCalled();
  });

  it("域名解析到内网地址也不去打开 —— 挡的不只是字面量", async () => {
    const got = await fetchArticle("https://inside.example.com/x");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("内网");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("跳转的每一跳都重新核一次", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL) =>
        String(u).includes("inside")
          ? reply("", { status: 200 })
          : reply("", { status: 302, location: "https://inside.example.com/x" }),
      ),
    );
    // 第一跳是公网、第二跳进内网 —— 交给 fetch 自动跳的话这一种会漏过去。
    const got = await fetchArticle("https://example.com/go");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("内网");
  });

  it("PDF 照实说这一版不读", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("%PDF-1.7", { type: "application/pdf" })));
    const got = await fetchArticle("https://example.com/a.pdf");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("application/pdf");
  });

  it("要登录的那一种单独说 —— 他自己打开是看得到的", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("no", { status: 403 })));
    const got = await fetchArticle("https://example.com/a");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("登录");
  });

  it("打开了但没有成段的正文，不当成抓到了", async () => {
    // 这一种最要说清楚：不说的话屏幕上就是一张正文只有两行的卡，看不出那两行不是全文。
    vi.stubGlobal("fetch", vi.fn(async () => reply("<div id='app'></div>")));
    const got = await fetchArticle("https://example.com/spa");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("取不到成段的正文");
  });

  it("超时说超时，不说「打不开」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      }),
    );
    const got = await fetchArticle("https://example.com/slow");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.why).toContain("秒没有响应");
  });
});

describe("抓到了", () => {
  it("正文和标题都带回来", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(`<title>抽佣比例</title><p>${LONG}</p>`)));
    const got = await fetchArticle("https://example.com/a");
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.title).toBe("抽佣比例");
      expect(got.host).toBe("example.com");
      expect(got.body).toContain("2.5% 降到了 2%");
    }
  });
});
