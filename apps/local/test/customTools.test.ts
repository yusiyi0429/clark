// 本人在连接页加的工具（契约 LocalTool，设计 9.5 · 11/08）：只收 HTTP 地址、钥匙只在本机程序里、挂给执行会话（规划员、验收员不挂）、读的照权限模式放行。
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalTool } from "@warmap/contracts";
import { modeAllows, type PathScope } from "../src/agents/pathGuard.js";
import { presetReads } from "../src/customTools.js";
import { createSecretStore } from "../src/secrets.js";
import { registerFormats } from "../src/store.js";
import { api, pair, raw, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const KEY = "kd-secret-0123456789abcdef";

/** 假 MCP 服务：要 Bearer 钥匙；initialize 用 SSE 回、带会话号，tools/list 用 JSON 回。记下收到的请求。 */
function fakeMcp() {
  const seen: { auth: string | undefined; method: string; session: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (d) => (body += d)).on("end", () => {
      const msg = JSON.parse(body || "{}");
      seen.push({ auth: req.headers.authorization, method: msg.method, session: req.headers["mcp-session-id"] as string | undefined });
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end(); }
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "kd-1" });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kd", version: "1" } } })}\n\n`);
      }
      const tools = [{ name: "query_voucher", inputSchema: { type: "object" } }, { name: "save_voucher", inputSchema: { type: "object" } }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/list" ? { tools } : {} }));
    });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port))) };
}

/** 数据目录下所有文件（递归）里有没有这串字：测试用的明文钥匙存储（secrets.plain.json）除外。 */
function filesContaining(dir: string, needle: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesContaining(p, needle));
    else if (name !== "secrets.plain.json" && readFileSync(p, "utf8").includes(needle)) out.push(p);
  }
  return out;
}

