// Claude 订阅的模型目录（设计 17.2 第 40 条，契约 LocalModelProfile.catalog、modelName）：用假 claude，握手的回执带模型列表；不起本人真装的、不调模型。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalModelListResponse, LocalRun } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { ClaudeCatalog, claudeCatalogFrom, claudeProfileId } from "../src/claudeCatalog.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const FIVE = ["low", "medium", "high", "xhigh", "max"];
// 形状照 11/10 实测 Claude Code 2.1.318 握手回的 models（只留几条）
const MODELS = [
  { value: "default", resolvedModel: "claude-fable-5-2", displayName: "Default (recommended)", description: "Fable 5.2", supportsEffort: true, supportedEffortLevels: FIVE },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks", supportsEffort: true, supportedEffortLevels: FIVE },
  { value: "claude-fable-5-2", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", description: "For your toughest challenges", supportsEffort: true, supportedEffortLevels: FIVE },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers", supportsThinkingOff: true },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", description: "Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max", "turbo"] },
];

describe("握手回的模型列表 → 目录", () => {
  it("不列 default，思考程度只留契约里有的档、不支持选的为空，同名的只留一条；id 是 cc- 加名字", () => {
    expect(claudeCatalogFrom([...MODELS, MODELS[1], { displayName: "没有名字" }])).toEqual([
      { model: "opus", label: "Opus 5.5", efforts: FIVE },
      { model: "claude-fable-5-2", label: "Fable 5.2", efforts: FIVE },
      { model: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
      { model: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "medium", "high", "max"] },
    ]);
    expect(claudeCatalogFrom(undefined)).toEqual([]);
    expect(claudeProfileId("claude-fable-5.2")).toBe("cc-claude-fable-5_2");
  });

  it("读到了就换成新的；握手里没有模型列表、一时读不到留着上次的；Claude Code 没装了就清空", async () => {
    const dir = tempDir("tl-cc-unit-");
    let answer: unknown[] | null | Error = MODELS;
    const catalog = new ClaudeCatalog(dir, async () => { if (answer instanceof Error) throw answer; return answer; });
    await catalog.refresh(true);
    expect(catalog.list()).toHaveLength(4);
    answer = [];
    await catalog.refresh(true);
    expect(catalog.list()).toHaveLength(4);
    answer = new Error("握手没过");
    await catalog.refresh(true);
    expect(catalog.list()).toHaveLength(4);
    expect(new ClaudeCatalog(dir, async () => null).list()).toHaveLength(4); // 重启后先用存下的
    answer = null;
    await catalog.refresh(true);
    expect(catalog.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "claude-models.json"), "utf8"))).toEqual([]);
  });
});

