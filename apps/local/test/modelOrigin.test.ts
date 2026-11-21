// 子会话选模型看得出「执行方 · 来源 · 模型」（契约 LocalModelOrigin）：经 magpie 的按模型名前缀认，厂商地址按域名认；
// 都用假端点和假 claude，不连本人的 magpie，也不用真钥匙。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalModelProfile, LocalRun } from "@warmap/contracts";
import { modelOrigin, readsTokenHubSpend } from "../src/modelOrigin.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const MAGPIE = "http://127.0.0.1:3425";
const gw = (baseUrl: string, model: string) => modelOrigin({ source: "gateway", baseUrl, model });

describe("认来源", () => {
  it("订阅；经 magpie 的按模型名前缀认；没有前缀、认不出的前缀照写", () => {
    expect(modelOrigin({ source: "subscription", baseUrl: null, model: null })).toEqual({ provider: "claude-subscription", label: "Claude 订阅", via: null });
    expect(gw(MAGPIE, "codex/gpt-6.1")).toEqual({ provider: "codex", label: "Codex 订阅 · 经 magpie", via: "magpie" });
    expect(gw("http://localhost:3425/", "deepseek/deepseek-v4-pro")).toEqual({ provider: "deepseek", label: "DeepSeek API · 经 magpie", via: "magpie" });
    expect(gw(MAGPIE, "Copilot/claude-sonnet-5-5")).toEqual({ provider: "copilot", label: "Copilot 订阅 · 经 magpie", via: "magpie" });
    expect(gw(MAGPIE, "gpt-6.1")).toEqual({ provider: "magpie", label: "magpie", via: "magpie" });
    expect(gw(MAGPIE, "foo/bar")).toEqual({ provider: "foo", label: "foo · 经 magpie", via: "magpie" });
  });
  it("厂商地址按域名对上名单（子域名也算），对不上写主机名；本机别的端口不是 magpie", () => {
    expect(gw("https://tokenhub.corp.tokenkingos.com", "wangsu/qwen3.8-flash")).toEqual({ provider: "tokenhub", label: "TokenHub", via: null });
    expect(gw("https://api.deepseek.com/anthropic", "deepseek-v4-pro")).toEqual({ provider: "deepseek", label: "DeepSeek API", via: null });
    expect(gw("https://api.moonshot.cn/anthropic", "kimi-k3")).toMatchObject({ provider: "kimi", label: "Kimi API" });
    expect(gw("https://open.bigmodel.cn/api/anthropic", "glm-5")).toMatchObject({ provider: "glm" });
    expect(gw("https://dashscope.aliyuncs.com/apps/anthropic", "qwen3.8")).toMatchObject({ provider: "qwen" });
    expect(gw("https://ark.cn-beijing.volces.com/api/coding", "doubao-seed")).toMatchObject({ provider: "volcengine", label: "火山方舟 API" });
    expect(gw("https://llm.example.com:8443/v1", "m")).toEqual({ provider: "llm.example.com:8443", label: "llm.example.com:8443", via: null });
    expect(gw("http://127.0.0.1:8080", "m")).toEqual({ provider: "127.0.0.1:8080", label: "127.0.0.1:8080", via: null });
    expect(gw("https://evil-deepseek.com", "m").provider).toBe("evil-deepseek.com"); // 只认它或它的子域名
  });
  it("TokenHub 的花费只读 TokenHub（和认不出的地址）：经 magpie 的、认得出的厂商不读", () => {
    expect(readsTokenHubSpend(gw("https://tokenhub.corp.tokenkingos.com", "m"))).toBe(true);
    expect(readsTokenHubSpend(gw("https://llm.example.com", "m"))).toBe(true);
    expect(readsTokenHubSpend(gw("https://api.deepseek.com/anthropic", "m"))).toBe(false);
    expect(readsTokenHubSpend(gw(MAGPIE, "codex/gpt-6.1"))).toBe(false);
  });
});