describe("本人加的工具", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-tools-");
  const mcp = fakeMcp();
  let url: string;
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);

  beforeAll(async () => {
    url = `http://127.0.0.1:${await mcp.listen()}/mcp`;
    t = await startTestRunner({ pickFolder: work });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
  });
  afterAll(async () => { await t.cleanup(); mcp.server.close(); });

  it("加一个 HTTP 工具：存完马上查，连上了；钥匙只写不读；改错钥匙是钥匙不对；能删", async () => {
    const put = await call("PUT", "/v1/tools/kd", { name: "金蝶", preset: "kingdee", url, apiKey: KEY });
    expect(put.status).toBe(200);
    expect(Value.Check(LocalTool, put.body)).toBe(true);
    expect(put.body).toMatchObject({ id: "kd", name: "金蝶", preset: "kingdee", url, keyHeader: null, hasKey: true, state: "ready", toolCount: 2, error: null });
    // 照 MCP 的走法：initialize（SSE 回）→ initialized → tools/list，后两步带上会话号
    expect(mcp.seen.map((s) => [s.method, s.session])).toEqual([["initialize", undefined], ["notifications/initialized", "kd-1"], ["tools/list", "kd-1"]]);
    const list = await call("GET", "/v1/tools");
    expect(list.body.tools).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(KEY);

    // 不带钥匙改名字：钥匙保留
    expect((await call("PUT", "/v1/tools/kd", { name: "金蝶云", preset: "kingdee", url })).body).toMatchObject({ name: "金蝶云", hasKey: true, state: "ready" });
    expect((await call("PUT", "/v1/tools/bad", { name: "错钥匙", preset: "custom", url, apiKey: "wrong-key" })).body).toMatchObject({ state: "unauthorized", toolCount: null });
    expect((await call("POST", "/v1/tools/bad/check", {})).body.state).toBe("unauthorized");
    expect((await call("PUT", "/v1/tools/gone", { name: "关了", preset: "custom", url: "http://127.0.0.1:9/mcp" })).body).toMatchObject({ state: "unreachable", error: "连不上" });
    expect((await call("DELETE", "/v1/tools/bad")).status).toBe(200);
    expect((await call("DELETE", "/v1/tools/gone")).status).toBe(200);
    expect((await call("POST", "/v1/tools/bad/check", {})).status).toBe(404);
    expect((await call("DELETE", "/v1/tools/bad")).status).toBe(404);
  });

  it("不收命令；别处的地址要 https；地址里不带账号口令", async () => {
    const reject = async (body: Record<string, unknown>) => (await call("PUT", "/v1/tools/x", { name: "x", preset: "custom", ...body })).status;
    expect(await reject({ url: "https://a.example.com/mcp", command: "node", args: ["evil.js"] })).toBe(400);
    expect(await reject({ command: "cmd.exe" })).toBe(400);
    expect(await reject({ url: "file:///C:/Windows/System32/cmd.exe" })).toBe(400);
    const plain = await call("PUT", "/v1/tools/x", { name: "x", preset: "custom", url: "http://kd.example.com/mcp", apiKey: KEY });
    expect([plain.status, plain.body.error.message]).toEqual([400, "只有本机地址可以用 http，别的要 https"]);
    expect(await reject({ url: "https://user:pass@a.example.com/mcp" })).toBe(400);
    expect((await call("GET", "/v1/tools")).body.tools.map((x: { id: string }) => x.id)).toEqual(["kd"]);
  });

  it("执行会话的 mcp.json 里有它：指向本机转发口，钥匙不在文件、命令行、环境变量里；转发时本机加上钥匙", async () => {
    const s = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "c-tool" }, title: "查凭证", cwd: work, firstMessage: "查一下" });
    expect(s.status).toBe(200);
    const dir = join(t.dataDir, "sessions", s.body.id);
    const servers = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers;
    expect(servers["tool-kd"]).toEqual({
      type: "http", url: `http://127.0.0.1:${t.port}/internal/sessions/${s.body.id}/tools/kd/mcp`, headers: { "x-tianshu-session-secret": "${TIANSHU_SESSION_SECRET}" },
    });
    expect(readFileSync(join(dir, "system.md"), "utf8")).toContain("- 金蝶云：MCP 服务器 tool-kd 里的工具");
    const trace = readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8");
    expect(trace).not.toContain(KEY);
    expect(trace).not.toContain("TIANSHU_TOOL");

    // 钥匙除了本机钥匙存储（测试里是明文的兜底文件），哪个文件里都没有
    expect(filesContaining(t.dataDir, KEY)).toEqual([]);
    expect(readFileSync(join(t.dataDir, "secrets.plain.json"), "utf8")).toContain(KEY);

    // 会话的 MCP 客户端经本机转发：本机换上钥匙
    const secret = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).mcpSecret;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const headers = { "x-tianshu-session-secret": secret, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const before = mcp.seen.length;
    const r = await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/tools/kd/mcp`, headers, body });
    expect(r.status).toBe(200);
    expect(r.body.result.tools.map((x: { name: string }) => x.name)).toEqual(["query_voucher", "save_voucher"]);
    expect(mcp.seen.slice(before)).toEqual([{ auth: `Bearer ${KEY}`, method: "tools/list", session: undefined }]);
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/tools/kd/mcp`, headers: { ...headers, "x-tianshu-session-secret": "wrong" }, body })).status).toBe(401);
    expect((await raw(t.port, { method: "POST", path: `/internal/sessions/${s.body.id}/tools/nope/mcp`, headers, body })).status).toBe(404);
    await call("POST", `/v1/sessions/${s.body.id}/kill`, {});
  });

  it("规划员不挂，也不给转", async () => {
    const p = await call("POST", "/v1/sessions", { subject: { kind: "plan", taskId: "T-tools" }, title: "拆卡", cwd: work, firstMessage: "拆" });
    expect(p.status).toBe(200);
    const dir = join(t.dataDir, "sessions", p.body.id);
    const servers = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers;
    expect(Object.keys(servers).some((k) => k.startsWith("tool-"))).toBe(false);
    expect(readFileSync(join(dir, "system.md"), "utf8")).not.toContain("本人加的工具");
    const secret = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).mcpSecret;
    const r = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${p.body.id}/tools/kd/mcp`,
      headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("本人加的工具：读的照权限模式放行，写的哪一档都问", () => {
  const folder = tempDir("tl-tools-pm-");
  const scope: PathScope = {
    cwd: folder, home: tempDir("tl-tools-home-"), allowedRoots: () => [folder],
    toolReads: (tool) => tool.startsWith("mcp__tool-kd__") && presetReads("kingdee", tool.slice("mcp__tool-kd__".length)),
  };
  const allows = (mode: Parameters<typeof modeAllows>[0], tool: string) => modeAllows(mode, tool, {}, scope, undefined, null);

  it("金蝶预设按名字认读写；其他工具一律不算读", () => {
    for (const name of ["query_voucher", "getAccountBalance", "list-accounts", "search", "view_report"]) expect(presetReads("kingdee", name), name).toBe(true);
    for (const name of ["save_voucher", "submitBill", "delete_voucher", "get_or_create_customer", "audit", "exportData"]) expect(presetReads("kingdee", name), name).toBe(false);
    expect(presetReads("custom", "query_voucher")).toBe(false);
  });

  it("读的：自动、全部放行不问，每次都问、先出计划、自动接受改文件照问；写的和认不出的：除了全部放行都问", () => {
    expect([allows("auto", "mcp__tool-kd__query_voucher"), allows("bypassPermissions", "mcp__tool-kd__query_voucher")]).toEqual([true, true]);
    for (const mode of ["default", "plan", "acceptEdits"] as const) expect(allows(mode, "mcp__tool-kd__query_voucher")).toBe(false);
    for (const mode of ["auto", "acceptEdits", "default"] as const) {
      expect(allows(mode, "mcp__tool-kd__save_voucher")).toBe(false);
      expect(allows(mode, "mcp__tool-other__query_voucher")).toBe(false);
    }
    // 全部放行只问三类（设计 17.2 第 33 条）：本人加的工具写的也放
    expect([allows("bypassPermissions", "mcp__tool-kd__save_voucher"), allows("bypassPermissions", "mcp__tool-other__query_voucher")]).toEqual([true, true]);
  });
});

describe.runIf(process.platform === "win32" && process.env.TIANSHU_LOCAL_PLAIN_SECRETS !== "1")("Windows 上钥匙加密存", () => {
  it("存进 DPAPI：文件里没有明文，读回来是原样", { timeout: 20_000 }, async () => {
    const dir = tempDir("tl-dpapi-");
    const store = createSecretStore(dir);
    await store.set("tool:kd", KEY);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(KEY);
    expect(await createSecretStore(dir).get("tool:kd")).toBe(KEY);
  });
});
