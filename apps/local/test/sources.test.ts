import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSourceCheckResponse, LocalSourceListResponse, LocalSourceAddResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir, waitFor } from "./helpers.js";

/** 添加来源（设计 17.2 第 52 条，契约 /v1/sources）。厂商都用桩，Key 都是假的；记下每个请求带的 Key，验「套餐 Key 不发请求」。 */
registerFormats();
const ANT = "sk-ant-api03-fake-good-0123456789";
const DS = "sk-fake-deepseek-0123456789";
const PLAN = "sk-sp-fake-plan-0123456789";
const TH = "tkv-fake.account-secret";

type Call = { url: string; key: string | null };
function fakeVendors(calls: Call[], state: { down: boolean }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init?.headers);
    const key = h.get("x-api-key") ?? h.get("authorization")?.replace(/^Bearer /, "") ?? null;
    calls.push({ url, key });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.anthropic.com/v1/models") {
      if (h.get("x-api-key") !== ANT || h.get("anthropic-version") !== "2023-06-01") return json({ type: "error" }, 401);
      return json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }, { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }] });
    }
    if (url === "https://api.deepseek.com/models") {
      if (state.down) throw new TypeError("fetch failed");
      if (key !== DS) return json({ error: "bad key" }, 401);
      return json({ object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    }
    if (url === "https://tokenhub.corp.tokenkingos.com/api/openai/v1/models") {
      if (key !== TH) return json({ msg: "Authorization error" }, 401);
      return json({ data: [{ id: "wangsu/claude-opus-5-5" }, { id: "aliyun/qwen3.8-flash" }] });
    }
    return new Response("{}", { status: 404 }); // 云端、TokenHub 用量这些当没有
  }) as typeof fetch;
}

/** 数据目录里除了钥匙文件，哪儿都不该出现这几把 Key。 */
function filesWithKeys(dir: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesWithKeys(p, keys));
    else if (name !== "secrets.plain.json" && keys.some((k) => readFileSync(p, "utf8").includes(k))) out.push(p);
  }
  return out;
}

