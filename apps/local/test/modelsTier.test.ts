// 本机按档位挑模型（验收员由本机自己起时用）：只在默认模型那个来源里挑，同网页的 modelForTier（11/11 本人定 A）。
import { describe, expect, it } from "vitest";
import { ModelProfiles } from "../src/models.js";
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
