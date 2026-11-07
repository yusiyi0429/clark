import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LOCAL_RUNNER_PROTOCOL, LOCAL_RUNNER_ROUTES, LOCAL_RUNNER_TOKEN_HEADER,
  LocalPairingStartRequest, LocalAgentLoginCodeRequest, LocalCloudLinkRequest, LocalSettingsPatch, LocalModelProfileUpsert,
  LocalCreateSessionRequest, LocalCreateSessionBatchRequest, LocalSendMessageRequest, LocalPermissionDecisionRequest, LocalQuestionAnswerRequest, LocalBudgetUpdateRequest, LocalProjectFolderRequest, LocalProjectCloneRequest,
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
import type { QuotaTracker } from "../quota.js";
import type { GatewaySpend } from "../spend.js";
import type { CodexQuota } from "../codexQuota.js";
import { claudeTool } from "../tools.js";
import { handoverCheck, repoName, stripCredentials, type cloneRepo } from "../handover.js";
import type { CliTools } from "../tools.js";
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
  quota: QuotaTracker;
  spend: GatewaySpend;
  codexQuota: CodexQuota;
  tools: CliTools;
  pickFolder: () => Promise<string | null>;
  /** 接手项目时 clone 仓库（16.7；测试里换成从本地仓库 clone）。 */
  cloneRepo: typeof cloneRepo;
  onSettingsChange?: () => void;
  /** 转发天枢 MCP 用；测试里换成桩。 */
  fetchImpl: typeof fetch;
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

