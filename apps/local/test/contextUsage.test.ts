// 上下文用了多少（设计 17.2 第 42 条，契约 LocalContextUsage、事件 context_usage、notice context_compacted）：假 claude、假 codex，不调模型。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionEvent, LocalSessionSummary } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { codexProfileId } from "../src/codexCatalog.js";
import { ContextReporter } from "../src/agents/contextUsage.js";
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

const SOL = codexProfileId("gpt-6.1-sol");

describe("变了才报", () => {
  it("这一轮中间只在百分比（取整）变了时报，上限读不到不报；每轮做完数变了就报，一样的不重报", () => {
    const sent: unknown[] = [];
    const r = new ContextReporter((e) => sent.push(e));
    r.report(1000, null); // 上限还不知道：中间不报
    r.report(100_000, 200_000); // 50%
    r.report(100_500, 200_000); // 还是 50%：不报
    r.report(102_000, 200_000); // 51%
    r.report(102_300, 200_000, true); // 做完了：数变了就报
    r.report(102_300, 200_000, true); // 一样的不重报
    r.report(5000, null, true); // 上限读不到，做完时照报
    expect(sent).toEqual([
      { type: "context_usage", usedTokens: 100_000, maxTokens: 200_000 }, { type: "context_usage", usedTokens: 102_000, maxTokens: 200_000 },
      { type: "context_usage", usedTokens: 102_300, maxTokens: 200_000 }, { type: "context_usage", usedTokens: 5000, maxTokens: null },
    ]);
  });
});

describe("上下文用了多少", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-ctx-");
  const dataDir = tempDir("tl-ctx-data-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const events = (id: string) => readFileSync(join(dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const usages = (id: string) => events(id).filter((e) => e.type === "context_usage").map((e) => [e.usedTokens, e.maxTokens]);
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  const open = async (name: string, firstMessage: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage, permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const say = (id: string, text: string) => call("POST", `/v1/sessions/${id}/messages`, { text });
  const context = (id: string, used: number) => until(async () => { const s = (await session(id)).session; return s.context?.usedTokens === used ? s : null; });

  beforeAll(async () => {
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ dataDir, pickFolder: work, fetchImpl: offline, fakeCodex: true });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    fake({});
    await until(async () => (await call("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
  });
  afterAll(() => t.cleanup());

  it("Claude Code：每轮做完读一次（token 数和模型上限），记进摘要和事件流；这一轮中间按模型回复的用量估，百分比变了才报", async () => {
    // 「每次都问」：第一轮停在等批准，这一轮一定还没做完
    const id = await open("A", "做 A", { permissionMode: "default" });
    const first = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    // 这个进程第一次模型回复后就读一次（知道了上限，第一轮中间也估得出）：还等着批准，数已经有了
    const s = await context(id, 19_000); // 假 claude：第一轮 18000 + 1000
    expect(Value.Check(LocalSessionSummary, s)).toBe(true);
    expect(s.context).toMatchObject({ usedTokens: 19_000, maxTokens: 200_000 });
    expect(events(id).some((e) => e.type === "turn_end")).toBe(false);
    // 批了、做完再读一次：数没变不重报
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(first.requestId)}`, { decision: "allow" });
    await until(async () => (await session(id)).session.status === "idle");
    await new Promise((r) => setTimeout(r, 300));
    const ev = events(id);
    expect(ev.every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    expect(usages(id)).toEqual([[19_000, 200_000]]);
    // 第二轮：每条模型回复带用量（输入 10 万、缓存 2 万、输出 1 千），停在等批准时已经报了 61%
    fake({ messageUsage: { input_tokens: 100_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0, output_tokens: 1_000 } });
    await say(id, "再来");
    const p = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    expect((await session(id)).session.context).toMatchObject({ usedTokens: 121_000, maxTokens: 200_000 });
    expect(usages(id)).toEqual([[19_000, 200_000], [121_000, 200_000]]); // 这一轮三条回复用量一样，只报一次
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" });
    await context(id, 20_000); // 做完再读一次，以它为准
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("Claude Code 压缩了上下文：对话里记一行「压缩了上下文」，跟着报新的用量", async () => {
    fake({ compact: true, context: { totalTokens: 40_000, maxTokens: 200_000 } });
    const id = await open("B", "做 B");
    await context(id, 40_000);
    const ev = events(id);
    expect(ev.filter((e) => e.type === "notice" && e.code === "context_compacted").map((e) => [e.level, e.text])).toEqual([["info", "压缩了上下文"]]);
    expect(ev.findIndex((e) => e.code === "context_compacted")).toBeLessThan(ev.findIndex((e) => e.type === "context_usage"));
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("老版本 Claude Code 不认这个请求：不报，摘要里没有这一项，会话照常", async () => {
    fake({ context: false });
    const id = await open("C", "做 C");
    await until(async () => (await session(id)).session.status === "idle");
    await new Promise((r) => setTimeout(r, 300));
    expect((await session(id)).session.context).toBeUndefined();
    expect(usages(id)).toEqual([]);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("Codex：每次模型回复后它报的最近一次请求的 token 数和模型上限；压缩了也记一行", async () => {
    const id = await open("D", "ctx 150000", { modelProfileId: SOL });
    const s = await context(id, 150_000);
    expect(s.context).toMatchObject({ usedTokens: 150_000, maxTokens: 200_000 });
    await until(async () => (await session(id)).session.status === "idle");
    await say(id, "compact");
    await until(() => events(id).some((e) => e.type === "notice" && e.code === "context_compacted"));
    await until(async () => (await session(id)).session.status === "idle");
    expect(events(id).filter((e) => e.type === "notice" && e.code === "context_compacted")).toHaveLength(1);
    expect(usages(id).at(-1)![1]).toBe(200_000);
    expect(usages(id).at(-1)![0]).toBeLessThan(1000); // 压缩以后小了（假 codex 报累计的几十个）
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("换了执行方：原来那家的数不留，等新的那家报了再有", async () => {
    const id = await open("E", "做 E");
    await context(id, 19_000);
    const r = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: SOL });
    expect(r.body.session.agent).toBe("codex");
    expect(r.body.session.context).toBeUndefined();
    await say(id, "接着"); // 换过去的第一句前面带着交代，假 codex 当普通话回
    await until(async () => { const x = (await session(id)).session; return x.status === "idle" && x.context; });
    await say(id, "ctx 30000");
    await context(id, 30_000);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });
});