describe("模型配置和子会话带上执行方和来源", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-origin-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const trace = () => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  beforeAll(async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
  });
  afterAll(() => t.cleanup());

  it("加 magpie：不用填钥匙；别处的 http 地址不收；列表里每条带认出的来源", async () => {
    const put = await call("PUT", "/v1/models/magpie", { label: "magpie", source: "gateway", baseUrl: MAGPIE, model: "codex/gpt-6.1" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ hasKey: false, origin: { provider: "codex", label: "Codex 订阅 · 经 magpie", via: "magpie" } });
    const plain = await call("PUT", "/v1/models/plain", { label: "x", source: "gateway", baseUrl: "http://llm.example.com", model: "m", apiKey: "sk-test-0123456789" });
    expect([plain.status, plain.body.error.message]).toEqual([400, "只有本机地址可以用 http，别的要 https"]);
    await call("PUT", "/v1/models/ds", { label: "我的 DeepSeek", source: "gateway", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro", apiKey: "sk-test-0123456789" });
    const list = (await call("GET", "/v1/models")).body.profiles;
    for (const p of list) expect(Value.Check(LocalModelProfile, p)).toBe(true);
    expect(Object.fromEntries(list.map((p: any) => [p.id, p.origin.label]))).toEqual({ subscription: "Claude 订阅", magpie: "Codex 订阅 · 经 magpie", ds: "DeepSeek API" });
  });

  it("经 magpie 开一个子会话：执行方是 Claude Code，来源 Codex 订阅；钥匙照 magpie 的约定传；实际模型名照样解析，前缀变了来源跟着变", async () => {
    const preview = await call("POST", "/v1/runs/preview", { modelProfileId: "magpie" });
    expect(preview.body).toMatchObject({ harness: "claude-code", origin: { label: "Codex 订阅 · 经 magpie" }, modelName: "gpt-6.1" });
    // 假 claude 报的实际模型是 magpie 转给 DeepSeek 的
    writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ initModel: "deepseek/deepseek-v4-pro" }));
    mkdirSync(join(work, "A"), { recursive: true });
    const s = (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "A" }, title: "A", cwd: join(work, "A"), firstMessage: "做 A", modelProfileId: "magpie" })).body;
    const run = await until(async () => { const r = (await call("GET", `/v1/sessions/${s.id}`)).body.session.run; return r?.actual ? r : null; });
    expect(Value.Check(LocalRun, run)).toBe(true);
    expect(run).toMatchObject({ source: "gateway", sourceLabel: "magpie", harness: "claude-code", model: "codex/gpt-6.1", modelName: "gpt-6.1" });
    expect(run.actual).toMatchObject({ model: "deepseek/deepseek-v4-pro", modelName: "deepseek-v4-pro" });
    expect(run.origin).toEqual({ provider: "deepseek", label: "DeepSeek API · 经 magpie", via: "magpie" });
    const launch = trace().find((l) => l.argv?.includes(s.id));
    expect(launch.authToken).toBe("magpie");
    await call("POST", `/v1/sessions/${s.id}/kill`, {});
  });

  it("会话记录里存的是旧名字（如「我的 Claude 订阅」）：本机程序启动时照现在的配置改过来，摘要和报给云端的都是新名字；以前的提示行、最近更新时间不动", async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const folder = tempDir("tl-origin-old-");
    writeFileSync(join(folder, ".fake-claude.json"), "{}");
    const first = await startTestRunner({ pickFolder: folder, fetchImpl: offline });
    const { dataDir } = first;
    const tok = await pair(first.port);
    await api(first.port, tok, "POST", "/v1/folders/pick", {});
    const s = (await api(first.port, tok, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "old" }, title: "old", cwd: folder, firstMessage: "做", permissionMode: "auto" })).body;
    await until(async () => (await api(first.port, tok, "GET", `/v1/sessions/${s.id}`)).body.session.status === "idle");
    await api(first.port, tok, "POST", `/v1/sessions/${s.id}/kill`, {}); // 已经停了的老会话：重启时状态不会再变
    await first.runner.close();
    // 照 11/10 以前的样子改回去：配置的名字、来源名、认出的来源都带「我的」
    const file = join(dataDir, "sessions", s.id, "session.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const OLD = "我的 Claude 订阅";
    const updatedAt = "2026-11-08T03:00:00.000Z";
    writeFileSync(file, JSON.stringify({ ...rec, updatedAt, modelLabel: OLD, run: { ...rec.run, sourceLabel: OLD, origin: { ...rec.run.origin, label: OLD } } }));
    const eventsFile = join(dataDir, "sessions", s.id, "events.jsonl");
    const before = readFileSync(eventsFile, "utf8");
    const statuses = () => JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).filter((i: any) => i.sessionId === s.id && i.type === "status").map((i: any) => i.data);
    const sent = statuses().length;

    const again = await startTestRunner({ pickFolder: folder, fetchImpl: offline, dataDir });
    try {
      const now = (await api(again.port, tok, "GET", `/v1/sessions/${s.id}`)).body.session;
      expect(now.modelLabel).toBe("Claude 订阅");
      expect(now.run).toMatchObject({ sourceLabel: "Claude 订阅", origin: { provider: "claude-subscription", label: "Claude 订阅", via: null }, model: rec.run.model, actual: rec.run.actual });
      expect(Value.Check(LocalRun, now.run)).toBe(true);
      expect(JSON.stringify(now)).not.toContain("我的");
      expect(now.updatedAt).toBe(updatedAt); // 只是改名字，不算会话有更新
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ modelLabel: "Claude 订阅", updatedAt });
      // 报给云端：多了带新名字的状态，模型那一栏是「来源 · 模型 · 思考」（第 67 条）
      const later = statuses().slice(sent);
      expect(later.length).toBeGreaterThan(0);
      expect(later.at(-1)).toMatchObject({ modelLabel: "Claude 订阅 · Opus 5.5 · 中", run: { sourceLabel: "Claude 订阅", origin: { label: "Claude 订阅" } } });
      // 事件记录原样
      expect(readFileSync(eventsFile, "utf8")).toBe(before);
      // 再启动一次：名字已经对了，不重报
      const count = statuses().length;
      await again.runner.close();
      const third = await startTestRunner({ pickFolder: folder, fetchImpl: offline, dataDir });
      try { expect(statuses().length).toBe(count); } finally { await third.runner.close(); }
    } finally {
      await again.cleanup().catch(() => {});
    }
  });

  it("本人给模型配置改了名：用着它的会话名字跟着改；经 magpie 的来源照旧按实际跑的模型认", async () => {
    const before = (await call("GET", "/v1/sessions")).body.sessions.find((x: any) => x.modelProfileId === "magpie");
    expect(before).toMatchObject({ modelLabel: "magpie", run: { sourceLabel: "magpie", origin: { label: "DeepSeek API · 经 magpie" } } });
    const put = await call("PUT", "/v1/models/magpie", { label: "本机转发", source: "gateway", baseUrl: MAGPIE, model: "codex/gpt-6.1" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = (await call("GET", `/v1/sessions/${before.id}`)).body.session;
    expect(after).toMatchObject({ modelLabel: "本机转发", updatedAt: before.updatedAt, run: { sourceLabel: "本机转发", origin: { provider: "deepseek", label: "DeepSeek API · 经 magpie", via: "magpie" } } });
    // 别的会话不受影响
    const others = (await call("GET", "/v1/sessions")).body.sessions.filter((x: any) => x.modelProfileId !== "magpie");
    expect(others.every((x: any) => x.modelLabel !== "本机转发")).toBe(true);
    await call("PUT", "/v1/models/magpie", { label: "magpie", source: "gateway", baseUrl: MAGPIE, model: "codex/gpt-6.1" });
  });

  it("订阅的子会话照旧：Claude 订阅", async () => {
    const preview = await call("POST", "/v1/runs/preview", {});
    expect(preview.body).toMatchObject({ source: "subscription", harness: "claude-code", origin: { provider: "claude-subscription", label: "Claude 订阅", via: null } });
  });
});
