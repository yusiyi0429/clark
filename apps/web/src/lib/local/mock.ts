/**
 * 假本机程序：和真程序同一个接口（LocalRunner），按脚本吐事件——开工、三步计划、一次权限请求、一次提问、交回。
 * 开发时设 NEXT_PUBLIC_LOCAL_RUNNER=mock 切到它；测试里直接 createMockRunner()。
 * 状态只在内存里：同一个页面会话内跨页面保留，刷新就没了。
 */
import type {
  TLocalCreateSessionRequest, TLocalFolder, TLocalModelProfile, TLocalPermissionRequestView, TLocalPlanEntry,
  TLocalSessionEvent, TLocalSessionStatus, TLocalSessionSummary, TLocalUsage,
} from "@warmap/contracts";
import { LocalRunnerError, type EventWatch, type LocalRunner } from "./runner";

type Step = (s: MockSession) => void | "wait";
type MockSession = {
  summary: TLocalSessionSummary;
  log: TLocalSessionEvent[];
  listeners: Set<(event: TLocalSessionEvent) => void>;
  script: Step[];
  cursor: number;
  timer: ReturnType<typeof setTimeout> | null;
  pending: TLocalPermissionRequestView | null;
  /** 停下以后要等人说一句才接着走。 */
  paused: boolean;
  /** 上一个权限请求被拒了：那一步不执行。 */
  denied: boolean;
};

const ZERO: TLocalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const PLAN = ["读交代和现有代码", "改代码并补测试", "跑测试、整理交回"];

const MODELS: TLocalModelProfile[] = [
  { id: "subscription", label: "订阅 · 默认", source: "subscription", agent: "claude-code", baseUrl: null, model: null, smallModel: null, webSearch: true, hasKey: false, isDefault: true },
  { id: "sub-haiku", label: "订阅 · Haiku", source: "subscription", agent: "claude-code", baseUrl: null, model: "haiku", smallModel: null, webSearch: true, hasKey: false, isDefault: false },
  { id: "tokenhub-deepseek", label: "TokenHub · DeepSeek", source: "gateway", agent: "claude-code", baseUrl: "https://tokenhub.example/anthropic", model: "deepseek-v4.1-flash", smallModel: null, webSearch: true, hasKey: true, isDefault: false },
];

export type MockOptions = { stepMs?: number; paired?: boolean };

