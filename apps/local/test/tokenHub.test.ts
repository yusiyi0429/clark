import http from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir, waitFor } from "./helpers.js";

/** 连接页连 TokenHub（设计 17.2 第 51 条，契约 POST/DELETE /v1/tokenhub）。TokenHub 用桩，Key 是假的。 */
const KEY = "th-fake-key-0123456789abcdef";
const MODELS_URL = "https://tokenhub.corp.tokenkingos.com/api/openai/v1/models";

type Hub = { status: number; models: string[] } | "down";
function fakeHub(state: { hub: Hub; calls: { url: string; auth: string | null }[] }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== MODELS_URL) return new Response("{}", { status: 404 }); // 云端、TokenHub 用量统计这些都当没有
    state.calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (state.hub === "down") throw new TypeError("fetch failed");
    const { status, models } = state.hub;
    return new Response(JSON.stringify(status === 200 ? { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "wangsu" })) } : { msg: "Authorization error" }), { status });
  }) as typeof fetch;
}

/** 数据目录里除了钥匙文件，哪儿都不该出现 Key。 */
function filesWithKey(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesWithKey(p));
    else if (name !== "secrets.plain.json" && readFileSync(p, "utf8").includes(KEY)) out.push(p);
  }
  return out;
}

describe("连接页连 TokenHub", () => {
  const state: { hub: Hub; calls: { url: string; auth: string | null }[] } = { hub: { status: 200, models: [] }, calls: [] };
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let tok: string;
  const work = tempDir("tl-th-work-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, tok, method, path, body);
  const tokenHubProfiles = async () => (await call("GET", "/v1/models")).body.profiles.filter((p: any) => p.id.startsWith("th-"));
  const secrets = () => { try { return JSON.parse(readFileSync(join(t.dataDir, "secrets.plain.json"), "utf8")); } catch { return {}; } };

  beforeAll(async () => {
    writeFileSync(join(work, ".fake-claude.json"), "{}");
    t = await startTestRunner({ fetchImpl: fakeHub(state), pickFolder: work });
    tok = await pair(t.port);
  });
  afterAll(async () => { await t.cleanup(); });

  it("Key 不对：回 422 tokenhub_key_rejected「Key 不对」，什么都不存", async () => {
    state.hub = { status: 401, models: [] };
    const r = await call("POST", "/v1/tokenhub", { apiKey: KEY });
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({ code: "tokenhub_key_rejected", message: "Key 不对" });
    expect(state.calls.at(-1)).toEqual({ url: MODELS_URL, auth: `Bearer ${KEY}` });
    expect(await tokenHubProfiles()).toEqual([]);
    expect(secrets().tokenhub).toBeUndefined();
  });

  it("连不上（网络不通、TokenHub 回 5xx、回的认不出）：回 502 tokenhub_unreachable「连不上 TokenHub」", async () => {
    for (const hub of ["down", { status: 503, models: [] }] as Hub[]) {
      state.hub = hub;
      const r = await call("POST", "/v1/tokenhub", { apiKey: KEY });
      expect(r.status).toBe(502);
      expect(r.body.error).toEqual({ code: "tokenhub_unreachable", message: "连不上 TokenHub" });
    }
    expect(await tokenHubProfiles()).toEqual([]);
    expect(secrets().tokenhub).toBeUndefined();
  });

  it("Key 是空的、带不可见字符：400，不去连 TokenHub", async () => {
    const before = state.calls.length;
    for (const apiKey of ["", "a b"]) expect((await call("POST", "/v1/tokenhub", { apiKey })).status).toBe(400);
    expect(state.calls.length).toBe(before);
  });

  it("连上：照 TokenHub 列的每个模型建一条网关配置，Key 只存一份、哪儿都不回、默认模型不变", async () => {
    state.hub = { status: 200, models: ["wangsu/claude-opus-5-5", "wangsu/deepseek-v4.1-flash", "aliyun/qwen3.8-flash"] };
    const r = await call("POST", "/v1/tokenhub", { apiKey: KEY });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const th = r.body.profiles.filter((p: any) => p.id.startsWith("th-"));
    expect(th.map((p: any) => [p.id, p.label, p.model])).toEqual([
      ["th-wangsu_claude-opus-5-5", "Opus 5.5", "wangsu/claude-opus-5-5"],
      ["th-wangsu_deepseek-v4_1-flash", "deepseek-v4.1-flash", "wangsu/deepseek-v4.1-flash"],
      ["th-aliyun_qwen3_8-flash", "qwen3.8-flash", "aliyun/qwen3.8-flash"],
    ]);
    for (const p of th) {
      expect(p).toMatchObject({ source: "gateway", agent: "claude-code", baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", hasKey: true, isDefault: false, catalog: false, origin: { provider: "tokenhub", label: "TokenHub", via: null } });
    }
    // 实测能搜的两个开着自带搜索，别的关着（同手动配网关）
    expect(th.map((p: any) => p.webSearch)).toEqual([true, true, false]);
    expect(r.body.profiles.find((p: any) => p.isDefault).id).toBe("subscription");
    expect(Object.keys(secrets())).toEqual(["tokenhub"]);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(JSON.stringify((await call("GET", "/v1/status")).body)).not.toContain(KEY);
    expect(filesWithKey(t.dataDir)).toEqual([]);
  });

  it("开工时用这把 Key：拉起的 Claude Code 拿到 TokenHub 的地址和存的 Key（不在命令行里）", async () => {
    expect((await call("POST", "/v1/folders/pick", {})).status).toBe(200);
    const s = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "th" }, title: "th", cwd: work, modelProfileId: "th-wangsu_claude-opus-5-5", firstMessage: "hi", permissionMode: "default" });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const run = await waitFor(() => existsSync(join(work, ".fake-claude-trace.jsonl")) && JSON.parse(readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").split("\n")[0]!));
    expect(run.authToken).toBe(KEY);
    expect(run.argv.join(" ")).not.toContain(KEY);
    expect(JSON.parse(run.argv[run.argv.indexOf("--settings") + 1]).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://tokenhub.corp.tokenkingos.com/api/anthropic", ANTHROPIC_MODEL: "wangsu/claude-opus-5-5" });
    await call("POST", `/v1/sessions/${s.body.id}/kill`, {});
  });

  it("这些配置：名字、默认能改；地址、模型、钥匙只在连接页换；th- 开头的新 id 不收", async () => {
    const base = { label: "主力", source: "gateway", baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", model: "wangsu/claude-opus-5-5" };
    const ok = await call("PUT", "/v1/models/th-wangsu_claude-opus-5-5", { ...base, isDefault: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ label: "主力", isDefault: true, hasKey: true });
    for (const bad of [{ baseUrl: "https://evil.example.com/api" }, { model: "wangsu/other" }, { apiKey: "" }, { apiKey: "another-key-123" }]) {
      expect((await call("PUT", "/v1/models/th-wangsu_claude-opus-5-5", { ...base, ...bad })).status).toBe(400);
    }
    expect((await call("PUT", "/v1/models/th-made-up", base)).status).toBe(400);
    expect(secrets().tokenhub).toBe(KEY);
  });

  it("单删一条：别的几条还用着这把 Key", async () => {
    expect((await call("DELETE", "/v1/models/th-aliyun_qwen3_8-flash")).status).toBe(200);
    const th = await tokenHubProfiles();
    expect(th.map((p: any) => p.id)).toEqual(["th-wangsu_claude-opus-5-5", "th-wangsu_deepseek-v4_1-flash"]);
    expect(th.every((p: any) => p.hasKey)).toBe(true);
  });

  it("再连一次：这次没列的删掉，留下的保住本人改过的名字和默认；列表是空的时建默认的三个", async () => {
    state.hub = { status: 200, models: ["wangsu/claude-opus-5-5", "wangsu/claude-sonnet-5-5"] };
    expect((await call("POST", "/v1/tokenhub", { apiKey: KEY })).status).toBe(200);
    expect((await tokenHubProfiles()).map((p: any) => [p.id, p.label, p.isDefault])).toEqual([
      ["th-wangsu_claude-opus-5-5", "主力", true], ["th-wangsu_claude-sonnet-5-5", "Sonnet 5.5", false],
    ]);
    state.hub = { status: 200, models: [] };
    expect((await call("POST", "/v1/tokenhub", { apiKey: KEY })).status).toBe(200);
    expect((await tokenHubProfiles()).map((p: any) => p.model)).toEqual(["wangsu/claude-opus-5-5", "wangsu/claude-sonnet-5-5", "wangsu/deepseek-v4.1-flash"]);
  });

  it("断开：删 Key 和 th- 开头的配置；本人自己配的网关不动；默认回到 Claude 订阅", async () => {
    const own = await call("PUT", "/v1/models/my-gw", { label: "我配的", source: "gateway", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-chat", apiKey: "own-key-123456" });
    expect(own.status).toBe(200);
    const r = await call("DELETE", "/v1/tokenhub");
    expect(r.status).toBe(200);
    expect(await tokenHubProfiles()).toEqual([]);
    expect(secrets().tokenhub).toBeUndefined();
    const left = (await call("GET", "/v1/models")).body.profiles;
    expect(left.find((p: any) => p.id === "my-gw")).toMatchObject({ hasKey: true });
    expect(left.find((p: any) => p.isDefault).id).toBe("subscription");
    // 开过会话以后，数据目录（会话记录、事件、发件箱、日志）里也没有这把 Key
    expect(filesWithKey(t.dataDir)).toEqual([]);
  });
});

describe("TokenHub 的地址可以在本机配置里换（config.json 的 tokenHubUrl）", () => {
  it("照配置的地址验 Key、建配置", async () => {
    const seen: string[] = [];
    const hub = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "wangsu/claude-opus-5-5" }] }));
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(hub.address() as { port: number }).port}/api/anthropic`;
    const dataDir = tempDir("tl-th-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ tokenHubUrl: url }));
    const t = await startTestRunner({ dataDir });
    try {
      const tok = await pair(t.port);
      const r = await api(t.port, tok, "POST", "/v1/tokenhub", { apiKey: KEY });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(seen[0]).toBe(`GET /api/openai/v1/models Bearer ${KEY}`);
      expect(r.body.profiles.find((p: any) => p.id === "th-wangsu_claude-opus-5-5")).toMatchObject({ baseUrl: url, hasKey: true });
    } finally {
      await t.cleanup();
      hub.close();
    }
  });
});
