import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRadarSettings, readSource, sourceSuggestions } from "../src/radarSettings.js";

const SITE_NOTE = "全网检索后按域名筛，结果可能很少";
const LIST_NOTE = "读取榜单（每天一次）";
const PUBLIC_DOMAIN = "请填公开网站的域名";

/** 设计 §3.4 的来源样例：输入 → 规范值、读法与如实的说明。 */
const READABLE: [string, Record<string, unknown>, (string | { language: string | null; since: string })?][] = [
  ["HTTPS://WWW.FT.COM/world?x=1#y", { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, "ft"],
  ["ft.com/world", { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, "ft"],
  ["  www.ft.com./  ", { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, "ft"],
  ["m.ft.com/content/1", { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, "ft"],
  ["bbc.co.uk/news", { value: "bbc.com", name: "BBC", kind: "feed", note: "订阅源" }, "bbc"],
  ["https://www.theinformation.com/articles/abc", { value: "theinformation.com", name: "The Information", kind: "feed", note: "订阅源" }, "theinformation"],
  ["qbitai.com", { value: "qbitai.com", name: "量子位", kind: "feed", note: "订阅源" }, "qbitai"],
  ["reuters.com/world", { value: "reuters.com", name: "路透社", kind: "feed", note: "订阅源" }, "reuters"],
  // ftchinese 是独立中文品牌：不命中 ft.com
  ["ftchinese.com", { value: "ftchinese.com", kind: "site", note: SITE_NOTE }],
  ["https://36kr.com/p/123?f=rss", { value: "36kr.com", name: "36氪", kind: "site", note: SITE_NOTE }],
  ["www.jiqizhixin.com/articles", { value: "jiqizhixin.com", name: "机器之心", kind: "site", note: SITE_NOTE }],
  // GitHub Trending（02b）：读取榜单；语言路径与 since 决定读哪一版，规范值里保留它们（daily 是默认，省掉）
  ["github.com/trending?since=daily", { value: "github.com/trending", name: "GitHub Trending", kind: "list", note: LIST_NOTE }, { language: null, since: "daily" }],
  ["https://github.com/trending/python", { value: "github.com/trending/python", name: "GitHub Trending · python", kind: "list", note: LIST_NOTE }, { language: "python", since: "daily" }],
  ["https://github.com/trending/TypeScript?since=weekly", { value: "github.com/trending/typescript?since=weekly", name: "GitHub Trending · typescript · 周榜", kind: "list", note: LIST_NOTE }, { language: "typescript", since: "weekly" }],
  ["github.com/trending/c%2B%2B?since=monthly&spoken_language_code=zh", { value: "github.com/trending/c%2b%2b?since=monthly", name: "GitHub Trending · c++ · 月榜", kind: "list", note: LIST_NOTE }, { language: "c++", since: "monthly" }],
  ["github.com/trending?since=yearly", { value: "github.com/trending", name: "GitHub Trending", kind: "list", note: LIST_NOTE }, { language: null, since: "daily" }],
  // 开发者榜与更深的路径不是仓库榜：如实写暂不支持
  ["github.com/trending/developers?since=weekly", { value: "github.com/trending/developers", name: "GitHub Trending 开发者榜", kind: "unsupported", note: "只读仓库榜，开发者榜暂不支持" }],
  ["github.com/trending/python/extra", { value: "github.com/trending/python/extra", name: "GitHub Trending", kind: "unsupported", note: "只能读仓库榜，可以带一个语言" }],
  // 路径前缀按段匹配：/trendingx 不算 trending
  ["github.com/trendingx", { value: "github.com/trendingx", kind: "site", note: SITE_NOTE }],
  ["github.com/openai/", { value: "github.com/openai", kind: "site", note: SITE_NOTE }],
  ["news.ycombinator.com/newest", { value: "news.ycombinator.com", name: "Hacker News", kind: "unsupported", note: "订阅源只有评论链接，暂不支持" }],
  ["https://www.wsj.com/tech", { value: "wsj.com", name: "华尔街日报", kind: "unsupported", note: "订阅源已停更，暂不支持" }],
  ["cn.wsj.com", { value: "wsj.com", name: "华尔街日报", kind: "unsupported", note: "订阅源已停更，暂不支持" }],
  ["example.org//blog//posts/", { value: "example.org/blog/posts", kind: "site", note: SITE_NOTE }],
  ["http://Blog.Example.org/A/B/", { value: "blog.example.org/A/B", kind: "site", note: SITE_NOTE }],
  ["https://中文.com/", { value: "xn--fiq228c.com", kind: "site", note: SITE_NOTE }],
];

const REJECTED: [string, string][] = [
  ["", "来源不能为空"],
  ["   ", "来源不能为空"],
  ["ftp://ft.com/a", "只支持 http 或 https 网址"],
  ["javascript:alert(1)", "只支持 http 或 https 网址"],
  ["mailto:news@ft.com", "只支持 http 或 https 网址"],
  ["http://", "不是有效的网址"],
  ["https://exa mple.com", "不是有效的网址"],
  ["https://user:pass@ft.com", "网址里不能带账号或口令"],
  ["https://ft.com:8443/x", "网址里不能带端口"],
  ["ft.com:8080", "网址里不能带端口"],
  ["127.0.0.1", PUBLIC_DOMAIN],
  ["http://10.0.0.1/admin", PUBLIC_DOMAIN],
  ["0x7f.1", PUBLIC_DOMAIN],
  ["[::1]", PUBLIC_DOMAIN],
  ["http://[2001:db8::1]/", PUBLIC_DOMAIN],
  ["localhost", PUBLIC_DOMAIN],
  ["intranet", PUBLIC_DOMAIN],
  ["printer.local", PUBLIC_DOMAIN],
  ["db.internal", PUBLIC_DOMAIN],
  ["router.lan", PUBLIC_DOMAIN],
  ["nas.home", PUBLIC_DOMAIN],
  ["site.test", PUBLIC_DOMAIN],
  ["x.invalid", PUBLIC_DOMAIN],
  ["demo.example", PUBLIC_DOMAIN],
  ["1.0.0.127.in-addr.arpa", PUBLIC_DOMAIN],
  ["a_b.com", PUBLIC_DOMAIN],
  ["-bad.com", PUBLIC_DOMAIN],
  [`${"a".repeat(64)}.com`, PUBLIC_DOMAIN],
  ["mp.weixin.qq.com/s/abc", "公众号要按账号订阅，贴文章链接读不到"],
  ["https://channels.weixin.qq.com/x", "公众号要按账号订阅，贴文章链接读不到"],
  // 中文路径按百分号编码后超过 300 字符：规范值也守契约上限
  [`example.org/${"中".repeat(40)}`, "网址太长了"],
];

const hashId = (text: string) => createHash("sha256").update(`v1\n${text}`).digest("hex").slice(0, 12);

describe("来源规范化与读法（§3.4 来源 1–10）", () => {
  it.each(READABLE)("%s → 规范值与读法", (input, setting, extra) => {
    const result = readSource(input, true);
    // 第三列：订阅源是目录里的发布方 id，榜单是要读的那一版
    expect(result).toEqual({ source: { setting, ...(typeof extra === "string" ? { outletId: extra } : extra ? { list: extra } : {}) } });
  });

  it.each(REJECTED)("拒绝 %j：%s", (input, message) => {
    expect(readSource(input, true)).toEqual({ error: message });
  });

  it("全网检索没开通时，site 的说明如实写读不到；订阅源不受影响", () => {
    expect(readSource("36kr.com", false)).toEqual({ source: { setting: { value: "36kr.com", name: "36氪", kind: "site", note: "全网检索未开通，暂时读不到" } } });
    expect(readSource("ft.com", false)).toMatchObject({ source: { setting: { kind: "feed", note: "订阅源" } } });
  });

  it("规范值再规范化保持不变（库里只存规范值，读法现算）", () => {
    for (const [input] of READABLE) {
      const first = readSource(input, true);
      if (!("source" in first)) throw new Error(`应当可读: ${input}`);
      expect(readSource(first.source.setting.value, true)).toEqual(first);
    }
  });
});

describe("设置整体规范化（§3.4 来源 11–12 与方向 1–5）", () => {
  it("来源按规范值去重、保持首次出现的顺序；方向 NFKC、合并空白、不区分大小写去重", () => {
    const result = normalizeRadarSettings({
      directions: ["  1 号位产品的设计  ", "ＡＩ　Agent", "ai agent", "a\n\tb"],
      sources: ["ft.com/world", "https://www.ft.com", "36kr.com", "36KR.com/p/1", "github.com/trending"],
    }, "person", true);
    expect(result).toEqual({
      ok: true,
      directions: [
        { id: `d_${hashId("1 号位产品的设计")}`, text: "1 号位产品的设计" },
        { id: `d_${hashId("AI Agent")}`, text: "AI Agent" },
        { id: `d_${hashId("a b")}`, text: "a b" },
      ],
      sources: [
        { setting: { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, outletId: "ft" },
        { setting: { value: "36kr.com", name: "36氪", kind: "site", note: SITE_NOTE } },
        { setting: { value: "github.com/trending", name: "GitHub Trending", kind: "list", note: LIST_NOTE }, list: { language: null, since: "daily" } },
      ],
    });
  });

  it("方向按字符（Array.from）最多 40 个，必须含字母或数字", () => {
    const ok = normalizeRadarSettings({ directions: ["中".repeat(40), "𠀀".repeat(40)], sources: [] }, "person", true);
    expect(ok).toMatchObject({ ok: true, directions: [{ text: "中".repeat(40) }, { text: "𠀀".repeat(40) }] });
    const bad = normalizeRadarSettings({ directions: ["中".repeat(41), "!!!", "——", "好方向"], sources: [] }, "person", true);
    expect(bad).toEqual({
      ok: false,
      code: "RADAR_DIRECTION_INVALID",
      message: expect.any(String),
      fieldErrors: { "directions/0": "方向最多 40 个字", "directions/1": "方向要写成一句话", "directions/2": "方向要写成一句话" },
    });
  });

  it("来源问题一次返回全部，键为 sources/<i>", () => {
    const result = normalizeRadarSettings({ directions: ["方向"], sources: ["mp.weixin.qq.com/s/x", "ft.com", "localhost", "ftp://a.com"] }, "person", true);
    expect(result).toEqual({
      ok: false,
      code: "RADAR_SOURCE_INVALID",
      message: expect.any(String),
      fieldErrors: {
        "sources/0": "公众号要按账号订阅，贴文章链接读不到",
        "sources/2": PUBLIC_DOMAIN,
        "sources/3": "只支持 http 或 https 网址",
      },
    });
  });

  it("方向和来源都有问题时一起返回", () => {
    const result = normalizeRadarSettings({ directions: ["…"], sources: ["localhost"] }, "person", true);
    expect(result).toMatchObject({ ok: false, code: "RADAR_DIRECTION_INVALID", fieldErrors: { "directions/0": "方向要写成一句话", "sources/0": PUBLIC_DOMAIN } });
  });

  it("公司模式只收订阅源；方向 id 记为 manual:<12>", () => {
    const ok = normalizeRadarSettings({ directions: ["大模型定价"], sources: ["theinformation.com", "https://www.ft.com/world"] }, "company", false);
    expect(ok).toEqual({
      ok: true,
      directions: [{ id: `manual:${hashId("大模型定价")}`, text: "大模型定价" }],
      sources: [
        { setting: { value: "theinformation.com", name: "The Information", kind: "feed", note: "订阅源" }, outletId: "theinformation" },
        { setting: { value: "ft.com", name: "金融时报", kind: "feed", note: "订阅源" }, outletId: "ft" },
      ],
    });
    const bad = normalizeRadarSettings({ directions: [], sources: ["36kr.com", "wsj.com", "ft.com", "github.com/trending"] }, "company", true);
    expect(bad).toEqual({
      ok: false,
      code: "RADAR_SOURCE_INVALID",
      message: expect.any(String),
      fieldErrors: {
        "sources/0": "公司雷达已经在全网按方向检索；单独的网站只有在有订阅源时才能加入",
        "sources/1": "订阅源已停更，暂不支持",
        "sources/3": "榜单只能加进个人雷达",
      },
    });
  });
});

describe("建议来源只放能如实读的", () => {
  it("成员：8 家订阅源、GitHub Trending（读取榜单）加 36氪、机器之心（写明结果可能少）；不含华尔街日报、Hacker News", () => {
    const suggestions = sourceSuggestions("person", true);
    expect(suggestions.map((item) => item.value)).toEqual([
      "ft.com", "qbitai.com", "theinformation.com", "bbc.com", "bloomberg.com", "reuters.com", "cnbc.com", "economist.com",
      "github.com/trending", "36kr.com", "jiqizhixin.com",
    ]);
    expect(suggestions.length).toBeLessThanOrEqual(12);
    expect(suggestions.filter((item) => item.kind === "site").every((item) => item.note === SITE_NOTE)).toBe(true);
    expect(suggestions.find((item) => item.kind === "list")).toEqual({ value: "github.com/trending", name: "GitHub Trending", kind: "list", note: LIST_NOTE });
    expect(suggestions.every((item) => item.kind !== "unsupported")).toBe(true);
  });

  it("全网检索没开通时，读不到的网站不进建议（榜单直接读页面，照常建议）；公司只建议订阅源", () => {
    expect(sourceSuggestions("person", false).map((item) => item.kind)).toEqual([...Array(8).fill("feed"), "list"]);
    expect(sourceSuggestions("company", true).map((item) => item.kind)).toEqual(Array(8).fill("feed"));
  });
});
