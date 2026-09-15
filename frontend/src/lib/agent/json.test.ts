/**
 * 出稿被额度截断之后那一支（补遗 §3 的 `finish_reason: length` 自动续写）。
 *
 * 要钉的是接缝。一份写足了整包证据的报告本来就可能超过任何一个模型的单次输出上限，而
 * 截断的表现是**报告在半句话上停住** —— 屏幕上照旧是一份看着正常的报告，少的那几节
 * 没有任何症状。所以这里逐条钉：接得上、接得对齐、接不上时照旧抛、以及接完还是不全时
 * 那件事在 trace 上看得见。
 *
 * 打桩注意（同 `a6/extract.test.ts`）：先静态 import 被测方，再动态 import 被 mock 的
 * 模块 —— 顺序反了，`vi.importActual` 会把真模块塞进模块缓存。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callModelJson, noBodyWhy } from "./json";

vi.mock("@/lib/models/complete", async () => {
  const actual = await vi.importActual<typeof import("@/lib/models/complete")>("@/lib/models/complete");
  return { ...actual, callModel: vi.fn() };
});

const { callModel } = await import("@/lib/models/complete");
const mocked = vi.mocked(callModel);

type Reply = Awaited<ReturnType<typeof callModel>>;

const reply = (text: string, stopReason: "stop" | "length", ms = 10): Reply =>
  ({
    text,
    usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 0, reasoningTokens: 0 },
    ms,
    slot: "synth",
    alias: "gpt-5.6",
    providerModelId: "mock",
    effortSent: "medium",
    stopReason,
  }) as unknown as Reply;

const MSGS = [{ role: "user", content: "写这一节" }];

beforeEach(() => {
  mocked.mockReset();
});

describe("没截断的那一次", () => {
  it("原样交回，不多发一次调用", async () => {
    mocked.mockResolvedValue(reply(`{"type":"prose"}\n`, "stop"));
    const r = await callModelJson(MSGS, { jsonlContinue: 2 });
    expect(r.text).toBe(`{"type":"prose"}\n`);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("正文是空的照旧抛 —— 空前缀递回去有几个口直接拒", async () => {
    mocked.mockResolvedValue(reply("", "stop"));
    await expect(callModelJson(MSGS, { jsonlContinue: 2 })).rejects.toThrow("没有正文");
  });
});

describe("截断了、调用方没要续写", () => {
  it("当场抛，原话里带那次报的额度", async () => {
    // 说得清是额度不够。落到下游的话，截断的 JSON 交出来的是一个看不懂的 SyntaxError。
    mocked.mockResolvedValue(reply(`{"type":"prose"}\n{"type":"jud`, "length"));
    await expect(callModelJson(MSGS, { maxTokens: 9000 })).rejects.toThrow("max_tokens(9000)");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("onLength=keep：按整行收尾把写完的带回去，stopReason 照旧是 length（2026-09-04）", async () => {
    // ISS-229：四节全在 8000 上被截、全部抛掉、正文 0 块。分节要的是丢最后半块，不是丢整节。
    mocked.mockResolvedValue(reply(`{"type":"prose"}\n{"type":"jud`, "length"));
    const r = await callModelJson(MSGS, { maxTokens: 8000, onLength: "keep" });
    expect(r.text).toBe(`{"type":"prose"}`);
    expect(r.stopReason).toBe("length");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("onLength=keep 但一行都没写完：仍然抛 —— 没有可以留的东西", async () => {
    mocked.mockResolvedValue(reply(`{"type":"pro`, "length"));
    await expect(callModelJson(MSGS, { maxTokens: 8000, onLength: "keep" })).rejects.toThrow("max_tokens(8000)");
  });
});

describe("截断了、要续写", () => {
  it("接缝按整行对齐：写残的那一行整行丢掉", async () => {
    /*
     * 留着那半行的话解析器会记一条坏行，而那一行的内容本来就不全 —— 运营台上于是多一条
     * 「有 1 行没解析出来」，读的人会去查模型写错了什么，而它什么都没写错。
     */
    mocked
      .mockResolvedValueOnce(reply(`{"a":1}\n{"b":2}\n{"c":3, "half`, "length"))
      .mockResolvedValueOnce(reply(`{"c":3}\n{"d":4}\n`, "stop"));
    const r = await callModelJson(MSGS, { maxTokens: 100, jsonlContinue: 2 });
    expect(r.text).toBe(`{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}`);
    expect(r.stopReason).toBe("stop");
  });

  it("递回去的是「已经写出来的那一段 + 接着往下写」，不是重新问一遍", async () => {
    mocked
      .mockResolvedValueOnce(reply(`{"a":1}\n{"b":`, "length"))
      .mockResolvedValueOnce(reply(`{"b":2}\n`, "stop"));
    await callModelJson(MSGS, { jsonlContinue: 1 });

    const second = mocked.mock.calls[1][0].messages;
    expect(second.slice(0, MSGS.length)).toEqual(MSGS);
    expect(second[MSGS.length]).toEqual({ role: "assistant", content: `{"a":1}` });
    expect(second[MSGS.length + 1].role).toBe("user");
    // 不说「接着往下」它会从头再写一遍，交回来的是一份和前半段重复的报告。
    expect(second[MSGS.length + 1].content).toContain("接着往下写");
    expect(second[MSGS.length + 1].content).toContain("不要重复");
  });

  it("token 和耗时按几次加起来 —— 运营台上那一栏报的是这一节真花了多少", async () => {
    mocked
      .mockResolvedValueOnce(reply(`{"a":1}\n{"b":`, "length", 700))
      .mockResolvedValueOnce(reply(`{"b":2}\n`, "stop", 300));
    const r = await callModelJson(MSGS, { jsonlContinue: 1 });
    expect(r.ms).toBe(1000);
    expect(r.usage.outputTokens).toBe(400);
    expect(r.usage.inputTokens).toBe(200);
  });

  it("续到最后还是不全时，stopReason 照实留着 length", async () => {
    // 抹成 stop 的话「这一份是不全的」就没有任何地方看得见了 —— trace 上记的就是这个字段。
    mocked.mockResolvedValue(reply(`{"a":1}\n{"b":`, "length"));
    const r = await callModelJson(MSGS, { jsonlContinue: 2 });
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(r.stopReason).toBe("length");
    expect(r.text).toBe(`{"a":1}\n{"a":1}\n{"a":1}`);
  });

  it("一行都没写完就截断的照旧抛：那不是写得太长，是额度压根不够", async () => {
    mocked.mockResolvedValue(reply(`{"type":"prose","md":"这一行还没写完`, "length"));
    await expect(callModelJson(MSGS, { maxTokens: 60, jsonlContinue: 3 })).rejects.toThrow("一行都没写完");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("轮数给 0 和不给是一件事", async () => {
    mocked.mockResolvedValue(reply(`{"a":1}\n{"b":`, "length"));
    await expect(callModelJson(MSGS, { jsonlContinue: 0 })).rejects.toThrow("截断");
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 「没有正文」那一句话                                                          */
/* -------------------------------------------------------------------------- */

describe("noBodyWhy", () => {
  /**
   * 这一组钉的是**报错要把人指对地方**，不是措辞。
   *
   * 上一版这一句恒为「模型返回里没有正文。」。2026-08-29 一号位报预研跑不成，
   * 记录里只有这一句 —— 而收笔原因当时就在手上，只是被扔了。第一反应因此是
   * 「新加的那几次调用额度给小了」，逐个拿真模型验完两个都好好的，
   * 最后才定位到第三个。**那一栏本来能一句话指对地方。**
   *
   * 所以断言不看整句长什么样（那种测试改一个字就红、然后被人顺手改成新句），
   * 只看三件事：额度那一档要提额度、拒答那一档**不许**提额度、
   * 以及收笔原因本身必须出现在话里。
   */
  const base = {
    text: "",
    usage: { inputTokens: 100, outputTokens: 1500, cachedInputTokens: 0, reasoningTokens: 1500 },
    ms: 1,
    queuedMs: 0,
    slot: "pro" as const,
    alias: "x",
    providerModelId: "y",
    effortSent: null,
  };

  it("额度花在思考上：要说到额度，而且带上思考花了多少", () => {
    const s = noBodyWhy({ ...base, stopReason: "length" });
    expect(s).toContain("额度");
    expect(s).toContain("1500");
  });

  it("拒答：**不许**把人往调额度上引", () => {
    // 这一条是这一组里最要紧的。拒答改额度改不好，而上一版那句通用话
    // 会让人一路去翻 maxTokens —— 那是把人指向一个必然徒劳的方向。
    for (const reason of ["content_filter", "refusal"]) {
      const s = noBodyWhy({ ...base, stopReason: reason });
      expect(s).toContain(reason);
      expect(s).toContain("拒答");
      expect(s).not.toContain("调大");
    }
  });

  it("收笔原因没给：照实说没给，不编一个", () => {
    const s = noBodyWhy({ ...base, stopReason: "" });
    expect(s).toContain("没给");
  });

  it("认不出的收笔原因原样带出来", () => {
    // `complete.ts` 的归一有意保留认不出的值（`pause_turn`、`tool_use` 这些）。
    // 这里守住它一路带到人眼前，不被吞成一句通用话。
    expect(noBodyWhy({ ...base, stopReason: "pause_turn" })).toContain("pause_turn");
  });
});
