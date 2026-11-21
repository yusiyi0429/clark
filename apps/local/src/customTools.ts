import { join } from "node:path";
import type { TLocalTool, TLocalToolPreset, TLocalToolUpsert } from "@warmap/contracts";
import type { SecretStore } from "./secrets.js";
import { nowIso, readJson, writeJsonAtomic } from "./store.js";

/**
 * 本人在连接页加的工具（契约 LocalTool，设计 9.5 · 11/08）：给执行子会话挂的 HTTP MCP 服务器。
 * 配置存 <dataDir>/tools.json（没有钥匙），钥匙进本机凭据库。开执行会话时写进那个会话的 mcp.json，地址是本机程序的转发口
 * （/internal/sessions/:id/tools/:toolId/mcp，和天枢 MCP 一样带本会话密钥），本机程序转发时才加上钥匙：
 * 钥匙不进文件、不进命令行、也不进 Claude Code 的环境变量，所以会话里跑的命令拿不到。
 */
type Stored = Omit<TLocalTool, "hasKey">;
const keyName = (id: string) => `tool:${id}`;
export const MAX_TOOLS = 20;
/** 会话 mcp.json 里的服务器名：tool-<id>，工具名就是 mcp__tool-<id>__<名字>。 */
export const TOOL_SERVER_PREFIX = "tool-";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 预设的读工具名单（D-2）：名字的第一个词是读的动词、而且没有写的词，才算读。
 * 金蝶具体是哪款产品还没定，先按常见的读写动词认（照天枢 get_、list_ 的做法）；其他工具认不出哪些是读，一律问。
 */
const READ_HEAD = new Set(["get", "list", "query", "search", "read", "view", "fetch", "find", "describe", "count"]);
const WRITE_WORD = new Set(["create", "update", "delete", "remove", "add", "set", "save", "submit", "audit", "unaudit", "approve", "reject", "post", "write",
  "insert", "modify", "edit", "cancel", "send", "import", "upload", "push", "execute", "run", "close", "reopen", "allot", "draw", "transfer", "sync"]);
export function presetReads(preset: TLocalToolPreset, tool: string): boolean {
  if (preset !== "kingdee") return false;
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.\s]+/).filter(Boolean);
  return READ_HEAD.has(words[0] ?? "") && !words.some((w) => WRITE_WORD.has(w));
}

/** 钥匙会发给这个地址：https 才行，本机地址可以是 http。 */
function urlProblem(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "地址不对"; }
  if (u.username || u.password) return "地址里不要带账号口令，钥匙单独填";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return "只有本机地址可以用 http，别的要 https";
}

function keyHeaders(keyHeader: string | null, key: string): Record<string, string> {
  return keyHeader ? { [keyHeader]: key } : { Authorization: `Bearer ${key}` };
}

/** MCP 的回复可能是 JSON，也可能是 SSE（streamable HTTP）：取 id 对上的那一条。 */
async function rpcReply(res: Response, id: number): Promise<any> {
  const text = await res.text();
  const msgs = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [text];
  for (const m of msgs) {
    try { const j = JSON.parse(m); if (j?.id === id) return j; } catch { /* 不是 JSON */ }
  }
  return null;
}

type Probe = Pick<TLocalTool, "state" | "toolCount" | "error">;

