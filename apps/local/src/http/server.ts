import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LOCAL_RUNNER_PROTOCOL, LOCAL_RUNNER_ROUTES, LOCAL_RUNNER_TOKEN_HEADER,
  LocalPairingStartRequest, LocalAgentLoginCodeRequest, LocalCloudLinkRequest, LocalSettingsPatch, LocalModelProfileUpsert,
  LocalCreateSessionRequest, LocalSendMessageRequest, LocalPermissionDecisionRequest,
  type TLocalRunnerErrorCode, type TLocalStatusResponse, type TLocalHealthResponse,
} from "@warmap/contracts";
import { checkHost, checkJson, checkOrigin, corsHeaders, preflightHeaders, type Rejection } from "./security.js";
import { SessionError, type SessionManager } from "../sessions.js";
import { AgentStartError } from "../agents/types.js";
import type { TokenStore, Pairings } from "../pairing.js";
import type { EventLog } from "../eventLog.js";
import type { ModelProfiles } from "../models.js";
import type { Folders } from "../folders.js";
import type { ClaudeSetup } from "../agents/claudeSetup.js";
import type { CloudLink, Settings } from "../cloud.js";
import type { RunnerConfig } from "../config.js";
import { DEV_PAGE } from "./devPage.js";
import { handleMcpMessage } from "../sessionMcp.js";

export interface ServerDeps {
  config: RunnerConfig;
  version: string;
  tokens: TokenStore;
  pairings: Pairings;
  sessions: SessionManager;
  log: EventLog;
  models: ModelProfiles;
  folders: Folders;
  claude: ClaudeSetup;
  cloud: CloudLink;
  settings: Settings;
  pickFolder: () => Promise<string | null>;
  onSettingsChange?: () => void;
}

type RouteName = keyof typeof LOCAL_RUNNER_ROUTES;
type Ctx = { req: IncomingMessage; res: ServerResponse; origin: string; params: Record<string, string>; body: unknown; token: string | undefined };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: TLocalRunnerErrorCode, message: string) { super(message); }
}

const compiled = (Object.entries(LOCAL_RUNNER_ROUTES) as [RouteName, (typeof LOCAL_RUNNER_ROUTES)[RouteName]][]).map(([name, r]) => {
  const keys: string[] = [];
  const re = new RegExp("^" + r.path.replace(/:([A-Za-z]+)/g, (_m, k: string) => { keys.push(k); return "([^/]+)"; }) + "$");
  return { name, method: r.method as string, auth: r.auth as boolean, re, keys };
});

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "validation", "请求体太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new HttpError(400, "validation", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const reject = (res: ServerResponse, r: Rejection, headers: Record<string, string> = {}) =>
  send(res, r.status, { error: { code: r.code, message: r.message } }, headers);

function validate<T extends TSchema>(schema: T, body: unknown): any {
  if (Value.Check(schema, body)) return body;
  const first = [...Value.Errors(schema, body)][0];
  throw new HttpError(400, "validation", first ? `${first.path || "请求体"}：${first.message}` : "请求体不合格");
}