describe("Claude 订阅的模型目录", { timeout: 40_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-cc-");
  const dataDir = tempDir("tl-cc-data-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const launches = (id: string) => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.argv?.includes(id));
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (name: string, modelProfileId: string) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage: `做 ${name}`, modelProfileId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  beforeAll(async () => {
    // 本机读目录时在数据目录里起假 claude：它的握手回执带这份模型列表
    writeFileSync(join(dataDir, ".fake-claude.json"), JSON.stringify({ models: MODELS }));
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ dataDir, pickFolder: work, fetchImpl: offline });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    writeFileSync(join(work, ".fake-claude.json"), "{}");
  });
  afterAll(() => t.cleanup());

  it("每个模型一条只读的配置，带给人看的模型名和能选的思考档；内置那条叫「自动」，来源都是「Claude 订阅」", async () => {
    const profiles = await until(async () => { const r = (await call("GET", "/v1/models")).body; return r.profiles.some((p: any) => p.id === "cc-opus") ? r.profiles : null; });
    expect(Value.Check(LocalModelListResponse, { profiles })).toBe(true);
    expect(profiles.map((p: any) => [p.id, p.modelName, p.catalog, p.efforts.length])).toEqual([
      ["subscription", "自动", false, 5], ["cc-opus", "Opus 5.5", true, 5], ["cc-claude-fable-5-2", "Fable 5.2", true, 5],
      ["cc-claude-haiku-4-5-20251001", "Haiku 4.5", true, 0], ["cc-claude-opus-4-6", "Opus 4.6", true, 4],
    ]);
    expect(profiles[0]).toMatchObject({ label: "Claude 订阅", isDefault: true, model: null, origin: { provider: "claude-subscription", label: "Claude 订阅", via: null } });
    expect(profiles[2]).toMatchObject({
      label: "Fable 5.2", source: "subscription", agent: "claude-code", model: "claude-fable-5-2", baseUrl: null, isDefault: false, defaultEffort: null, hasKey: false,
      origin: { provider: "claude-subscription", label: "Claude 订阅", via: null },
    });
    // 读到的存进数据目录（重启后、一时读不到时还认得）
    expect(JSON.parse(readFileSync(join(dataDir, "claude-models.json"), "utf8"))).toHaveLength(4);
    // 只读：不能改、不能删
    expect((await call("PUT", "/v1/models/cc-opus", { label: "x", source: "subscription", model: "opus" })).status).toBe(400);
    expect((await call("DELETE", "/v1/models/cc-opus")).status).toBe(400);
    // 本人配的照旧：模型名按 model 写
    const mine = await call("PUT", "/v1/models/th", { label: "TokenHub", source: "gateway", baseUrl: "https://tokenhub.example.com", model: "wangsu/qwen3.8-flash", apiKey: "sk-test-0123456789" });
    expect(mine.body).toMatchObject({ modelName: "qwen3.8-flash", catalog: false, origin: { label: "TokenHub" } });
  });

  it("用目录里的模型开工：名字原样传 --model；卡上来源写「Claude 订阅」、模型写它的显示名；不支持选思考程度的不写思考档", async () => {
    const preview = (await call("POST", "/v1/runs/preview", { modelProfileId: "cc-claude-fable-5-2", effort: "xhigh" })).body;
    expect(Value.Check(LocalRun, preview)).toBe(true);
    expect(preview).toMatchObject({ source: "subscription", sourceLabel: "Claude 订阅", harness: "claude-code", model: "claude-fable-5-2", modelName: "Fable 5.2", effort: "xhigh" });
    expect((await call("POST", "/v1/runs/preview", { modelProfileId: "cc-claude-haiku-4-5-20251001" })).body).toMatchObject({ modelName: "Haiku 4.5", effort: null });
    expect((await call("POST", "/v1/runs/preview", { modelProfileId: "cc-claude-haiku-4-5-20251001", effort: "high" })).status).toBe(400);
    const s = await open("A", "cc-claude-fable-5-2");
    expect(s).toMatchObject({ agent: "claude-code", modelProfileId: "cc-claude-fable-5-2", modelLabel: "Fable 5.2", run: { sourceLabel: "Claude 订阅", modelName: "Fable 5.2" } });
    const argv = launches(s.id)[0].argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-fable-5-2");
    // 同一个来源里换模型：当场换（set_model），不重开
    const swapped = await call("PUT", `/v1/sessions/${s.id}/model`, { modelProfileId: "cc-opus" });
    expect(swapped.body).toMatchObject({ applied: "now", session: { modelProfileId: "cc-opus", run: { model: "opus", sourceLabel: "Claude 订阅" } } });
    expect(launches(s.id)).toHaveLength(1);
    // 换回「自动」：内置那条，本机按档位挑
    const auto = await call("PUT", `/v1/sessions/${s.id}/model`, { modelProfileId: "subscription" });
    expect(auto.body).toMatchObject({ applied: "now", session: { modelProfileId: "subscription", modelLabel: "Claude 订阅" } });
    await call("POST", `/v1/sessions/${s.id}/kill`, {});
    await until(async () => (await session(s.id)).status === "exited");
  });

  it("Claude Code 握手里没有模型列表（老版本）：目录是空的，内置那条照旧", async () => {
    const empty = tempDir("tl-cc-empty-");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const other = await startTestRunner({ dataDir: empty, fetchImpl: offline });
    try {
      const tk = await pair(other.port);
      await api(other.port, tk, "GET", "/v1/models");
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await api(other.port, tk, "GET", "/v1/models")).body.profiles.map((p: any) => p.id)).toEqual(["subscription"]);
      expect(existsSync(join(empty, "claude-models.json"))).toBe(false);
    } finally {
      await other.cleanup();
    }
  });
});