/** 查连没连上：initialize → notifications/initialized → tools/list。不跟跳转（钥匙不跟着去别处）；钥匙不进原因。 */
export async function probeTool(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Probe> {
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
  let session: Record<string, string> = {};
  const post = async (body: Record<string, unknown>) => fetchImpl(url, {
    method: "POST", headers: { ...base, ...session }, body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const bad = (res: Response): Probe | null => {
    if (res.status === 401 || res.status === 403) return { state: "unauthorized", toolCount: null, error: "钥匙不对或过期了" };
    if (res.status >= 300 && res.status < 400) return { state: "unreachable", toolCount: null, error: "地址跳转到别处了，填跳转后的地址" };
    if (!res.ok) return { state: "unreachable", toolCount: null, error: `服务回了 ${res.status}` };
    return null;
  };
  try {
    const init = await post({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tianshu-local", version: "0.1.0" } } });
    const r1 = bad(init);
    if (r1) return r1;
    const reply = await rpcReply(init, 1);
    if (!reply?.result) return { state: "unreachable", toolCount: null, error: "回的不是 MCP" };
    const sid = init.headers.get("mcp-session-id");
    session = {
      ...(sid ? { "mcp-session-id": sid } : {}),
      ...(typeof reply.result.protocolVersion === "string" ? { "mcp-protocol-version": reply.result.protocolVersion } : {}),
    };
    await (await post({ method: "notifications/initialized" })).text().catch(() => "");
    const list = await post({ id: 2, method: "tools/list" });
    const r2 = bad(list);
    if (r2) return r2;
    const tools = (await rpcReply(list, 2))?.result?.tools;
    if (!Array.isArray(tools)) return { state: "unreachable", toolCount: null, error: "回的不是 MCP" };
    return { state: "ready", toolCount: tools.length, error: null };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { state: "unreachable", toolCount: null, error: timeout ? `${PROBE_TIMEOUT_MS / 1000} 秒没回` : "连不上" };
  }
}

/** 挂给一个执行会话的样子：mcp.json 的服务器条目、提示词里列的名字、读工具认法。 */
export interface SessionTools {
  servers: Record<string, unknown>;
  names: { server: string; name: string }[];
  /** 完整工具名（mcp__tool-x__y）是不是本人加的工具里读的那种。 */
  reads(tool: string): boolean;
}

export class CustomTools {
  private readonly file: string;
  constructor(dataDir: string, private readonly secrets: SecretStore, private readonly fetchImpl: typeof fetch = fetch) {
    this.file = join(dataDir, "tools.json");
  }

  private stored(): Stored[] { return readJson<Stored[]>(this.file, []); }

  private async view(t: Stored): Promise<TLocalTool> {
    return { ...t, hasKey: Boolean(await this.secrets.get(keyName(t.id))) };
  }

  async list(): Promise<TLocalTool[]> {
    const out: TLocalTool[] = [];
    for (const t of this.stored()) out.push(await this.view(t));
    return out;
  }

  /** 加或改；不合规矩抛 Error（接口回 400）。存完查一次。 */
  async upsert(id: string, body: TLocalToolUpsert): Promise<TLocalTool> {
    const why = urlProblem(body.url);
    if (why) throw new Error(why);
    const list = this.stored();
    const prev = list.find((t) => t.id === id);
    if (!prev && list.length >= MAX_TOOLS) throw new Error(`最多加 ${MAX_TOOLS} 个工具`);
    const next: Stored = {
      id, name: body.name, preset: body.preset, url: body.url, keyHeader: body.keyHeader ?? null,
      state: "unknown", toolCount: null, error: null, checkedAt: null, addedAt: prev?.addedAt ?? nowIso(),
    };
    writeJsonAtomic(this.file, prev ? list.map((t) => (t.id === id ? next : t)) : [...list, next]);
    if (body.apiKey !== undefined) {
      if (body.apiKey === "") await this.secrets.delete(keyName(id));
      else await this.secrets.set(keyName(id), body.apiKey);
    } else if (prev && prev.url !== next.url) {
      // 地址变了却没给新钥匙：旧钥匙作废，免得被网页改个地址就把本人的钥匙发到别处。
      await this.secrets.delete(keyName(id));
    }
    return (await this.check(id))!;
  }

  async remove(id: string): Promise<boolean> {
    const list = this.stored();
    if (!list.some((t) => t.id === id)) return false;
    writeJsonAtomic(this.file, list.filter((t) => t.id !== id));
    await this.secrets.delete(keyName(id));
    return true;
  }

  async check(id: string): Promise<TLocalTool | null> {
    const t = this.stored().find((x) => x.id === id);
    if (!t) return null;
    const key = await this.secrets.get(keyName(id));
    const found = await probeTool(t.url, key ? keyHeaders(t.keyHeader, key) : {}, this.fetchImpl);
    const next: Stored = { ...t, ...found, checkedAt: nowIso() };
    // 查的时候可能被删了或改了：只回写还是这一版的
    const now = this.stored();
    if (now.some((x) => x.id === id && x.url === t.url)) writeJsonAtomic(this.file, now.map((x) => (x.id === id ? { ...x, ...found, checkedAt: next.checkedAt } : x)));
    return this.view(next);
  }

  /** 转发时用：真地址和带钥匙的请求头（钥匙只在本机程序里用）。 */
  async upstream(id: string): Promise<{ url: string; headers: Record<string, string> } | null> {
    const t = this.stored().find((x) => x.id === id);
    if (!t) return null;
    const key = await this.secrets.get(keyName(id));
    return { url: t.url, headers: key ? keyHeaders(t.keyHeader, key) : {} };
  }

  /** 开执行会话时挂的全部工具：local 是本会话转发口的前缀，headers 是本会话密钥头（${变量名}）。 */
  forSession(local: string, headers: Record<string, string>): SessionTools {
    const servers: Record<string, unknown> = {};
    const names: SessionTools["names"] = [];
    const presets = new Map<string, TLocalToolPreset>();
    for (const t of this.stored()) {
      const server = `${TOOL_SERVER_PREFIX}${t.id}`;
      servers[server] = { type: "http", url: `${local}/tools/${t.id}/mcp`, headers };
      names.push({ server, name: t.name });
      presets.set(server, t.preset);
    }
    const reads = (tool: string) => {
      for (const [server, preset] of presets) {
        const prefix = `mcp__${server}__`;
        if (tool.startsWith(prefix)) return presetReads(preset, tool.slice(prefix.length));
      }
      return false;
    };
    return { servers, names, reads };
  }
}
