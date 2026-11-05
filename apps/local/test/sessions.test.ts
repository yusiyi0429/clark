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
    expect(after("--allowedTools")).toContain("mcp__tianshu__submit_handback");
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
    const mcp = JSON.parse(readFileSync(join(sessionDir, "mcp.json"), "utf8")).mcpServers.tianshu;
    expect(mcp).toEqual({ type: "http", url: `http://127.0.0.1:${t.port}/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret } });
    writeFileSync(join(work, "方案.md"), "# 方案\n第一版");
    let n = 0;
    const rpc = async (method: string, params?: unknown) => (await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    })).body;
    expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name).toBe("tianshu-local");
    expect((await rpc("tools/list")).result.tools.map((x: any) => x.name)).toEqual(["add_artifact", "add_evidence", "submit_handback"]);
    expect((await rpc("tools/call", { name: "add_artifact", arguments: { path: "方案.md", title: "方案" } })).result.isError).toBe(false);
    expect((await rpc("tools/call", { name: "add_artifact", arguments: { path: "../../etc/passwd" } })).result.isError).toBe(true);
    expect((await rpc("tools/call", { name: "add_evidence", arguments: { kind: "link", title: "PR", url: "https://github.com/x/y/pull/1" } })).result.isError).toBe(false);
    const hb = await rpc("tools/call", { name: "submit_handback", arguments: { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "hello.txt 已写" }] } });
    expect(hb.result.isError).toBe(false);
    const note = await raw(t.port, { method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    const all = await readSse(t.port, token, id, { until: has("handback") });
    expect(all.find((e) => e.type === "artifact")).toMatchObject({ title: "方案", fileName: "方案.md" });
    expect(t.runner.outbox.status().pending).toBeGreaterThan(5); // 没关联云端：状态、计划、花费、产出物、交回都排着
  });
});

describe("模型配置与钥匙", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  beforeAll(async () => { t = await startTestRunner({ pickFolder: work }); token = await pair(t.port); await api(t.port, token, "POST", "/v1/folders/pick", {}); });
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
    expect(settings).toEqual({ skipWebFetchPreflight: true, env: { ANTHROPIC_BASE_URL: "https://hub.example.com", ANTHROPIC_MODEL: "deepseek-v4.1-flash", ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash" } });
    await api(t.port, token, "POST", `/v1/sessions/${s.body.id}/kill`, {});
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
