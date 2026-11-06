import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionEvent, type TLocalSessionEvent } from "@warmap/contracts";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

/** 读 SSE：一直收，直到 until 返回 true 或超时；返回收到的事件。 */
function readSse(port: number, token: string, id: string, opts: { lastEventId?: number; until: (all: TLocalSessionEvent[]) => boolean; ms?: number }) {
  return new Promise<TLocalSessionEvent[]>((resolve, reject) => {
    const events: TLocalSessionEvent[] = [];
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: ORIGIN, "x-tianshu-local-token": token };
    if (opts.lastEventId) headers["last-event-id"] = String(opts.lastEventId);
    const req = http.request({ host: "127.0.0.1", port, path: `/v1/sessions/${id}/events`, headers }, (res) => {
      expect(res.headers["content-type"]).toContain("text/event-stream");
      let buf = "";
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE 超时，已收 ${events.map((e) => e.type).join(",")}`)); }, opts.ms ?? 5_000);
      res.setEncoding("utf8").on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const idLine = chunk.split("\n").find((l) => l.startsWith("id: "));
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as TLocalSessionEvent;
          expect(Number(idLine?.slice(4))).toBe(e.seq);
          events.push(e);
        }
        if (opts.until(events)) { clearTimeout(timer); req.destroy(); resolve(events); }
      });
    });
    req.on("error", (e) => { if (!(e as any).code?.includes("RESET")) reject(e); });
    req.end();
  });
}

const has = (type: string, pred: (e: any) => boolean = () => true) => (all: TLocalSessionEvent[]) => all.some((e) => e.type === type && pred(e));
const trace = (dir: string) => readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("会话：开工、事件、批权限、插话、停下、强停、续接", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  let id: string;
  const leaked = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };

  beforeAll(async () => {
    // 模拟桌面应用注入的变量：不该漏进 claude 子进程。
    process.env.ANTHROPIC_API_KEY = "leak-api-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "leak-oauth";
    t = await startTestRunner({ pickFolder: work });
    token = await pair(t.port);
    expect((await api(t.port, token, "POST", "/v1/folders/pick", {})).body.folder.path).toBeTruthy();
  });
  afterAll(async () => {
    await t.cleanup();
    for (const [k, v] of Object.entries(leaked)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  it("不在允许文件夹里的目录不能开工", async () => {
    const r = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c1" }, title: "x", cwd: tempDir("tl-other-"), firstMessage: "hi" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("folder_not_allowed");
  });

  it("开工：按约定的参数拉起、环境变量走白名单，事件按序到、权限请求挂起", async () => {
    const r = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "card-1" }, title: "写 hello", cwd: work, firstMessage: "写 hello.txt" });
    expect(r.status).toBe(200);
    id = r.body.id;
    const events = await readSse(t.port, token, id, { until: has("permission_request") });
    for (const e of events) expect(Value.Check(LocalSessionEvent, e)).toBe(true);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["status", "user_message", "agent_info", "assistant_text", "tool_call", "plan", "permission_request"]));
    expect(events.find((e) => e.type === "plan")).toMatchObject({ entries: [{ content: "写文件", status: "in_progress" }] });

    const [first] = trace(work);
    const a: string[] = first.argv;
    const after = (flag: string) => a[a.indexOf(flag) + 1];
    expect(a).toContain("-p");
    expect(after("--input-format")).toBe("stream-json");
    expect(after("--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(after("--permission-mode")).toBe("manual");
    expect(after("--permission-prompts")).toBe("host");
    expect(after("--permission-prompt-tool")).toBe("stdio");
    expect(after("--session-id")).toBe(id);
    expect(after("--setting-sources")).toBe("project,local");
    expect(a).toContain("--strict-mcp-config");
    expect(existsSync(after("--mcp-config"))).toBe(true);
    expect(after("--allowedTools")).toContain("mcp__tianshu-session__hand_back");
    expect(JSON.parse(after("--settings"))).toEqual({ skipWebFetchPreflight: true, claudeMdExcludes: expect.any(Array) }); // 订阅也关掉 WebFetch 预检
    expect(first.sessionSecret).toMatch(/^[0-9a-f]{48}$/); // 本会话密钥只经环境变量传
    expect(a.join(" ")).not.toContain(first.sessionSecret);
    expect(a).not.toContain("--disallowedTools"); // 订阅模型保留自带搜索
    expect(first.envKeys.filter((k: string) => /^(ANTHROPIC_|CLAUDE_)/i.test(k) || k === "CLAUDECODE")).toEqual([]);
    expect(first.envKeys).toContain("DISABLE_AUTOUPDATER");

    const detail = await api(t.port, token, "GET", `/v1/sessions/${id}`);
    expect(detail.body.session.status).toBe("waiting_permission");
    expect(detail.body.pendingPermissions[0]).toMatchObject({ toolName: "Write", title: "写文件 hello.txt", canAllowForSession: true });
  });

  it("断线重连按 Last-Event-ID 只补发之后的事件", async () => {
    const all = await readSse(t.port, token, id, { until: has("permission_request") });
    const mid = all[Math.floor(all.length / 2)]!.seq;
    const rest = await readSse(t.port, token, id, { lastEventId: mid, until: (es) => es.at(-1)?.seq === all.at(-1)!.seq });
    expect(rest[0]!.seq).toBe(mid + 1);
    expect(rest.map((e) => e.seq)).toEqual(all.filter((e) => e.seq > mid).map((e) => e.seq));
  });

  it("批准（这张卡都允许）：写成文件，一轮结束，花费记上", async () => {
    const reqId = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.pendingPermissions[0].requestId;
    const lastSeq = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.lastSeq;
    const r = await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(reqId)}`, { decision: "allow", allowForSession: true });
    expect(r.status).toBe(200);
    const events = await readSse(t.port, token, id, { lastEventId: lastSeq, until: has("status", (e) => e.status === "idle") });
    expect(events.find((e) => e.type === "permission_resolved")).toMatchObject({ decision: "allow", allowForSession: true });
    expect(events.find((e) => e.type === "assistant_text")).toMatchObject({ text: "写好了（本会话都允许）" });
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ isError: false, usage: { inputTokens: 3, outputTokens: 5, costUsd: 0.01 } });
    expect(existsSync(join(work, "hello.txt"))).toBe(true);
    expect((await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(reqId)}`, { decision: "allow" })).status).toBe(409);
  });

  it("空闲时发话开新一轮；进行中插话下一步生效；拒绝可附理由", async () => {
    const r1 = await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "再写一次" });
    expect(r1.body).toEqual({ delivery: "new_turn" });
    let detail: any;
    for (let i = 0; i < 100 && !detail?.pendingPermissions?.length; i++) {
      detail = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body;
      await new Promise((r) => setTimeout(r, 20));
    }
    const lastSeq = detail.session.lastSeq;
    const r2 = await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "别写了" });
    expect(r2.body).toEqual({ delivery: "next_step" });
    const reqId = detail.pendingPermissions[0].requestId;
    await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(reqId)}`, { decision: "deny", message: "不要覆盖" });
    const events = await readSse(t.port, token, id, { lastEventId: lastSeq, until: has("status", (e) => e.status === "idle") });
    expect(events.some((e) => e.type === "notice" && e.code === "interjection_next_step")).toBe(true);
    expect(events.some((e) => e.type === "assistant_text" && e.text === "插话收到：别写了")).toBe(true);
    expect(events.some((e) => e.type === "assistant_text" && e.text === "被拒了：不要覆盖")).toBe(true);
  });

  it("停下：发中断，这一轮以 interrupted 结束，会话保留", async () => {
    await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "第三次" });
    let detail: any;
    for (let i = 0; i < 100 && !detail?.pendingPermissions?.length; i++) {
      detail = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body;
      await new Promise((r) => setTimeout(r, 20));
    }
    const lastSeq = detail.session.lastSeq;
    expect((await api(t.port, token, "POST", `/v1/sessions/${id}/interrupt`, {})).status).toBe(200);
    const events = await readSse(t.port, token, id, { lastEventId: lastSeq, until: has("status", (e) => e.status === "idle") });
    expect(events.find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "interrupted" });
    expect(events.some((e) => e.type === "permission_resolved" && e.decision === "deny")).toBe(true);
  });

  it("强停：杀掉进程树，状态 exited；再发话用 --resume 续上", async () => {
    const lastSeq = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.lastSeq;
    expect((await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {})).status).toBe(200);
    await readSse(t.port, token, id, { lastEventId: lastSeq, until: has("status", (e) => e.status === "exited") });
    const r = await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "接着做" });
    expect(r.body).toEqual({ delivery: "resumed" });
    const runs = trace(work);
    const last: string[] = runs.at(-1).argv;
    expect(last[last.indexOf("--resume") + 1]).toBe(id);
    expect(last).not.toContain("--session-id");
  });

  it("本会话 MCP（HTTP）交产出物、交回：要密钥，只收工作目录里的文件，进发件箱", async () => {
    const sessionDir = join(t.dataDir, "sessions", id);
    const secret = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")).mcpSecret;
    const servers = JSON.parse(readFileSync(join(sessionDir, "mcp.json"), "utf8")).mcpServers;
    // 密钥不写进文件：Claude Code 启动时从环境变量展开 ${TIANSHU_SESSION_SECRET}；没关联云端时不挂天枢 MCP。
    expect(servers).toEqual({ "tianshu-session": { type: "http", url: `http://127.0.0.1:${t.port}/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": "${TIANSHU_SESSION_SECRET}" } } });
    writeFileSync(join(work, "方案.md"), "# 方案\n第一版");
    let n = 0;
    const rpc = async (method: string, params?: unknown) => (await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    })).body;
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name).toBe("tianshu-local");
    expect((await rpc("tools/list")).result.tools.map((x: any) => x.name)).toEqual(["add_artifact", "add_evidence", "hand_back"]);
    const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result as { isError: boolean; content: { text: string }[] };
    expect((await call("add_artifact", { path: "方案.md", title: "方案" })).content[0]!.text).toContain("编号 A1");
    expect((await call("add_artifact", { path: "../../etc/passwd" })).isError).toBe(true);
    expect((await call("add_evidence", { kind: "link", title: "PR", url: "https://github.com/x/y/pull/1" })).content[0]!.text).toContain("编号 E1");
    expect((await call("add_evidence", { kind: "note", title: "草稿说明" })).content[0]!.text).toContain("编号 E2");
    expect((await call("save_version", { path: "方案.md", kind: "draft" })).isError).toBe(true); // 卡没有存版本的工具
    expect((await call("hand_back", { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "x" }], outputs: ["A9"] })).isError).toBe(true);
    const hb = await call("hand_back", { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "hello.txt 已写" }], outputs: ["A1", "e1"] });
    expect(hb.isError).toBe(false);
    // 交回点名的是那两份的同步幂等键（云端存成 local_outputs.client_id），没点名的 E2 不算
    const queued = JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item);
    const keyOf = (type: string, pred: (d: any) => boolean) => queued.find((i: any) => i.type === type && pred(i.data)).key;
    expect(queued.find((i: any) => i.type === "handback").data.outputKeys).toEqual([keyOf("artifact", (d) => d.title === "方案"), keyOf("evidence", (d) => d.title === "PR")]);
    // 验收没过，改了方案再交（同一个文件，A2 是它的新一版），这次不点名交回：本会话交过的全部，方案只算最新一版
    writeFileSync(join(work, "方案.md"), "# 方案\n第二版");
    expect((await call("add_artifact", { path: "方案.md", title: "方案" })).content[0]!.text).toContain("编号 A2");
    expect((await call("hand_back", { summary: "改好了", criteria: [{ index: 1, result: "met", evidence: "方案第二版" }] })).content[0]!.text).toContain("E1、E2、A2");
    const again = JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item);
    const a2 = again.filter((i: any) => i.type === "artifact" && i.data.title === "方案").at(-1).key;
    expect(again.filter((i: any) => i.type === "handback").at(-1).data.outputKeys).toEqual([keyOf("evidence", (d) => d.title === "PR"), keyOf("evidence", (d) => d.title === "草稿说明"), a2]);
    const note = await raw(t.port, { method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    const all = await readSse(t.port, token, id, { until: has("handback") });
    expect(all.find((e) => e.type === "artifact")).toMatchObject({ title: "方案", fileName: "方案.md" });
    expect(t.runner.outbox.status().pending).toBeGreaterThan(5); // 没关联云端：状态、计划、花费、产出物、交回都排着
  });

  it("专题：存版本从开工时的 versionBase 往下编号，报回飞书地址；专题不能交回", async () => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "topic", topicId: "topic-1" }, title: "调研", firstMessage: "先出提纲", versionBase: 2 });
    expect(s.status).toBe(200);
    const tid = s.body.id as string;
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", tid, "session.json"), "utf8")).mcpSecret;
    let n = 0;
    const rpc = async (method: string, params?: unknown) => (await raw(t.port, {
      method: "POST", path: `/internal/sessions/${tid}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    })).body;
    const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result as { isError: boolean; content: { text: string }[] };
    expect((await rpc("tools/list")).result.tools.map((x: any) => x.name)).toEqual(["add_artifact", "add_evidence", "save_version", "set_feishu_url"]);
    writeFileSync(join(s.body.cwd, "提纲.md"), "# 提纲\n1. 背景");
    expect((await call("save_version", { path: "提纲.md", kind: "outline", note: "第一次出提纲" })).content[0]!.text).toBe("已存第 3 版");
    expect((await call("save_version", { path: "../x.md", kind: "draft" })).isError).toBe(true);
    expect((await call("set_feishu_url", { number: 4, url: "https://x.feishu.cn/docx/abc" })).isError).toBe(true);
    expect((await call("set_feishu_url", { number: 3, url: "http://x.feishu.cn/docx/abc" })).isError).toBe(true);
    expect((await call("set_feishu_url", { number: 3, url: "https://x.feishu.cn/docx/abc" })).isError).toBe(false);
    expect((await call("hand_back", { summary: "x", criteria: [] })).isError).toBe(true);
    const all = await readSse(t.port, token, tid, { until: has("version") });
    expect(all.find((e) => e.type === "version")).toMatchObject({ number: 3, kind: "outline", label: null, note: "第一次出提纲" });
    const queued = JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).filter((i: any) => i.sessionId === tid);
    expect(queued.find((i: any) => i.type === "topic_version").data).toEqual({ number: 3, kind: "outline", label: null, note: "第一次出提纲", body: "# 提纲\n1. 背景" });
    expect(queued.find((i: any) => i.type === "topic_version_feishu").data).toEqual({ number: 3, feishuUrl: "https://x.feishu.cn/docx/abc" });
    await api(t.port, token, "POST", `/v1/sessions/${tid}/kill`, {});
  });
});