describe("添加来源", () => {
  const calls: Call[] = [];
  const state = { down: false };
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let tok: string;
  const work = tempDir("tl-src-work-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, tok, method, path, body);
  const check = (body: object) => call("POST", "/v1/sources/check", body);
  const profiles = async () => (await call("GET", "/v1/models")).body.profiles as any[];
  const secrets = () => { try { return JSON.parse(readFileSync(join(t.dataDir, "secrets.plain.json"), "utf8")); } catch { return {}; } };
  const sentKey = (k: string) => calls.some((c) => c.key === k);

  beforeAll(async () => {
    writeFileSync(join(work, ".fake-claude.json"), "{}");
    t = await startTestRunner({ fetchImpl: fakeVendors(calls, state), pickFolder: work });
    tok = await pair(t.port);
  });
  afterAll(async () => { await t.cleanup(); });

  it("列出预设：9 家（含 Anthropic 官方、TokenHub），种类、地区、能配的执行方；还没有来源", async () => {
    const r = await call("GET", "/v1/sources");
    expect(r.status).toBe(200);
    expect(Value.Check(LocalSourceListResponse, r.body)).toBe(true);
    expect(r.body.presets.map((p: any) => p.id)).toEqual(["anthropic", "tokenhub", "kimi", "glm", "deepseek", "qwen", "minimax", "volcengine", "openrouter"]);
    expect(r.body.presets[0]).toEqual({ id: "anthropic", name: "Anthropic 官方 API", plans: ["api"], regions: [], agents: ["claude-code"] });
    expect(r.body.presets.find((p: any) => p.id === "kimi")).toMatchObject({ plans: ["api", "coding_plan"], regions: ["cn", "intl"] });
    expect(r.body.sources).toEqual([]);
  });

  it("贴 Key 认厂商：sk-ant- 是 Anthropic 官方，读一次模型列表（x-api-key + anthropic-version），建议的排前面", async () => {
    const r = await check({ apiKey: ANT });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSourceCheckResponse, r.body)).toBe(true);
    expect(r.body.recognized).toEqual({ presetId: "anthropic", plan: "api", region: null });
    expect(r.body.models.map((m: any) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(r.body.models[0]).toEqual({ id: "claude-opus-5-5", name: "Opus 5.5" });
    expect(r.body.verified).toBe(true);
    expect(calls.at(-1)).toEqual({ url: "https://api.anthropic.com/v1/models", key: ANT });
    expect(await profiles()).toHaveLength(1); // 只有内置那条：check 什么都不存
  });

  it("厂商不认：422 source_key_rejected；连不上：502 source_unreachable；都不存", async () => {
    const bad = await check({ apiKey: "sk-ant-api03-wrong" });
    expect([bad.status, bad.body.error.code]).toEqual([422, "source_key_rejected"]);
    state.down = true;
    const down = await check({ apiKey: DS, presetId: "deepseek" });
    state.down = false;
    expect([down.status, down.body.error.code]).toEqual([502, "source_unreachable"]);
    expect(Object.keys(secrets())).toEqual([]);
  });

  it("认不出（多家都是 sk- 开头）：recognized 为 null，给候选，不发请求；选了 DeepSeek 再验", async () => {
    const before = calls.length;
    const r = await check({ apiKey: DS });
    expect(r.body).toEqual({ recognized: null, candidates: ["deepseek", "kimi", "qwen", "minimax"], models: [], verified: false });
    expect(calls.length).toBe(before);
    const picked = await check({ apiKey: DS, presetId: "deepseek" });
    expect(picked.body.recognized).toEqual({ presetId: "deepseek", plan: "api", region: null });
    expect(picked.body.models.map((m: any) => m.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"]);
  });

  it("编程套餐（sk-sp- 认成通义千问套餐）、没有不花钱验法的按量（GLM 样子的 Key）：不发请求，回预设模型表，verified false", async () => {
    const plan = await check({ apiKey: PLAN });
    expect(plan.body).toMatchObject({ recognized: { presetId: "qwen", plan: "coding_plan", region: "cn" }, models: [{ id: "qwen3.7-plus" }], verified: false });
    const glmKey = `${"a".repeat(32)}.${"B".repeat(16)}`;
    const glm = await check({ apiKey: glmKey });
    expect(glm.body).toMatchObject({ recognized: { presetId: "glm", plan: "api", region: "cn" }, verified: false });
    // UUID 样子的认成火山方舟（按量有不花钱的模型列表，桩里没有它，回连不上）
    const uuid = await check({ apiKey: "0f8fad5b-d9cb-469f-a165-70867728950e" });
    expect([uuid.status, uuid.body.error?.code, calls.at(-1)?.url]).toEqual([502, "source_unreachable", "https://ark.cn-beijing.volces.com/api/v3/models"]);
    expect(sentKey(PLAN) || sentKey(glmKey)).toBe(false);
  });

  it("加 Anthropic 官方：Key 存一份，每个选的模型一条 src- 模型配置（带 sourceId、来源名、自带搜索开），默认不改；开工拿到地址和 Key", async () => {
    const r = await call("POST", "/v1/sources", { apiKey: ANT, presetId: "anthropic", models: ["claude-opus-5-5", "claude-sonnet-5-5"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSourceAddResponse, r.body)).toBe(true);
    expect(r.body.source).toMatchObject({ id: "anthropic-api", presetId: "anthropic", name: "Anthropic 官方 API", plan: "api", region: null, baseUrl: "https://api.anthropic.com", agents: ["claude-code"], verified: true });
    const src = r.body.profiles.filter((p: any) => p.sourceId === "anthropic-api");
    expect(src.map((p: any) => [p.id, p.model, p.label, p.hasKey, p.webSearch, p.isDefault])).toEqual([
      ["src-anthropic-api-claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", true, true, false],
      ["src-anthropic-api-claude-sonnet-5-5", "claude-sonnet-5-5", "Sonnet 5.5", true, true, false],
    ]);
    expect(src[0].origin).toEqual({ provider: "anthropic", label: "Anthropic 官方 API", via: null });
    expect(r.body.profiles.find((p: any) => p.isDefault).id).toBe("subscription");
    expect(secrets()).toEqual({ "source:anthropic-api": ANT });
    expect(JSON.stringify(r.body)).not.toContain(ANT);

    expect((await call("POST", "/v1/folders/pick", {})).status).toBe(200);
    const s = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "src" }, title: "src", cwd: work, modelProfileId: "src-anthropic-api-claude-opus-5-5", firstMessage: "hi", permissionMode: "default" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const run = await waitFor(() => existsSync(join(work, ".fake-claude-trace.jsonl")) && JSON.parse(readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").split("\n")[0]!));
    expect(run.authToken).toBe(ANT);
    expect(run.argv.join(" ")).not.toContain(ANT);
    expect(JSON.parse(run.argv[run.argv.indexOf("--settings") + 1]).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_MODEL: "claude-opus-5-5" });
    await call("POST", `/v1/sessions/${s.body.id}/kill`, {});
  });

  it("模型配置里能改名字、设默认；改地址、模型、钥匙回 400；不是这把 Key 列得出的模型加不进去", async () => {
    const id = "src-anthropic-api-claude-opus-5-5";
    const base = { label: "主力", source: "gateway", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" };
    expect((await call("PUT", `/v1/models/${id}`, { ...base, isDefault: true })).status).toBe(200);
    for (const bad of [{ baseUrl: "https://evil.example.com" }, { model: "claude-haiku-5-5" }, { apiKey: "sk-ant-other" }]) {
      expect((await call("PUT", `/v1/models/${id}`, { ...base, ...bad })).status).toBe(400);
    }
    expect((await call("PUT", "/v1/models/src-made-up", base)).status).toBe(400);
    const r = await call("POST", "/v1/sources", { apiKey: ANT, presetId: "anthropic", models: ["claude-opus-9"] });
    expect([r.status, r.body.error.code]).toEqual([400, "validation"]);
  });

  it("同一个来源再加一次：换模型（留着改过的名字和默认），这次没选的删掉；单删一条，来源里的模型跟着少", async () => {
    const r = await call("POST", "/v1/sources", { apiKey: ANT, presetId: "anthropic", models: ["claude-opus-5-5", "claude-haiku-5-5"] });
    expect(r.status).toBe(200);
    const src = r.body.profiles.filter((p: any) => p.sourceId === "anthropic-api");
    expect(src.map((p: any) => [p.model, p.label, p.isDefault])).toEqual([["claude-opus-5-5", "主力", true], ["claude-haiku-5-5", "Haiku 5.5", false]]);
    expect((await call("DELETE", "/v1/models/src-anthropic-api-claude-haiku-5-5")).status).toBe(200);
    const list = await call("GET", "/v1/sources");
    expect(list.body.sources.map((s: any) => [s.id, s.models.map((m: any) => m.id)])).toEqual([["anthropic-api", ["claude-opus-5-5"]]]);
    expect(secrets()["source:anthropic-api"]).toBe(ANT); // 单删一条不删共用的 Key
  });

  it("编程套餐（Kimi 国际）：不发请求，地址按预设和地区；自定义：只收 Anthropic 格式、https；数据目录里除了钥匙文件找不到 Key", async () => {
    const KIMI = "sk-kimi-fake-0123456789";
    const plan = await call("POST", "/v1/sources", { apiKey: KIMI, presetId: "kimi", plan: "coding_plan", region: "intl", models: ["k3.1-pro"] });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.source).toMatchObject({ id: "kimi-coding_plan-intl", name: "Kimi 编程套餐", baseUrl: "https://api.kimi.ai/coding/", verified: false });
    expect(plan.body.profiles.find((p: any) => p.sourceId === "kimi-coding_plan-intl").baseUrl).toBe("https://api.kimi.ai/coding");
    expect(sentKey(KIMI)).toBe(false);

    const custom = { apiKey: "sk-nebula-fake", presetId: null, name: "Nebula", baseUrl: "https://llm.nebula.example.com/anthropic", format: "anthropic", models: ["nebula-large"] };
    expect((await call("POST", "/v1/sources", { ...custom, baseUrl: "http://llm.nebula.example.com" })).status).toBe(400);
    expect((await call("POST", "/v1/sources", { ...custom, format: "openai_responses" })).status).toBe(400);
    const ok = await call("POST", "/v1/sources", custom);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.source).toMatchObject({ id: "custom-nebula", presetId: null, name: "Nebula", verified: false });
    expect(ok.body.profiles.find((p: any) => p.sourceId === "custom-nebula").origin).toEqual({ provider: "custom", label: "Nebula", via: null });
    expect(filesWithKeys(t.dataDir, [ANT, KIMI, "sk-nebula-fake"])).toEqual([]);
  });

  it("TokenHub 是其中一个来源：tkv- 认成 TokenHub，加、删同第 51 条（th- 模型配置）", async () => {
    const r = await check({ apiKey: TH });
    expect(r.body).toMatchObject({ recognized: { presetId: "tokenhub", plan: "api", region: null }, models: [{ id: "wangsu/claude-opus-5-5" }], verified: true });
    const add = await call("POST", "/v1/sources", { apiKey: TH, presetId: "tokenhub", models: ["wangsu/claude-opus-5-5"] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.source).toMatchObject({ id: "tokenhub", name: "TokenHub", models: [{ id: "wangsu/claude-opus-5-5" }] });
    expect(add.body.profiles.some((p: any) => p.id === "th-wangsu_claude-opus-5-5")).toBe(true);
    expect((await call("GET", "/v1/sources")).body.sources[0].id).toBe("tokenhub");
    expect((await call("DELETE", "/v1/sources/tokenhub")).status).toBe(200);
    expect((await profiles()).some((p) => p.id.startsWith("th-"))).toBe(false);
  });

  it("删来源：Key 和它的模型配置一起删；再删 404", async () => {
    expect((await call("DELETE", "/v1/sources/anthropic-api")).status).toBe(200);
    expect((await profiles()).some((p) => p.sourceId === "anthropic-api")).toBe(false);
    expect(secrets()["source:anthropic-api"]).toBeUndefined();
    expect((await call("DELETE", "/v1/sources/anthropic-api")).status).toBe(404);
    expect((await call("GET", "/v1/sources")).body.sources.map((s: any) => s.id)).toEqual(["kimi-coding_plan-intl", "custom-nebula"]);
  });
});
