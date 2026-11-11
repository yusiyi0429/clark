/**
 * 真本机程序的客户端：直连 http://127.0.0.1:<端口>，口令放在 x-tianshu-local-token 头里。
 * 事件流不能用 EventSource（带不了口令头），用 fetch 读 SSE，断了带 Last-Event-ID 重连（RFC 第 4 节）。
 */
import type { TLocalCreateSessionBatchResponse, TLocalHealthResponse, TLocalModelProfile, TLocalSessionDraft, TLocalSessionEvent, TLocalSourceAddResponse, TLocalSourceCheckResponse, TLocalSourceListResponse } from "@warmap/contracts";
import { LOCAL_RUNNER_DEFAULT_PORT, LOCAL_RUNNER_ROUTES, LOCAL_RUNNER_TOKEN_HEADER } from "./routes";
import { LocalRunnerError, acceptsClientMessageId, acceptsFreeSession, type EventWatch, type LocalRunner } from "./runner";

type RouteName = keyof typeof LOCAL_RUNNER_ROUTES;

/** 口令只存本来源的 localStorage（本机按来源发口令）。 */
export const LOCAL_TOKEN_KEY = "tianshu-local-token-v1";

export function readLocalToken(): string {
  try { return localStorage.getItem(LOCAL_TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function writeLocalToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(LOCAL_TOKEN_KEY, token);
    else localStorage.removeItem(LOCAL_TOKEN_KEY);
  } catch { /* 存不了就只在本页有效 */ }
}

export function localRunnerBase(): string {
  const port = Number(process.env.NEXT_PUBLIC_LOCAL_RUNNER_PORT) || LOCAL_RUNNER_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

const pathOf = (name: RouteName, params: Record<string, string> = {}) =>
  LOCAL_RUNNER_ROUTES[name].path.replace(/:([A-Za-z]+)/g, (_m, key: string) => encodeURIComponent(params[key] ?? ""));

/** 把收到的一段 SSE 文本切成事件；没收完的半段留着下次拼。心跳注释（以 : 开头）跳过。type 是 `event:` 行（草稿是 draft），没有就是普通事件。 */
export function parseSse(buffer: string): { events: { id: number | null; data: string; type?: string }[]; rest: string } {
  const text = buffer.replace(/\r\n/g, "\n");
  const events: { id: number | null; data: string; type?: string }[] = [];
  let start = 0;
  for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n", start)) {
    const block = text.slice(start, end);
    start = end + 2;
    let id: number | null = null;
    let type: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || null;
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    if (data.length) events.push({ id, data: data.join("\n"), ...(type ? { type } : {}) });
  }
  return { events, rest: text.slice(start) };
}

const RETRY_MS = 1000;

export function createHttpRunner(base = localRunnerBase(), token: () => string = readLocalToken): LocalRunner {
  async function call<T>(name: RouteName, params: Record<string, string> = {}, body?: unknown): Promise<T> {
    const route = LOCAL_RUNNER_ROUTES[name];
    const write = route.method === "POST" || route.method === "PUT" || route.method === "PATCH";
    const headers: Record<string, string> = {};
    const key = token();
    if (key) headers[LOCAL_RUNNER_TOKEN_HEADER] = key;
    if (write) headers["content-type"] = "application/json";
    let response: Response;
    try {
      // 没有内容的写请求（停下、强停、选文件夹）也发 {}：本机只收 JSON。
      response = await fetch(base + pathOf(name, params), { method: route.method, headers, body: write ? JSON.stringify(body ?? {}) : undefined, cache: "no-store" });
    } catch (error) {
      throw new LocalRunnerError("network", error instanceof Error ? error.message : "连不上本机程序");
    }
    const json = await response.json().catch(() => null) as ({ error?: { code: LocalRunnerError["code"]; message: string } } & T) | null;
    if (!response.ok) throw new LocalRunnerError(json?.error?.code ?? "internal", json?.error?.message ?? `本机程序回了 ${response.status}`, response.status);
    return json as T;
  }

  async function watch(id: string, { after, onEvent, onDraft, onLink, signal }: EventWatch): Promise<void> {
    let last = after;
    while (!signal.aborted) {
      try {
        const response = await fetch(base + pathOf("sessionEvents", { id }) + (onDraft ? "?drafts=1" : ""), {
          headers: { [LOCAL_RUNNER_TOKEN_HEADER]: token(), ...(last ? { "last-event-id": String(last) } : {}) }, signal, cache: "no-store",
        });
        if (!response.ok || !response.body) throw new LocalRunnerError("network", `事件流 ${response.status}`, response.status);
        onLink?.(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseSse(buffer + decoder.decode(value, { stream: true }));
          buffer = parsed.rest;
          for (const item of parsed.events) {
            // 草稿没有编号，不动 last（不影响 Last-Event-ID）。
            if (item.type === "draft") { onDraft?.(JSON.parse(item.data) as TLocalSessionDraft); continue; }
            const event = JSON.parse(item.data) as TLocalSessionEvent;
            if (event.seq <= last) continue;
            last = event.seq;
            onEvent(event);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        // 会话没了（404）就不再重连。
        if (error instanceof LocalRunnerError && error.status === 404) return;
      }
      if (signal.aborted) return;
      onLink?.(false);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  let messageIds = false;
  let free = false;
  return {
    kind: "http",
    get clientMessageIds() { return messageIds; },
    get freeSessions() { return free; },
    health: async () => { const health = await call<TLocalHealthResponse>("health"); messageIds = acceptsClientMessageId(health); free = acceptsFreeSession(health); return health; },
    startPairing: (clientLabel) => call("startPairing", {}, { clientLabel }),
    pairingStatus: (pairingId) => call("pairingStatus", { pairingId }),
    unpair: async () => { await call("unpair"); },
    status: () => call("status"),
    login: async (agent = "claude-code") => { await call("loginAgent", { agent }, {}); },
    linkCloud: (body) => call("linkCloud", {}, body),
    patchSettings: (patch) => call("patchSettings", {}, patch),
    listModels: async () => (await call<{ profiles: Awaited<ReturnType<LocalRunner["listModels"]>> }>("listModels")).profiles,
    putModel: (id, body) => call("putModel", { id }, body),
    connectTokenHub: async (apiKey) => (await call<{ profiles: TLocalModelProfile[] }>("connectTokenHub", {}, { apiKey })).profiles,
    disconnectTokenHub: async () => { await call("disconnectTokenHub"); },
    listSources: () => call<TLocalSourceListResponse>("listSources"),
    checkSource: (body) => call<TLocalSourceCheckResponse>("checkSource", {}, body),
    addSource: (body) => call<TLocalSourceAddResponse>("addSource", {}, body),
    deleteSource: async (id) => { await call("deleteSource", { id }); },
    listTools: async () => (await call<{ tools: Awaited<ReturnType<LocalRunner["listTools"]>> }>("listTools")).tools,
    putTool: (id, body) => call("putTool", { id }, body),
    removeTool: async (id) => { await call("deleteTool", { id }); },
    checkTool: (id) => call("checkTool", { id }, {}),
    listFolders: async () => (await call<{ folders: Awaited<ReturnType<LocalRunner["listFolders"]>> }>("listFolders")).folders,
    pickFolder: (body = {}) => call("pickFolder", {}, body),
    createFolder: (body) => call("createFolder", {}, body),
    removeFolder: async (id) => { await call("deleteFolder", { id }); },
    listSessions: async () => (await call<{ sessions: Awaited<ReturnType<LocalRunner["listSessions"]>> }>("listSessions")).sessions,
    createSession: (body) => call("createSession", {}, body),
    createSessionBatch: async (items) => (await call<TLocalCreateSessionBatchResponse>("createSessionBatch", {}, { items })).results,
    getSession: (id) => call("getSession", { id }),
    sendMessage: (id, text, kind, attachments, messageId) => call("sendMessage", { id }, kind === "review" ? { kind, ...(text ? { text } : {}) }
      : { ...(text ? { text } : {}), ...(attachments?.length ? { attachments } : {}), ...(messageId ? { messageId } : {}) }),
    interrupt: async (id) => (await call<{ session: Awaited<ReturnType<LocalRunner["interrupt"]>> }>("interrupt", { id }, {})).session,
    setPermissionMode: async (id, mode) => (await call<{ session: Awaited<ReturnType<LocalRunner["setPermissionMode"]>> }>("setPermissionMode", { id }, { mode })).session,
    setSessionModel: (id, body) => call("setSessionModel", { id }, body),
    listSessionFiles: (id) => call("listSessionFiles", { id }),
    readSessionFile: (id, body) => call("readSessionFile", { id }, body),
    kill: async (id) => (await call<{ session: Awaited<ReturnType<LocalRunner["kill"]>> }>("kill", { id }, {})).session,
    decidePermission: async (id, requestId, body) => (await call<{ session: Awaited<ReturnType<LocalRunner["kill"]>> }>("decidePermission", { id, requestId }, body)).session,
    mergeSession: async (id) => call<Awaited<ReturnType<LocalRunner["mergeSession"]>>>("mergeSession", { id }, {}),
    answerQuestion: async (id, requestId, body) => (await call<{ session: Awaited<ReturnType<LocalRunner["kill"]>> }>("answerQuestion", { id, requestId }, body)).session,
    stopBackground: async (id, itemId) => (await call<{ session: Awaited<ReturnType<LocalRunner["kill"]>> }>("stopBackground", { id, itemId }, {})).session,
    putBudget: (body) => call("putBudget", {}, body),
    previewRun: (body) => call("previewRun", {}, body),
    listProjects: async () => (await call<{ projects: Awaited<ReturnType<LocalRunner["listProjects"]>> }>("listProjects")).projects,
    putProjectFolder: (projectId, body) => call("putProjectFolder", { projectId }, body),
    handoverCheck: (projectId) => call("handoverCheck", { projectId }, {}),
    cloneProject: (projectId, body) => call("cloneProject", { projectId }, body),
    watch,
  };
}