/** 会话和执行方的错误换成接口错误：一批开工的每件结果、单个请求的回复共用。 */
function errorOf(e: unknown): { code: TLocalRunnerErrorCode; message: string } {
  if (e instanceof HttpError || e instanceof SessionError || e instanceof AgentStartError) return { code: e.code, message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}
function statusOf(e: unknown): number {
  if (e instanceof SessionError) return e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : e.code === "folder_not_allowed" ? 403 : 400;
  if (e instanceof AgentStartError) return e.code === "not_implemented" ? 501 : e.code === "validation" ? 400 : 409;
  return 500;
}

export function createServer(d: ServerDeps): http.Server {
  const handlers: Record<RouteName, (c: Ctx) => Promise<unknown> | unknown> = {
    health: (c): TLocalHealthResponse => ({
      app: "tianshu-local", version: d.version, protocol: LOCAL_RUNNER_PROTOCOL,
      platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
      tokenValid: d.tokens.verify(c.token, c.origin),
      slots: d.sessions.slots(),
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
    status: async (): Promise<TLocalStatusResponse> => {
      const claude = await d.claude.status();
      // 额度读缓存；超过 5 分钟没读过就在后台读一次（不发提示、不花 token），下一次轮询就有了
      if (claude.installed && claude.loggedIn) void d.quota.refresh();
      void d.spend.refresh(); // TokenHub 今天、本月花了多少：同样 5 分钟读一次
      void d.codexQuota.refresh(); // Codex 订阅的额度（没装就不列）
      return {
        deviceId: d.config.deviceId, version: d.version, agents: [claude],
        activeSessions: d.sessions.activeCount(), slots: d.sessions.slots(), cloud: d.cloud.view(), settings: d.settings.get(),
        quota: [...d.quota.view(), ...d.codexQuota.view(), ...d.spend.view()], tools: [claudeTool(claude), ...d.tools.view()],
      };
    },
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
    patchSettings: async (c) => {
      const b = validate(LocalSettingsPatch, c.body);
      // 网页只能暂停，不能替本人恢复：暂停是本机这一侧的刹车。
      if (b.paused === false && d.settings.get().paused) throw new HttpError(409, "conflict", "只能在本机托盘里恢复");
      const s = d.settings.patch(b);
      if (b.paused) await d.sessions.interruptAll();
      // 调大上限时立刻从队里接上。
      d.sessions.pump();
      d.onSettingsChange?.();
      return s;
    },
    listModels: async () => ({ profiles: await d.models.list() }),
    putModel: async (c) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(c.params.id!)) throw new HttpError(400, "validation", "id 只能用字母数字、- 和 _");
      try { return await d.models.upsert(c.params.id!, validate(LocalModelProfileUpsert, c.body)); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "validation", e instanceof Error ? e.message : String(e));
      }
    },
    deleteModel: async (c) => { if (!(await d.models.remove(c.params.id!))) throw new HttpError(404, "not_found", "没有这个模型配置，或是内置配置"); return { ok: true }; },
    listFolders: () => ({ folders: d.folders.listWithProjects() }),
    pickFolder: async () => {
      const p = await d.pickFolder();
      if (!p) return { folder: null };
      const why = d.folders.rejectReason(p);
      if (why) throw new HttpError(400, "validation", why);
      return { folder: d.folders.add(p) };
    },
    deleteFolder: (c) => { if (!d.folders.remove(c.params.id!)) throw new HttpError(404, "not_found", "没有这个文件夹"); return { ok: true }; },
    listSessions: () => ({ sessions: d.sessions.list() }),
    createSession: (c) =>
      d.sessions.create(validate(LocalCreateSessionRequest, c.body), { includePersonalConfig: d.settings.get().includePersonalConfigByDefault }),
    // 一批开工：一件一件按顺序交给会话管理（有空位的马上开，满了的排队），一件失败不影响别的。
    createSessionBatch: async (c) => {
      const { items } = validate(LocalCreateSessionBatchRequest, c.body);
      const defaults = { includePersonalConfig: d.settings.get().includePersonalConfigByDefault };
      const results = [];
      for (const item of items) {
        try { results.push({ ok: true as const, session: await d.sessions.create(item, defaults) }); } catch (e) { results.push({ ok: false as const, error: errorOf(e) }); }
      }
      return { results };
    },
    getSession: (c) => d.sessions.get(c.params.id!),
    sessionEvents: (c) => streamEvents(c),
    sendMessage: (c) => d.sessions.sendMessage(c.params.id!, validate(LocalSendMessageRequest, c.body)),
    interrupt: async (c) => ({ session: await d.sessions.interrupt(c.params.id!) }),
    decidePermission: (c) => ({ session: d.sessions.decide(c.params.id!, c.params.requestId!, validate(LocalPermissionDecisionRequest, c.body)) }),
    kill: async (c) => ({ session: await d.sessions.kill(c.params.id!) }),
    mergeSession: (c) => d.sessions.merge(c.params.id!),
    answerQuestion: (c) => ({ session: d.sessions.answerQuestion(c.params.id!, c.params.requestId!, validate(LocalQuestionAnswerRequest, c.body)) }),
    stopBackground: async (c) => ({ session: await d.sessions.stopBackground(c.params.id!, c.params.itemId!) }),
    listBudgets: () => ({ budgets: d.sessions.budgets() }),
    putBudget: (c) => d.sessions.setBudget(validate(LocalBudgetUpdateRequest, c.body)),
    listProjects: () => ({ projects: d.folders.projects() }),
    putProjectFolder: (c) => {
      const b = validate(LocalProjectFolderRequest, c.body);
      const r = d.folders.bindProject(projectIdOf(c), b.folderId, b.name);
      if (!r) throw new HttpError(404, "not_found", "没有这个文件夹，先选文件夹");
      return r;
    },
    // 交接检查（16.7）：项目绑的文件夹现在什么样，只看 git
    handoverCheck: async (c) => {
      const p = d.folders.projects().find((x) => x.projectId === projectIdOf(c));
      return handoverCheck(projectIdOf(c), p?.folder ? { path: p.folder.path, label: p.folder.label } : null);
    },
    // 接手以后「拉到这台电脑」（16.7）：本人选放在哪，clone、切到交接分支、加进允许的文件夹、绑到项目
    cloneProject: async (c) => {
      const b = validate(LocalProjectCloneRequest, c.body);
      const parent = await d.pickFolder();
      if (!parent) return { project: null, branch: null, fellBack: false };
      const name = (b.name ?? repoName(b.repoUrl)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || "repo";
      const dest = join(parent, name);
      const why = d.folders.rejectReason(dest);
      if (why) throw new HttpError(400, "validation", why);
      if (existsSync(dest)) throw new HttpError(400, "validation", `${parent} 里已经有「${name}」了，换个地方，或者直接选那个文件夹绑上`);
      let got: Awaited<ReturnType<typeof cloneRepo>>;
      try { got = await d.cloneRepo(b.repoUrl, dest, b.branch); } catch (e) {
        throw new HttpError(409, "conflict", `没拉下来：${stripCredentials(e instanceof Error ? e.message : String(e)).replace(/(https?:\/\/)[^/@\s]*@/g, "$1").slice(0, 400)}`);
      }
      const folder = d.folders.add(dest);
      return { project: d.folders.bindProject(projectIdOf(c), folder.id), ...got };
    },
  };

  /** 项目 id 是天枢给的 uuid（和 projects.ts 一致）。 */
  function projectIdOf(c: Ctx): string {
    const id = c.params.projectId ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, "validation", "项目 id 不对");
    return id;
  }

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

  /** 内部接口只给 Claude Code 的 MCP 客户端用：浏览器发的请求一定带 Origin，带了就拒；还要本会话密钥（进程活着时才有效）。 */
  function internalGate(req: IncomingMessage, res: ServerResponse, sessionId: string): boolean {
    if (req.headers.origin !== undefined) { reject(res, { status: 403, code: "bad_origin", message: "内部接口不接受浏览器请求" }); return false; }
    const secret = req.headers["x-tianshu-session-secret"];
    if (!d.sessions.verifySecret(sessionId, typeof secret === "string" ? secret : undefined)) { reject(res, { status: 401, code: "unauthorized", message: "会话密钥不对" }); return false; }
    return true;
  }

  /** 本会话 MCP（交产出物、证据、交回）。 */
  async function handleSessionMcp(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (!internalGate(req, res, sessionId)) return;
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); } // 不提供服务端推送流
    const j = checkJson(req);
    if (j) return reject(res, j);
    try {
      const body = await readBody(req);
      const out = Array.isArray(body)
        ? (await Promise.all(body.map((m) => handleMcpMessage(d.sessions, sessionId, m)))).filter((r) => r !== null)
        : await handleMcpMessage(d.sessions, sessionId, body);
      if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
      send(res, 200, out);
    } catch (e) {
      send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  /**
   * 天枢 MCP（/mcp/me）经本机程序转发：云端令牌只在本机程序里，不进 Claude Code 的环境变量，
   * 所以它跑的命令、仓库里的脚本都拿不到。请求和响应（含流式响应）原样转发，只换掉鉴权头。
   */
  async function proxyCloudMcp(req: IncomingMessage, res: ServerResponse, sessionId: string) {
    if (!internalGate(req, res, sessionId)) return;
    const target = await d.cloud.target();
    if (!target) return reject(res, { status: 503, code: "cloud_not_linked", message: "还没关联天枢云端" });
    const headers: Record<string, string> = { authorization: `Bearer ${target.token}` };
    for (const h of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const body = req.method === "POST" ? new Uint8Array(await readRaw(req)) : undefined;
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const up = await d.fetchImpl(new URL("/mcp/me", target.apiBaseUrl), { method: req.method, headers, body, signal: abort.signal });
      const out: Record<string, string> = {};
      for (const h of ["content-type", "mcp-session-id", "cache-control"]) { const v = up.headers.get(h); if (v) out[h] = v; }
      res.writeHead(up.status, out);
      if (up.body) for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      reject(res, { status: 502, code: "internal", message: `连不上天枢云端：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const hostBad = checkHost(req, d.config.port);
    if (hostBad) return reject(res, hostBad);
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("/") || rawUrl.startsWith("//")) return reject(res, { status: 400, code: "validation", message: "请求路径不对" });
    const url = new URL(rawUrl, "http://127.0.0.1");
    const internal = /^\/internal\/sessions\/([0-9a-f-]{36})\/(mcp|cloud-mcp)$/.exec(url.pathname);
    if (internal) return internal[2] === "mcp" ? handleSessionMcp(req, res, internal[1]!) : proxyCloudMcp(req, res, internal[1]!);
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
    const params = Object.fromEntries(route.keys.map((k, i) => [k, safeDecode(m[i + 1]!)]));
    try {
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
      const out = await handlers[route.name]({ req, res, origin, params, body, token });
      if (out !== STREAMING) send(res, 200, out, cors);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return reject(res, e, cors);
      return reject(res, { status: statusOf(e), ...errorOf(e) }, cors);
    }
  }

  // 任何一个请求出错都不能带走整个常驻进程（Bun 下未捕获的异常会直接退出）。
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) reject(res, { status: 500, code: "internal", message: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error("请求体太大")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const STREAMING = Symbol("streaming");