export function createMockRunner({ stepMs = 900, paired = true }: MockOptions = {}): LocalRunner {
  let token = paired ? "mock-token-0000000000000000000000" : "";
  const sessions = new Map<string, MockSession>();
  const folders: TLocalFolder[] = [{ id: "f1", path: "C:\\work\\tianshu", label: "tianshu", addedAt: new Date().toISOString() }];
  let linked = false;
  let includePersonal = false;
  let seqId = 0;

  const now = () => new Date().toISOString();
  const must = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new LocalRunnerError("not_found", "没有这个会话", 404);
    return s;
  };
  const emit = (s: MockSession, event: Record<string, unknown> & { type: TLocalSessionEvent["type"] }) => {
    const full = { seq: s.log.length + 1, at: now(), sessionId: s.summary.id, ...event } as TLocalSessionEvent;
    s.log.push(full);
    s.summary = { ...s.summary, lastSeq: full.seq, updatedAt: full.at };
    for (const listener of s.listeners) listener(full);
  };
  const setStatus = (s: MockSession, status: TLocalSessionStatus, reason?: string) => {
    s.summary = { ...s.summary, status };
    emit(s, { type: "status", status, ...(reason ? { reason } : {}) });
  };
  const plan = (s: MockSession, done: number) => emit(s, {
    type: "plan", entries: PLAN.map((content, i): TLocalPlanEntry => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })),
  });
  const tool = (s: MockSession, name: string, title: string) => {
    const toolUseId = `tu${++seqId}`;
    emit(s, { type: "tool_call", toolUseId, name, title, input: {} });
    emit(s, { type: "tool_result", toolUseId, isError: false, preview: "完成" });
  };
  const turnEnd = (s: MockSession, text: string | null, errorKind?: "interrupted") => {
    const usage = { ...ZERO, inputTokens: 1200, outputTokens: 320, costUsd: 0.004 };
    s.summary = { ...s.summary, usage: { ...s.summary.usage, inputTokens: s.summary.usage.inputTokens + 1200, outputTokens: s.summary.usage.outputTokens + 320, costUsd: (s.summary.usage.costUsd ?? 0) + 0.004 } };
    emit(s, { type: "turn_end", isError: false, text, durationMs: stepMs * 4, usage, ...(errorKind ? { errorKind } : {}) });
  };

  const script: Step[] = [
    (s) => { setStatus(s, "running"); emit(s, { type: "agent_info", agent: "claude-code", version: "2.1.318", model: s.summary.modelLabel, permissionMode: "manual" }); },
    (s) => { emit(s, { type: "assistant_text", text: "先读一下交代和相关代码，列个计划。" }); plan(s, 0); },
    (s) => { tool(s, "Read", "读 apps/web/src/app/manifest.ts"); plan(s, 1); },
    (s) => {
      const request: TLocalPermissionRequestView = { requestId: `perm-${++seqId}`, toolName: "Bash", title: "运行 pnpm --filter @warmap/web test", input: { command: "pnpm --filter @warmap/web test" }, canAllowForSession: true, requestedAt: now() };
      s.pending = request;
      s.summary = { ...s.summary, pendingPermissions: 1 };
      emit(s, { type: "permission_request", request });
      setStatus(s, "waiting_permission");
      return "wait";
    },
    (s) => {
      const ask = s.denied ? "不跑测试了。旧的安装说明要不要一起删掉？" : "测试过了。旧的安装说明要不要一起删掉？";
      if (!s.denied) tool(s, "Bash", "运行 pnpm --filter @warmap/web test");
      emit(s, { type: "assistant_text", text: ask });
      turnEnd(s, ask);
      setStatus(s, "idle");
      return "wait";
    },
    (s) => { setStatus(s, "running"); emit(s, { type: "assistant_text", text: "好，按你说的改。" }); plan(s, 2); },
    (s) => { tool(s, "Write", "写 交回说明.md"); emit(s, { type: "artifact", artifactId: `a${++seqId}`, title: "交回说明", fileName: "交回说明.md", size: 2048, sha256: "0".repeat(64) }); },
    (s) => {
      plan(s, 3);
      emit(s, { type: "handback", summary: "改完了，测试都过。", criteria: [{ index: 1, result: "met", evidence: "测试 12/12 通过" }, { index: 2, result: "met", evidence: "交回说明.md" }] });
      turnEnd(s, "改完了，已交回。");
      setStatus(s, "idle");
      return "wait";
    },
  ];

  const advance = (s: MockSession) => {
    if (s.timer || s.paused) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      const step = s.script[s.cursor];
      if (!step) return;
      s.cursor++;
      if (step(s) !== "wait") advance(s);
    }, stepMs);
  };

  const summaryOf = (s: MockSession) => ({ ...s.summary });
  const listen = (s: MockSession, fn: (event: TLocalSessionEvent) => void) => { s.listeners.add(fn); return () => s.listeners.delete(fn); };

  return {
    kind: "mock",
    health: async () => ({ app: "tianshu-local", version: "0.1.0-mock", protocol: 1, platform: "win32", tokenValid: Boolean(token) }),
    startPairing: async () => ({ pairingId: "mock-pairing", code: "4821", expiresAt: new Date(Date.now() + 120_000).toISOString() }),
    pairingStatus: async () => { token = "mock-token-0000000000000000000000"; return { status: "approved", token }; },
    unpair: async () => { token = ""; },
    status: async () => ({
      deviceId: "00000000-0000-4000-8000-000000000001", version: "0.1.0-mock",
      agents: [{ kind: "claude-code", installed: true, version: "2.1.318", path: null, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", loginExpiresAt: null, minimumVersion: "2.1.300", compatible: true, setup: { phase: "idle", startedAt: null, loginUrl: null, error: null } }],
      activeSessions: [...sessions.values()].filter((s) => !["exited", "failed", "idle"].includes(s.summary.status)).length,
      cloud: { linked, apiBaseUrl: linked ? location.origin : null, personName: null, outbox: { pending: 0, lastSyncedAt: linked ? now() : null, lastError: null } },
      settings: { includePersonalConfigByDefault: includePersonal, allowedOrigins: [typeof location === "undefined" ? "" : location.origin], paused: false },
    }),
    login: async () => undefined,
    linkCloud: async (body) => { linked = true; return { linked, apiBaseUrl: body.apiBaseUrl, personName: body.personName ?? null, outbox: { pending: 0, lastSyncedAt: null, lastError: null } }; },
    patchSettings: async (patch) => { if (patch.includePersonalConfigByDefault !== undefined) includePersonal = patch.includePersonalConfigByDefault; return { includePersonalConfigByDefault: includePersonal, allowedOrigins: [], paused: Boolean(patch.paused) }; },
    listModels: async () => MODELS,
    putModel: async (id, body) => ({ id, label: body.label, source: body.source, agent: "claude-code", baseUrl: body.baseUrl ?? null, model: body.model, smallModel: body.smallModel ?? null, webSearch: body.webSearch ?? false, hasKey: Boolean(body.apiKey), isDefault: Boolean(body.isDefault) }),
    listFolders: async () => folders,
    pickFolder: async () => { const folder = { id: `f${folders.length + 1}`, path: `C:\\work\\project-${folders.length + 1}`, label: `project-${folders.length + 1}`, addedAt: now() }; folders.push(folder); return folder; },
    removeFolder: async (id) => { const i = folders.findIndex((f) => f.id === id); if (i >= 0) folders.splice(i, 1); },
    listSessions: async () => [...sessions.values()].map(summaryOf).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createSession: async (body: TLocalCreateSessionRequest) => {
      if (!token) throw new LocalRunnerError("unauthorized", "没配对", 401);
      const model = MODELS.find((m) => m.id === body.modelProfileId) ?? MODELS[0]!;
      const id = crypto.randomUUID();
      const s: MockSession = {
        summary: { id, subject: body.subject, title: body.title, agent: "claude-code", modelProfileId: model.id, modelLabel: model.label, cwd: body.cwd ?? "topics", status: "starting", includePersonalConfig: Boolean(body.includePersonalConfig), createdAt: now(), updatedAt: now(), lastSeq: 0, pendingPermissions: 0, usage: { ...ZERO } },
        log: [], listeners: new Set(), script, cursor: 0, timer: null, pending: null, paused: false, denied: false,
      };
      sessions.set(id, s);
      emit(s, { type: "status", status: "starting" });
      emit(s, { type: "user_message", text: body.firstMessage, source: "initial" });
      advance(s);
      return summaryOf(s);
    },
    getSession: async (id) => { const s = must(id); return { session: summaryOf(s), pendingPermissions: s.pending ? [s.pending] : [] }; },
    sendMessage: async (id, text) => {
      const s = must(id);
      const was = s.summary.status;
      emit(s, { type: "user_message", text, source: "web" });
      s.paused = false;
      if (was === "running") { emit(s, { type: "notice", level: "info", code: "interjection_next_step", text: "下一步生效" }); return { delivery: "next_step" }; }
      advance(s);
      return { delivery: was === "exited" ? "resumed" : "new_turn" };
    },
    interrupt: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      s.paused = true;
      turnEnd(s, null, "interrupted");
      setStatus(s, "idle");
      return summaryOf(s);
    },
    kill: async (id) => {
      const s = must(id);
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      s.paused = true;
      setStatus(s, "exited", "强停");
      return summaryOf(s);
    },
    decidePermission: async (id, requestId, body) => {
      const s = must(id);
      if (!s.pending || s.pending.requestId !== requestId) throw new LocalRunnerError("not_found", "这个权限请求已经处理过了", 404);
      s.pending = null;
      s.summary = { ...s.summary, pendingPermissions: 0 };
      emit(s, { type: "permission_resolved", requestId, decision: body.decision, allowForSession: Boolean(body.allowForSession), ...(body.message ? { message: body.message } : {}) });
      setStatus(s, "running");
      s.denied = body.decision === "deny";
      advance(s);
      return summaryOf(s);
    },
    watch: async (id: string, { after, onEvent, onLink, signal }: EventWatch) => {
      const s = must(id);
      onLink?.(true);
      for (const event of s.log) if (event.seq > after) onEvent(event);
      const off = listen(s, onEvent);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { off(); resolve(); }, { once: true }));
    },
  };
}