describe("模型配置与钥匙", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  // 云端请求一律打到桩上，测试绝不连线上：/mcp/me 记下转发来的请求并回一条 JSON-RPC，同步接口当作断网。
  const cloudCalls: { url: string; auth: string | null; body: string }[] = [];
  const stub = (async (url: URL | string, init?: RequestInit) => {
    if (!String(url).endsWith("/mcp/me")) throw new Error("offline");
    cloudCalls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: Buffer.from(init?.body as Uint8Array).toString("utf8") });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "web_search" }] } }), { headers: { "content-type": "application/json", "mcp-session-id": "s-1" } });
  }) as unknown as typeof fetch;
  beforeAll(async () => { t = await startTestRunner({ pickFolder: work, fetchImpl: stub }); token = await pair(t.port); await api(t.port, token, "POST", "/v1/folders/pick", {}); });
  afterAll(async () => { await t.cleanup(); });

  it("网关钥匙只写不读；拉起时地址和模型进 --settings，钥匙只进环境变量不进命令行", async () => {
    const key = "sk-test-0123456789abcdef";
    const put = await api(t.port, token, "PUT", "/v1/models/tokenhub-ds", { label: "TokenHub DeepSeek", source: "gateway", baseUrl: "https://hub.example.com/", model: "deepseek-v4.1-flash", apiKey: key });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(key);
    const list = await api(t.port, token, "GET", "/v1/models");
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.profiles.find((p: any) => p.id === "tokenhub-ds")).toMatchObject({ hasKey: true, baseUrl: "https://hub.example.com", webSearch: false });

    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c2" }, title: "网关", cwd: work, modelProfileId: "tokenhub-ds", firstMessage: "hi" });
    expect(s.status).toBe(200);
    expect(s.body.modelLabel).toBe("TokenHub DeepSeek");
    const [run] = trace(work);
    expect(run.authToken).toBe(key);
    expect(run.argv.join(" ")).not.toContain(key);
    const settings = JSON.parse(run.argv[run.argv.indexOf("--settings") + 1]);
    expect(run.argv[run.argv.indexOf("--disallowedTools") + 1]).toBe("WebSearch"); // 网关模型默认不给自带搜索
    expect(settings).toEqual({
      skipWebFetchPreflight: true, claudeMdExcludes: expect.any(Array),
      env: { ANTHROPIC_BASE_URL: "https://hub.example.com", ANTHROPIC_MODEL: "deepseek-v4.1-flash", ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4.1-flash" },
    });
    await api(t.port, token, "POST", `/v1/sessions/${s.body.id}/kill`, {});
  });

  it("自带联网搜索按实测白名单默认开关，可以手动改", async () => {
    const put = (id: string, model: string, extra = {}) => api(t.port, token, "PUT", `/v1/models/${id}`, { label: id, source: "gateway", baseUrl: "https://hub.example.com", model, ...extra });
    expect((await put("ds", "wangsu/deepseek-v4.1-flash")).body.webSearch).toBe(true);
    expect((await put("qw", "aliyun/qwen3.8-flash")).body.webSearch).toBe(false);
    expect((await put("qw2", "aliyun/qwen3.8-flash", { webSearch: true })).body.webSearch).toBe(true);
    expect((await api(t.port, token, "PUT", "/v1/models/sub-haiku", { label: "订阅 haiku", source: "subscription", model: "haiku" })).body.webSearch).toBe(true);
  });

  it("关联云端后每个会话挂天枢 MCP，经本机程序转发：云端令牌不进会话的文件、命令行和环境变量", async () => {
    const cloudToken = "cloud-token-0123456789abcdef";
    expect((await api(t.port, token, "PUT", "/v1/cloud", { apiBaseUrl: "https://evil.example", token: cloudToken })).status).toBe(400);
    expect((await api(t.port, token, "PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "bad token\nadd-generic-password" })).status).toBe(400);
    expect((await api(t.port, token, "PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: cloudToken, personName: "测试" })).status).toBe(200);
    expect(JSON.stringify((await api(t.port, token, "GET", "/v1/cloud")).body)).not.toContain(cloudToken);
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c-cloud" }, title: "云端 MCP", cwd: work, firstMessage: "hi" });
    expect(s.status).toBe(200);
    const sessionDir = join(t.dataDir, "sessions", s.body.id);
    const file = readFileSync(join(sessionDir, "mcp.json"), "utf8");
    expect(JSON.parse(file).mcpServers.tianshu).toEqual({ type: "http", url: `http://127.0.0.1:${t.port}/internal/sessions/${s.body.id}/cloud-mcp`, headers: { "x-tianshu-session-secret": "${TIANSHU_SESSION_SECRET}" } });
    expect(file).not.toContain(cloudToken);
    const run = trace(work).at(-1);
    expect(run.cloudToken).toBeNull();
    expect(run.argv.join(" ")).not.toContain(cloudToken);
    // 天枢 MCP 的只读搜索预先放行，其余工具每次都要网页批准
    expect(run.argv[run.argv.indexOf("--allowedTools") + 1].split(",")).toContain("mcp__tianshu__web_search");

    // 会话的 MCP 客户端经本机转发调天枢 MCP：本机换上云端令牌，原样转发请求和响应。
    const secret = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8")).mcpSecret;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const proxied = await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/cloud-mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
    expect(proxied.status).toBe(200);
    expect(proxied.headers["mcp-session-id"]).toBe("s-1");
    expect(proxied.body.result.tools[0].name).toBe("web_search");
    expect(cloudCalls.at(-1)).toEqual({ url: "https://tk.tokenkingos.com/mcp/me", auth: `Bearer ${cloudToken}`, body });
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/cloud-mcp`, headers: { "x-tianshu-session-secret": "wrong", "content-type": "application/json" }, body })).status).toBe(401);

    // 进程退出后本会话密钥作废。
    await api(t.port, token, "POST", `/v1/sessions/${s.body.id}/kill`, {});
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/cloud-mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" }, body })).status).toBe(401);
    await api(t.port, token, "DELETE", "/v1/cloud");
  });

  it("改网关地址不带新钥匙时，旧钥匙作废（不会被发到新地址）", async () => {
    await api(t.port, token, "PUT", "/v1/models/moved", { label: "x", source: "gateway", baseUrl: "https://hub.example.com", model: "m", apiKey: "sk-old-0123456789" });
    expect((await api(t.port, token, "PUT", "/v1/models/moved", { label: "x", source: "gateway", baseUrl: "https://hub.example.com", model: "m2" })).body.hasKey).toBe(true);
    expect((await api(t.port, token, "PUT", "/v1/models/moved", { label: "x", source: "gateway", baseUrl: "https://attacker.example", model: "m2" })).body.hasKey).toBe(false);
    expect((await api(t.port, token, "PUT", "/v1/models/moved", { label: "x", source: "gateway", baseUrl: "https://hub2.example.com", model: "m2", apiKey: "sk-new-0123456789" })).body.hasKey).toBe(true);
    expect((await api(t.port, token, "PUT", "/v1/models/moved", { label: "x", source: "gateway", baseUrl: "https://hub2.example.com", model: "m2", apiKey: "sk\nnew" })).status).toBe(400);
  });

  it("带个人配置又用网关模型：钥匙不进命令行；本人全局设置里自己设了钥匙就不开工", async () => {
    const cfg = tempDir("tl-cfg-");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      await api(t.port, token, "PUT", "/v1/models/gw-p", { label: "网关", source: "gateway", baseUrl: "https://hub.example.com", model: "m", apiKey: "sk-personal-0123456789" });
      const ok = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c-p" }, title: "x", cwd: work, modelProfileId: "gw-p", firstMessage: "hi", includePersonalConfig: true });
      expect(ok.status).toBe(200);
      const run = trace(work).at(-1);
      expect(run.argv.join(" ")).not.toContain("sk-personal-0123456789");
      expect(run.argv).not.toContain("--setting-sources");
      await api(t.port, token, "POST", `/v1/sessions/${ok.body.id}/kill`, {});
      writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "their-own" } }));
      const refused = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c-p" }, title: "x", cwd: work, modelProfileId: "gw-p", firstMessage: "hi", includePersonalConfig: true });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("validation");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("没填钥匙的网关配置不能开工；内置订阅配置不能删", async () => {
    await api(t.port, token, "PUT", "/v1/models/nokey", { label: "无钥匙", source: "gateway", baseUrl: "https://hub.example.com", model: "m" });
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c3" }, title: "x", cwd: work, modelProfileId: "nokey", firstMessage: "hi" });
    expect(s.status).toBe(400);
    expect((await api(t.port, token, "DELETE", "/v1/models/subscription")).status).toBe(404);
  });
});

describe("执行方异常", () => {
  it("版本太旧拒绝开工；登录失效报 auth_required；Codex 还没接", async () => {
    const work = tempDir("tl-work-");
    const t = await startTestRunner({ pickFolder: work });
    try {
      const token = await pair(t.port);
      await api(t.port, token, "POST", "/v1/folders/pick", {});
      writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ version: "2.0.9" }));
      const old = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" });
      expect(old.status).toBe(409);
      expect(old.body.error.code).toBe("agent_incompatible");

      writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ mode: "auth" }));
      const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" });
      const events = await readSse(t.port, token, s.body.id, { until: has("turn_end") });
      expect(events.find((e) => e.type === "notice")).toMatchObject({ code: "auth_required", level: "error" });
      expect(events.find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "auth" });

      const codex = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "topic", topicId: "t" }, title: "x", agent: "codex", firstMessage: "hi" });
      expect(codex.status).toBe(501);
    } finally {
      await t.cleanup();
    }
  });
});