export function createServer(d: ServerDeps): http.Server {
  const handlers: Record<RouteName, (c: Ctx) => Promise<unknown> | unknown> = {
    health: (c): TLocalHealthResponse => ({
      app: "tianshu-local", version: d.version, protocol: LOCAL_RUNNER_PROTOCOL,
      platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
      tokenValid: d.tokens.verify(c.token, c.origin),
    }),
    startPairing: (c) => {
      const b = validate(LocalPairingStartRequest, c.body ?? {});
      const r = d.pairings.start(c.origin, b.clientLabel ?? "天枢网页");
      if (!r) throw new HttpError(429, "conflict", "配对请求太多，稍后再试");
      return r;
    },
    pairingStatus: (c) => {
      const r = d.pairings.status(c.params.pairingId!, c.origin);
      if (!r) throw new HttpError(404, "not_found", "没有这个配对请求");
      return r;
    },
    unpair: (c) => { d.tokens.revoke(c.token!); return { ok: true }; },
    status: async (): Promise<TLocalStatusResponse> => ({
      deviceId: d.config.deviceId, version: d.version, agents: [await d.claude.status()],
      activeSessions: d.sessions.activeCount(), cloud: d.cloud.view(), settings: d.settings.get(),
    }),
    installAgent: (c) => { agentMustBeClaude(c); if (!d.claude.install()) throw new HttpError(409, "conflict", "正在安装或登录中"); return { ok: true }; },
    loginAgent: async (c) => { agentMustBeClaude(c); if (!(await d.claude.login())) throw new HttpError(409, "conflict", "没装 Claude Code，或正在安装、登录中"); return { ok: true }; },
    loginAgentCode: (c) => {
      agentMustBeClaude(c);
      const b = validate(LocalAgentLoginCodeRequest, c.body);
      if (!d.claude.submitCode(b.code)) throw new HttpError(409, "conflict", "现在没有在等登录代码");
      return { ok: true };
    },
    cancelAgentSetup: (c) => { agentMustBeClaude(c); d.claude.cancel(); return { ok: true }; },
    getCloud: () => d.cloud.view(),
    linkCloud: async (c) => {
      const b = validate(LocalCloudLinkRequest, c.body);
      if (!d.cloud.originAllowed(b.apiBaseUrl)) throw new HttpError(400, "validation", "云端地址必须是允许的天枢来源");
      await d.cloud.link(b.apiBaseUrl, b.token, b.personName);
      return d.cloud.view();
    },
    unlinkCloud: async () => { await d.cloud.unlink(); return d.cloud.view(); },
    getSettings: () => d.settings.get(),
    patchSettings: (c) => { const s = d.settings.patch(validate(LocalSettingsPatch, c.body)); d.onSettingsChange?.(); return s; },
    listModels: async () => ({ profiles: await d.models.list() }),
    putModel: async (c) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(c.params.id!)) throw new HttpError(400, "validation", "id 只能用字母数字、- 和 _");
      try { return await d.models.upsert(c.params.id!, validate(LocalModelProfileUpsert, c.body)); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "validation", e instanceof Error ? e.message : String(e));
      }
    },
    deleteModel: async (c) => { if (!(await d.models.remove(c.params.id!))) throw new HttpError(404, "not_found", "没有这个模型配置，或是内置配置"); return { ok: true }; },
    listFolders: () => ({ folders: d.folders.list() }),
    pickFolder: async () => { const p = await d.pickFolder(); return { folder: p ? d.folders.add(p) : null }; },
    deleteFolder: (c) => { if (!d.folders.remove(c.params.id!)) throw new HttpError(404, "not_found", "没有这个文件夹"); return { ok: true }; },
    listSessions: () => ({ sessions: d.sessions.list() }),
    createSession: async (c) => {
      if (d.settings.get().paused) throw new HttpError(409, "conflict", "本机程序已暂停，先在托盘里恢复");
      return d.sessions.create(validate(LocalCreateSessionRequest, c.body), { includePersonalConfig: d.settings.get().includePersonalConfigByDefault });
    },
    getSession: (c) => d.sessions.get(c.params.id!),
    sessionEvents: (c) => streamEvents(c),
    sendMessage: (c) => d.sessions.sendMessage(c.params.id!, validate(LocalSendMessageRequest, c.body).text),
    interrupt: async (c) => ({ session: await d.sessions.interrupt(c.params.id!) }),
    decidePermission: (c) => ({ session: d.sessions.decide(c.params.id!, decodeURIComponent(c.params.requestId!), validate(LocalPermissionDecisionRequest, c.body)) }),
    kill: async (c) => ({ session: await d.sessions.kill(c.params.id!) }),
  };

  function agentMustBeClaude(c: Ctx) {
    if (c.params.agent === "codex") throw new HttpError(501, "not_implemented", "Codex 12 月接入");
    if (c.params.agent !== "claude-code") throw new HttpError(404, "not_found", "没有这个执行方");
  }

  /** SSE：先补发 Last-Event-ID（或 ?after=）之后的事件，再推新事件；15 秒一次心跳注释。 */
  function streamEvents(c: Ctx): symbol {
    const id = c.params.id!;
    d.sessions.get(id); // 不存在就抛 not_found
    const url = new URL(c.req.url ?? "/", "http://x");
    const fromHeader = Number(c.req.headers["last-event-id"]);
    const after = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Number(url.searchParams.get("after") ?? 0) || 0;
    c.res.writeHead(200, { ...corsHeaders(c.origin), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    let last = after;
    const write = (e: { seq: number }) => {
      if (e.seq <= last) return;
      last = e.seq;
      c.res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = d.log.subscribe(id, write);
    for (const e of d.log.after(id, after)) write(e);
    const ka = setInterval(() => c.res.write(": ka\n\n"), 15_000);
    c.req.on("close", () => { clearInterval(ka); unsubscribe(); });
    return STREAMING;
  }

  /** 本会话 MCP（HTTP）：只给 Claude Code 的 MCP 客户端用，浏览器发的请求一定带 Origin，带了就拒。 */
  async function handleSessionMcp(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (req.headers.origin !== undefined) return reject(res, { status: 403, code: "bad_origin", message: "内部接口不接受浏览器请求" });
    const secret = req.headers["x-tianshu-session-secret"];
    if (!d.sessions.verifySecret(sessionId, typeof secret === "string" ? secret : undefined)) return reject(res, { status: 401, code: "unauthorized", message: "会话密钥不对" });
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); } // 不提供服务端推送流
    const j = checkJson(req);
    if (j) return reject(res, j);
    try {
      const body = await readBody(req);
      const out = Array.isArray(body)
        ? body.map((m) => handleMcpMessage(d.sessions, sessionId, m)).filter((r) => r !== null)
        : handleMcpMessage(d.sessions, sessionId, body);
      if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  return http.createServer(async (req, res) => {
    const hostBad = checkHost(req, d.config.port);
    if (hostBad) return reject(res, hostBad);
    const url = new URL(req.url ?? "/", "http://x");
    const internal = /^\/internal\/sessions\/([0-9a-f-]{36})\/mcp$/.exec(url.pathname);
    if (internal) return handleSessionMcp(req, res, internal[1]!);
    // 开发测试页：只在 --dev 下提供；页面本身不含任何口令。
    if (d.config.dev && req.method === "GET" && url.pathname === "/dev" && req.headers.origin === undefined) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(DEV_PAGE);
    }
    const o = checkOrigin(req, d.config.allowedOrigins);
    if (!("origin" in o)) return reject(res, o);
    const { origin } = o;
    const cors = corsHeaders(origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, preflightHeaders(origin, req));
      return res.end();
    }
    const route = compiled.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return reject(res, { status: 404, code: "not_found", message: "没有这个接口" }, cors);
    const header = req.headers[LOCAL_RUNNER_TOKEN_HEADER];
    const token = typeof header === "string" ? header : undefined;
    if (route.auth && !d.tokens.verify(token, origin)) return reject(res, { status: 401, code: "unauthorized", message: "没配对或配对口令无效" }, cors);
    const jsonBad = checkJson(req);
    if (jsonBad) return reject(res, jsonBad, cors);
    const m = route.re.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]!]));
    try {
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
      const out = await handlers[route.name]({ req, res, origin, params, body, token });
      if (out !== STREAMING) send(res, 200, out, cors);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return reject(res, e, cors);
      if (e instanceof SessionError) {
        const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "folder_not_allowed" ? 403 : 400;
        return reject(res, { status, code: e.code, message: e.message }, cors);
      }
      if (e instanceof AgentStartError) {
        const status = e.code === "not_implemented" ? 501 : 409;
        return reject(res, { status, code: e.code, message: e.message }, cors);
      }
      return reject(res, { status: 500, code: "internal", message: e instanceof Error ? e.message : String(e) }, cors);
    }
  });
}

const STREAMING = Symbol("streaming");
