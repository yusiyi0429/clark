// 本机按档位挑模型（验收员由本机自己起时用）：只在默认模型那个来源里挑，同网页的 modelForTier（11/11 本人定 A）。
import { describe, expect, it } from "vitest";
import { ModelProfiles, runLine } from "../src/models.js";
import { FileSecretStore } from "../src/secrets.js";
import { tempDir } from "./helpers.js";

const TH_URL = "https://tokenhub.corp.tokenkingos.com/api/anthropic";
const TH_MODELS = ["wangsu/claude-opus-5-5", "wangsu/claude-sonnet-5-5", "wangsu/deepseek-v4.1-flash"];

describe("forTier：只在默认来源里挑", () => {
  it("默认是订阅：本人配的订阅模型按档位挑；连了 TokenHub 也不挑 TokenHub 的", async () => {
    const dir = tempDir("tl-tier-");
    const models = new ModelProfiles(dir, new FileSecretStore(dir));
    expect(models.forTier("strong")).toBe("subscription");
    await models.setTokenHub(TH_URL, "th-fake", TH_MODELS);
    expect(["strong", "normal", "light"].map((t) => models.forTier(t as "strong"))).toEqual(["subscription", "subscription", "subscription"]);
    await models.upsert("my-opus", { label: "Opus", source: "subscription", model: "opus" });
    expect(models.forTier("strong")).toBe("my-opus");
    expect(models.forTier("light")).toBe("subscription");
  });

  it("默认设成 TokenHub 的：在 th- 那几条里挑；认不出轻档用默认那条", async () => {
    const dir = tempDir("tl-tier-");
    const models = new ModelProfiles(dir, new FileSecretStore(dir));
    await models.setTokenHub(TH_URL, "th-fake", TH_MODELS);
    await models.upsert("my-opus", { label: "Opus", source: "subscription", model: "opus" });
    const sonnet = "th-wangsu_claude-sonnet-5-5";
    await models.upsert(sonnet, { label: "Sonnet 5.5", source: "gateway", baseUrl: TH_URL, model: "wangsu/claude-sonnet-5-5", isDefault: true });
    expect(models.forTier("strong")).toBe("th-wangsu_claude-opus-5-5");
    expect(models.forTier("normal")).toBe(sonnet);
    expect(models.forTier("light")).toBe("th-wangsu_deepseek-v4_1-flash");
    expect(await models.remove("th-wangsu_deepseek-v4_1-flash")).toBe(true);
    expect(models.forTier("light")).toBe(sonnet);
  });
});

describe("runLine：同步给云端的「来源 · 模型 · 思考」（第 67 条，和网页 runLabel 一字不差）", () => {
  it("来源、模型、思考；实际跑的优先；来源只取给人看的那一段；没选思考不写；没有来源为 null", () => {
    expect(runLine({ sourceLabel: "我的 Claude 订阅", modelName: "Opus 5.5", effort: "high" })).toBe("Claude 订阅 · Opus 5.5 · 高");
    expect(runLine({ sourceLabel: "Claude 订阅", modelName: "Opus", actual: { model: "claude-opus-5-5", modelName: "Opus 5.5", at: "2026-11-11T08:00:00.000Z" }, effort: null })).toBe("Claude 订阅 · Opus 5.5");
    expect(runLine({ sourceLabel: "网关", origin: { provider: "tokenhub", label: "TokenHub · 网宿", via: null }, modelName: "qwen3.8-flash", effort: "xhigh" })).toBe("TokenHub · qwen3.8-flash · 超高");
    expect(runLine({ sourceLabel: "wangsu", modelName: "claude-opus-5-5", effort: null })).toBe("TokenHub · Opus 5.5");
    expect(runLine({ sourceLabel: "Claude 订阅", modelName: "Claude 订阅", effort: "low" })).toBe("Claude 订阅 · 低"); // 模型名和来源一样只写一次
    expect(runLine({ sourceLabel: "Claude 订阅", modelName: null, effort: null })).toBe("Claude 订阅");
    expect(runLine(null)).toBeNull();
    expect(runLine({ modelName: "Opus 5.5", effort: "high" })).toBeNull(); // 老记录没有来源：调用方用配置名
  });
});
