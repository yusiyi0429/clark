/**
 * 选家、说清用的是谁、以及**同时用几家**那一层。
 *
 * 这个文件里没有一次真的网络调用：家名到构造的映射、去重与记账、失败隔离都是纯逻辑，
 * 而它们的坏法全都是静默的 —— 配了三家只有一家在跑、两家搜到同一页被算成两个来源、
 * 一家限流把整轮判成「外面没东西」。三种在报告上都表现成「这一轮证据少」。
 */
import { afterAll, beforeEach, describe as group, expect, it } from "vitest";

import { describe, freshness, providerCode, providerLabel, providers, searchAll, type SearchHit, type SearchProvider } from "./search";

/** 这个文件动的环境变量。每条用例前清空，跑完还回去。 */
const KEYS = [
  "TKOS_MODEL_MOCK",
  "TKOS_SEARCH_PROVIDER",
  "TKOS_SEARCH_BOCHA_KEY",
  "TKOS_SEARCH_DOUBAO_KEY",
  "TKOS_SEARCH_API_KEY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** 一把假口令。**断言里要检查它不出现在任何给人看的字里。** */
const FAKE_KEY = "sk-not-a-real-key-0123456789";

/** 一家假检索。`urls` 可以按检索式给不同的页。 */
const fake = (
  name: string,
  label: string,
  urls: string[] | ((q: string) => string[]),
  opts: { windowed?: boolean; fail?: string } = {}
): SearchProvider => ({
  name,
  label,
  windowed: opts.windowed ?? true,
  reason: "",
  async search(q: string): Promise<SearchHit[]> {
    if (opts.fail) throw new Error(opts.fail);
    return (typeof urls === "function" ? urls(q) : urls).map((u) => ({
      title: `${label}：${u}`,
      url: u,
      snippet: `${label} 的摘要`,
      sourceDomain: u.split("/")[2] ?? "",
    }));
  },
});

group("选家", () => {
  it("没配就是不搜，而这是正常状态", async () => {
    // `reason` 空 = 故意不搜。非空是「配坏了」，两者在产出上一样、在处理上完全不同。
    const { list, skipped } = providers();
    expect(list.map((p) => p.name)).toEqual(["none"]);
    expect(list[0].reason).toBe("");
    expect(skipped).toEqual([]);
    expect(providers("none").list[0].name).toBe("none");
  });

  it("一串家名按写的顺序返回 —— 顺序就是同一页留谁摘要的优先级", async () => {
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    process.env.TKOS_SEARCH_DOUBAO_KEY = FAKE_KEY;
    expect(providers("bocha,doubao").list.map((p) => p.name)).toEqual(["bocha", "doubao"]);
    // 反过来写就是反过来的优先级，不许被内部排序抹平。
    expect(providers("doubao,bocha").list.map((p) => p.name)).toEqual(["doubao", "bocha"]);
  });

  it("分隔符宽容，重复的收一次，none 混在里面当没写", async () => {
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    process.env.TKOS_SEARCH_DOUBAO_KEY = FAKE_KEY;
    // 手填的配置里逗号、中文逗号、空格都会出现；卡在这种事上等于让人去猜格式。
    expect(providers("bocha， doubao").list.map((p) => p.name)).toEqual(["bocha", "doubao"]);
    expect(providers("BOCHA, bocha").list.map((p) => p.name)).toEqual(["bocha"]);
    expect(providers("bocha,none").list.map((p) => p.name)).toEqual(["bocha"]);
  });

  it("认不出的家名不静默：能用的照跑，那一家的原话留着", async () => {
    /*
     * 真发生过：`.env` 里填了个从未实现的家名，一声不响退回空检索，照样出一份格式漂亮
     * 的报告。这里钉的是**部分坏掉**那一档 —— 另一家还在跑，所以最容易被忽略。
     */
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    const { list, skipped } = providers("bocha,tavily");
    expect(list.map((p) => p.name)).toEqual(["bocha"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("tavily");
    // 可选项要报出来，不然看的人只能去翻代码。
    expect(skipped[0]).toContain("bocha");
  });

  it("配了家名却少配 key：说的是变量名，不是 key", async () => {
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    const { list, skipped } = providers("bocha,doubao");
    expect(list.map((p) => p.name)).toEqual(["bocha"]);
    expect(skipped[0]).toContain("TKOS_SEARCH_DOUBAO_KEY");
    // 口令、长度、哈希一概不进 —— 这句话会落进运行记录。
    expect(skipped[0]).not.toContain(FAKE_KEY);
    expect(skipped[0]).not.toContain(String(FAKE_KEY.length));
  });

  it("一家都用不上时退回空检索，原话带着全部成因", async () => {
    const { list, skipped } = providers("bocha,tavily");
    expect(list.map((p) => p.name)).toEqual(["none"]);
    // 两条成因都要在：只写第一条会让人改完一处发现还是空手。
    expect(list[0].reason).toContain("TKOS_SEARCH_BOCHA_KEY");
    expect(list[0].reason).toContain("tavily");
    expect(list[0].reason).toContain("本次外部证据为空");
    // 全军覆没时话在 reason 里，不再重复一份到 skipped —— 两处各说一半最难读。
    expect(skipped).toEqual([]);
  });

  it("单家时代那个通用 key 名还认", async () => {
    // `.env.example` 里写着它是回落。哪天真要删，这条会红。
    process.env.TKOS_SEARCH_API_KEY = FAKE_KEY;
    expect(providers("doubao").list.map((p) => p.name)).toEqual(["doubao"]);
  });

  it("MOCK=1 压倒一切 —— 那个开关的含义是这一轮不出网", async () => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    expect(providers("bocha,doubao").list.map((p) => p.name)).toEqual(["mock"]);
  });
});

group("这次用的是谁", () => {
  it("几家接成一句人话，代号和上屏的说法分开", async () => {
    const list = [fake("bocha", "博查", []), fake("doubao", "豆包搜索", [])];
    expect(providerCode(list)).toBe("bocha+doubao");
    expect(providerLabel(list)).toBe("博查 + 豆包搜索");
    expect(describe(list).检索).toBe("博查 + 豆包搜索");
  });

  it("不认时间窗的家要点名，不许写一句笼统的", async () => {
    /*
     * 多家一起跑时写「这家的接口不认窗」，读的人分不出是哪一家的结果没经过窗筛 ——
     * 而那正是「窗没生效」和「窗内真的没东西」唯一的分界。
     */
    const d = describe([fake("bocha", "博查", []), fake("doubao", "豆包搜索", [], { windowed: false })]);
    expect(d.时间窗).toContain("豆包搜索");
    expect(d.时间窗).not.toContain("博查");
    // 全都认窗时这一行根本不该出现。
    expect(describe([fake("bocha", "博查", [])]).时间窗).toBeUndefined();
  });

  it("没用上的那几家也进 trace", async () => {
    const d = describe([fake("bocha", "博查", [])], ["配了 doubao，但这台机器没配 TKOS_SEARCH_DOUBAO_KEY"]);
    expect(d.没用上的检索家).toContain("TKOS_SEARCH_DOUBAO_KEY");
  });

  it("口令不进 trace", async () => {
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    const { list, skipped } = providers("bocha,doubao");
    const text = JSON.stringify(describe(list, skipped));
    expect(text).not.toContain(FAKE_KEY);
  });
});

group("同时用几家", () => {
  it("每条检索式发给每一家", async () => {
    const asked: string[] = [];
    const spy = (name: string): SearchProvider => ({
      ...fake(name, name, []),
      async search(q: string) {
        asked.push(`${name}:${q}`);
        return [];
      },
    });
    await searchAll([spy("a"), spy("b")], ["问法一", "问法二"], 5);
    expect(asked).toEqual(["a:问法一", "b:问法一", "a:问法二", "b:问法二"]);
  });

  it("同一页被两家搜到只算一条，先列的那家留着", async () => {
    /*
     * 这一条是「多来源」这句话的底线：不去重的话，两家各返回一次同一篇稿子，在独立性
     * 折叠之前就已经被算成两条，而「≥2 组独立来源」那道门会被这种重复喂饱。
     */
    const both = "https://example.com/same";
    const { hits } = await searchAll(
      [fake("bocha", "博查", [both]), fake("doubao", "豆包搜索", [both, "https://other.com/x"])],
      ["问法"],
      5
    );
    expect(hits.map((x) => x.url)).toEqual([both, "https://other.com/x"]);
    // 留下的是先列那家给的那一份（标题、摘要都是它的）。
    expect(hits[0].provider).toBe("bocha");
    expect(hits[0].title).toContain("博查");
  });

  it("每家的账分开记：returned 含重复，unique 才是它独有的贡献", async () => {
    const both = "https://example.com/same";
    const { perProvider } = await searchAll(
      [fake("bocha", "博查", [both, "https://a.com/1"]), fake("doubao", "豆包搜索", [both, "https://b.com/2"])],
      ["问法"],
      5
    );
    expect(perProvider.bocha).toEqual({ label: "博查", returned: 2, unique: 2 });
    // 豆包返回两条，其中一条被先收下了 —— 它这一轮只带来一条新东西。
    expect(perProvider.doubao).toEqual({ label: "豆包搜索", returned: 2, unique: 1 });
  });

  it("一家挂掉不拖垮这一轮，原话带家名", async () => {
    // 限流、额度用尽是常态。把整次深研判失败是过度反应，而静默吞掉更糟。
    const { hits, errors, perProvider } = await searchAll(
      [fake("bocha", "博查", [], { fail: "超了 5 QPS" }), fake("doubao", "豆包搜索", ["https://ok.com/1"])],
      ["问法"],
      5
    );
    expect(hits.map((x) => x.url)).toEqual(["https://ok.com/1"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("博查");
    expect(errors[0]).toContain("问法");
    expect(errors[0]).toContain("超了 5 QPS");
    // 挂掉的那家也要有一格账：0 条和「没这一家」是两件事。
    expect(perProvider.bocha).toEqual({ label: "博查", returned: 0, unique: 0 });
  });

  it("全挂了就是空手回来，不抛异常", async () => {
    const { hits, errors } = await searchAll(
      [fake("bocha", "博查", [], { fail: "401" }), fake("doubao", "豆包搜索", [], { fail: "10406" })],
      ["问法"],
      5
    );
    expect(hits).toEqual([]);
    expect(errors).toHaveLength(2);
  });

  it("每条命中都答得出「谁搜来的、哪个问法搜来的」", async () => {
    // 补搜时要能回答这句话，否则一条证据的来历断在检索这一层。
    const { hits } = await searchAll([fake("bocha", "博查", (q) => [`https://e.com/${encodeURIComponent(q)}`])], ["问法一"], 5);
    expect(hits[0].matchedQuery).toBe("问法一");
    expect(hits[0].provider).toBe("bocha");
  });

  it("空检索式跳过，没有 url 的一条不收", async () => {
    const noUrl: SearchProvider = {
      ...fake("x", "X", []),
      async search() {
        return [{ title: "没有地址", url: "", snippet: "", sourceDomain: "" }];
      },
    };
    const { hits, perProvider } = await searchAll([noUrl], ["", "  ", "真的问法"], 5);
    expect(hits).toEqual([]);
    // 没有地址的一条也不进 returned：它连「返回过一条能打开的页」都不算。
    expect(perProvider.x).toEqual({ label: "X", returned: 0, unique: 0 });
  });
});

group("时间窗桶", () => {
  it("向上取整 —— 桶必须 ≥ 窗", async () => {
    /*
     * 取到更小的桶等于让检索端先砍掉本地时窗还想留的条目，而漏斗上看不出是谁砍的。
     */
    expect(freshness(1)).toBe("oneDay");
    expect(freshness(24)).toBe("oneDay");
    expect(freshness(25)).toBe("oneWeek");
    expect(freshness(168)).toBe("oneWeek");
    expect(freshness(169)).toBe("oneMonth");
    expect(freshness(8760)).toBe("oneYear");
  });

  it("不限窗和荒谬的窗都落 noLimit", async () => {
    expect(freshness(0)).toBe("noLimit");
    expect(freshness(-5)).toBe("noLimit");
    expect(freshness(99999)).toBe("noLimit");
  });
});

/* -------------------------------------------------------------------------- */
/* 接口报错的原话                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 一家挂掉时，**说出来的那句话要够用**。
 *
 * 这一组钉的是一次真实的排查：某一轮二十条检索式条条失败，现场只有两句话 ——
 * 「检索接口返回 HTTP 403」和「豆包搜索失败 code=10406: Free quota has been exhausted.」。
 * 第一句丢掉了响应体，而 403 的成因（口令错 / 服务未开 / 欠费 / 被封）全写在体里；第二句
 * 那个「额度」被读成了「火山账号里的余额」—— 而那是两个开关，账号里有余额、这把 key 没在
 * 已开通的付费模式下，照样 10406。两句话都通向了错误的下一步。
 */
group("接口报错的原话", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  /** 让下一次 fetch 返回指定的响应。`status` 非 2xx 时只会被读 `text()`。 */
  const answer = (status: number, body: string) => {
    globalThis.fetch = (async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
      }) as unknown as Response) as typeof fetch;
  };
  /** 单跑一家真适配器，把它抛的那句话拿回来。 */
  const said = async (spec: string): Promise<string> => {
    process.env.TKOS_SEARCH_BOCHA_KEY = FAKE_KEY;
    process.env.TKOS_SEARCH_DOUBAO_KEY = FAKE_KEY;
    const [p] = providers(spec).list;
    try {
      await p.search("问法", 5);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  it("HTTP 不是 2xx 时把响应体带上 —— 光有状态码答不出下一步", async () => {
    answer(403, '{"code":403,"msg":"账户余额不足，请充值后重试","log_id":"abc"}');
    const msg = await said("bocha");
    expect(msg).toContain("403");
    // 体里那句才是唯一说得出该做什么的话。
    expect(msg).toContain("账户余额不足");
  });

  it("体太长就截断，而口令一个字都不许出现", async () => {
    // 万一哪家把请求原样回显（真有接口这么干），截出来的那一段会带着 key。
    answer(401, `{"key":"${FAKE_KEY}","msg":"${"很长的废话".repeat(200)}"}`);
    const msg = await said("bocha");
    expect(msg).not.toContain(FAKE_KEY);
    expect(msg.length).toBeLessThan(400);
  });

  it("HTTP 200 里的空响应体不许被说成报错", async () => {
    // 这一层只管「接口有没有出网成功」。搜不到东西是 0 条结果，不是异常。
    answer(200, "{}");
    expect(await said("bocha")).toBe("");
  });

  it("10406 说清「有余额」和「开通了付费调用」是两个开关", async () => {
    answer(200, JSON.stringify({
      ResponseMetadata: { Error: { CodeN: 10406, Code: "10406", Message: "Free quota has been exhausted." } },
      Result: null,
    }));
    const msg = await said("doubao");
    expect(msg).toContain("10406");
    // 每个火山账号每月 500 次免费额度，与 Global 版共用、无论是否开通付费都优先消耗。
    expect(msg).toContain("免费额度");
    // 这一句是这次排查真正卡住的地方 —— 账号里有余额，付费调用没开，照样 10406。
    expect(msg).toContain("有余额不等于");
  });

  it("会真的发生的那几个码都配了一句人话", async () => {
    for (const [code, expected] of [
      ["10400", "请求结构"],
      ["10402", "搜索类型"],
      ["10403", "没开通"],
      ["10408", "没开通付费"],
      ["10412", "订阅套餐"],
      ["10500", "重试"],
      ["700429", "QPS"],
    ] as const) {
      answer(200, JSON.stringify({
        ResponseMetadata: { Error: { CodeN: Number(code), Code: code, Message: "boom" } },
      }));
      const msg = await said("doubao");
      expect(msg, `code=${code}`).toContain(code);
      expect(msg, `code=${code}`).toContain(expected);
    }
  });

  it("没见过的码照样把码和原话带出来", async () => {
    // 配没配人话是我们的事，把码和厂商原话交出去是底线 —— 没有它连查文档都无从下手。
    answer(200, JSON.stringify({
      ResponseMetadata: { Error: { CodeN: 19999, Code: "19999", Message: "brand new failure" } },
    }));
    const msg = await said("doubao");
    expect(msg).toContain("19999");
    expect(msg).toContain("brand new failure");
  });
});
