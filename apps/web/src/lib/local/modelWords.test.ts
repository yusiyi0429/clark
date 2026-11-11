import { describe, expect, it } from "vitest";
import { createMockRunner } from "./mock";
import { matchModelWords } from "./modelWords";

/** 假本机连着的：Claude 订阅（自动、Haiku 5.5，目录里 Opus 5.5、Sonnet 5.5、Fable 5.2、Haiku 4.5）、Codex 订阅（GPT-6.1-Sol、GPT-5.5）、TokenHub（deepseek-v4.1-flash）。 */
const catalog = async (codex: "logged_in" | "logged_out" = "logged_in") => createMockRunner({ stepMs: 1, codex }).listModels();

describe("对话里说的模型要求对这台电脑的来源（第 69 条）", () => {
  it("只说模型：照模型目录认（全名或系列简称，可带版本号），来源和思考照原来的", async () => {
    const models = await catalog();
    expect(matchModelWords("这几件用 Opus 做", models)).toEqual({ matched: true, modelId: "cc-opus", effort: null });
    expect(matchModelWords("用 sonnet 5.5", models)).toEqual({ matched: true, modelId: "cc-sonnet", effort: null });
    expect(matchModelWords("换成 GPT-5.5", models)).toEqual({ matched: true, modelId: "codex-gpt-5_5", effort: null });
    expect(matchModelWords("用 deepseek 就行", models)).toEqual({ matched: true, modelId: "tokenhub-deepseek", effort: null });
  });

  it("只说来源：用那个来源的默认模型；「订阅」只连着一家时就是那家", async () => {
    expect(matchModelWords("用 TokenHub 跑", await catalog())).toEqual({ matched: true, modelId: "tokenhub-deepseek", effort: null });
    expect(matchModelWords("走 Codex 订阅", await catalog())).toMatchObject({ matched: true, modelId: expect.stringMatching(/^codex-/) });
    expect(matchModelWords("用订阅做", await catalog("logged_out"))).toEqual({ matched: true, modelId: "subscription", effort: null });
    // 两家订阅都连着、又没说模型：分不出是哪家，不猜。
    expect(matchModelWords("用订阅做", await catalog())).toEqual({ matched: false });
  });

  it("只说思考：模型照原来的，只换思考档；中文要跟「档」「思考」连着说，英文档位也认", async () => {
    const models = await catalog();
    expect(matchModelWords("思考开高一点", models)).toEqual({ matched: true, modelId: null, effort: "high" });
    expect(matchModelWords("超高档", models)).toEqual({ matched: true, modelId: null, effort: "xhigh" });
    expect(matchModelWords("effort: max", models)).toEqual({ matched: true, modelId: null, effort: "max" });
    // 「高」不跟「档」「思考」连着的不算（「高质量」不是思考档）。
    expect(matchModelWords("要高质量", models)).toEqual({ matched: false });
  });

  it("三样都说：「这几件用本机的 Claude 订阅 Opus，思考开超高」", async () => {
    expect(matchModelWords("这几件用本机的 Claude 订阅 Opus，思考开超高", await catalog())).toEqual({ matched: true, modelId: "cc-opus", effort: "xhigh" });
    expect(matchModelWords("TokenHub 的 Opus 5.5 高档", [...(await catalog()), {
      id: "th-opus", label: "Opus 5.5", source: "gateway", agent: "claude-code", baseUrl: null, model: "wangsu/claude-opus-5-5", smallModel: null, webSearch: true, hasKey: true,
      isDefault: false, efforts: [], defaultEffort: null, origin: { provider: "tokenhub", label: "TokenHub", via: null }, modelName: "Opus 5.5" }])).toEqual({ matched: true, modelId: "th-opus", effort: "high" });
  });

  it("说了这台电脑没连的来源、没有的模型：没对上", async () => {
    expect(matchModelWords("用 Codex 订阅做", await catalog("logged_out"))).toEqual({ matched: false });
    expect(matchModelWords("用 GPT 做", await catalog("logged_out"))).toEqual({ matched: false });
    expect(matchModelWords("用 Kimi 做", await catalog())).toEqual({ matched: false });
    expect(matchModelWords("用 Opus 4.6", await catalog())).toEqual({ matched: false });
    // 来源有、但这个来源里没有那个模型。
    expect(matchModelWords("TokenHub 的 Sonnet", await catalog())).toEqual({ matched: false });
  });

  it("同一样说了两个（两个模型、两个来源、两档思考）：没对上，不猜", async () => {
    const models = await catalog();
    expect(matchModelWords("Opus 或者 Sonnet 都行", models)).toEqual({ matched: false });
    expect(matchModelWords("先用 Opus 5.5 再用 Haiku 5.5", models)).toEqual({ matched: false });
    expect(matchModelWords("TokenHub 或 Claude 订阅", models)).toEqual({ matched: false });
    expect(matchModelWords("思考低档，难的高档", models)).toEqual({ matched: false });
  });

  it("一句无关的话：没对上", async () => {
    expect(matchModelWords("这几件今天做完", await catalog())).toEqual({ matched: false });
  });
});
