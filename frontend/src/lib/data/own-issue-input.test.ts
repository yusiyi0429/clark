/**
 * 一个框收三种东西 —— 分成哪一支，以及每一支坏掉的时候屏幕上剩下什么。
 *
 * 这里最要紧的两条是「坏掉」那两条：起标题的模型挂了、链接抓不到 —— 都不许抛。他要的是
 * 「这件事记下来」，不是「这件事有个好标题」。抛出去的代价是他打完一整篇字、按下加进
 * 清单、然后什么都没发生。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** 模型那一下的开关：`fail` 打开就当作接不上。 */
const model = { fail: false, title: "抽佣比例压到我们进不去了吗" };

vi.mock("@/lib/agent/json", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/agent/json")>();
  return {
    ...real,
    callJson: async () => {
      if (model.fail) throw new Error("（测试）模型接不上");
      return JSON.stringify({ title: model.title });
    },
  };
});

/** 抓链接那一支单独有自己那份单测，这里只需要它的两种结局。 */
const article = { ok: true, body: "抓回来的正文。".repeat(30) };

vi.mock("./fetch-article", () => ({
  looksLikeUrl: (raw: string) => /^https?:\/\/\S+$/i.test(raw.trim()),
  fetchArticle: async () =>
    article.ok
      ? { ok: true, host: "example.com", title: "页面自己的标题", body: article.body }
      : { ok: false, host: "example.com", why: "要登录才看得到。" },
}));

const { BODY_CAP, TITLE_IT_YOURSELF, readOwnIssueInput } = await import("./own-issue-input");

afterEach(() => {
  model.fail = false;
  article.ok = true;
});

describe("一句话那一支", () => {
  it("原样收下，不叫模型，也不把同一句话再存一遍原文", async () => {
    const got = await readOwnIssueInput("  贝壳在成都的抽佣是不是已经压到我们进不去了  ");
    expect(got.title).toBe("贝壳在成都的抽佣是不是已经压到我们进不去了");
    // 这一支上「标题是参谋起的」那行小字必须不出现 —— 标题就是他自己写的。
    expect(got.titleByModel).toBe(false);
    // 原文留空：同一句话在卡上大字一遍、小字再一遍，看着像系统坏了。
    expect(got.body).toBe("");
    expect(got.link).toBeNull();
    expect(got.note).toBeNull();
  });

  it("这条线以下一次模型都不调", async () => {
    // 模型这时候是坏的。走到它就会拿到首句回落 —— 拿到原样说明根本没走。
    model.fail = true;
    const short = "x".repeat(TITLE_IT_YOURSELF);
    const got = await readOwnIssueInput(short);
    expect(got.title).toBe(short);
    expect(got.titleByModel).toBe(false);
  });
});

describe("一整篇那一支", () => {
  const long = `贝壳在成都把二手房抽佣从 2.5% 降到 2%。${"这一段是正文。".repeat(40)}`;

  it("标题归模型，原文整段留着", async () => {
    const got = await readOwnIssueInput(long);
    expect(got.title).toBe(model.title);
    expect(got.titleByModel).toBe(true);
    expect(got.body).toBe(long);
    expect(got.link).toBeNull();
    expect(got.note).toBeNull();
  });

  it("模型挂了回落成首句，titleByModel 落回 false —— 不抛", async () => {
    model.fail = true;
    const got = await readOwnIssueInput(long);
    expect(got.title).toBe("贝壳在成都把二手房抽佣从 2.5% 降到 2%");
    // 这一下要跟着落回来：不落的话详情页会写「标题是参谋起的」，而那句是假的。
    expect(got.titleByModel).toBe(false);
    // 立案照常 —— 原文一个字没少。
    expect(got.body).toBe(long);
  });

  it("超过上限就截，截掉多少字写进 note", async () => {
    const over = "字".repeat(BODY_CAP + 137);
    const got = await readOwnIssueInput(over);
    expect(got.body).toHaveLength(BODY_CAP);
    expect(got.note).toContain("137 字没收");
  });
});

describe("一个链接那一支", () => {
  it("抓到了：正文进卡，链接留着，并且交代正文是粗抽的", async () => {
    const got = await readOwnIssueInput("https://example.com/a");
    expect(got.title).toBe(model.title);
    expect(got.titleByModel).toBe(true);
    expect(got.body).toBe(article.body);
    expect(got.link).toEqual({ url: "https://example.com/a", host: "example.com" });
    expect(got.note).toContain("粗抽");
  });

  it("抓到了但起标题挂了，用页面自己的标题 —— 那不是参谋起的", async () => {
    model.fail = true;
    const got = await readOwnIssueInput("https://example.com/a");
    expect(got.title).toBe("页面自己的标题");
    expect(got.titleByModel).toBe(false);
  });

  it("抓不到：不抛、不从 URL 里反推标题、照实说参谋没读过", async () => {
    article.ok = false;
    const got = await readOwnIssueInput("https://example.com/paywalled");
    // 标题就是那个链接本身。从 URL 的字里拼一个标题是猜，而猜出来的标题会被他当成
    // 参谋读过那篇东西的证据。
    expect(got.title).toBe("https://example.com/paywalled");
    expect(got.titleByModel).toBe(false);
    expect(got.body).toBe("");
    expect(got.link).toEqual({ url: "https://example.com/paywalled", host: "example.com" });
    expect(got.note).toContain("参谋没读过它");
  });
});
