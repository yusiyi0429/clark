import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLocalEffort, TLocalPermissionMode, TLocalPermissionRequestView, TLocalUsage } from "@warmap/contracts";
import type { EventBody } from "../eventLog.js";
import { planProgress } from "../plan.js";
import { readJson, writeJsonAtomic } from "../store.js";
import { describeTool, homeDir, versionAtLeast } from "./claudeEnv.js";
import { codexEnv, CodexRpcError, openCodex, withCodex, type CodexBin, type CodexRpc } from "./codexRpc.js";
import { linkLarkSkills } from "./feishuPlugin.js";
import { CONTEXT_COMPACTED, ContextReporter } from "./contextUsage.js";
import { modeAllows, outsidePaths, permissionSummary, touchedPaths, type PathScope } from "./pathGuard.js";
import { AgentStartError, type AgentAdapter, type AgentLaunch, type AgentRun, type CompactResult, type PermissionAnswer, type TurnModels } from "./types.js";

/** 11/10 实测基于 codex-cli 0.159.2（app-server 的 turn/steer、两种批准、mcpServer/elicitation 都在稳定接口里）。 */
export const MIN_CODEX_VERSION = "0.159.0";

type Json = Record<string, any>;

const PREVIEW_CHARS = 600;
const INPUT_CHARS = 2_000;
/** Windows 上 Codex 把命令包进 PowerShell，按 PowerShell 认路径和危险命令；别的系统按 Bash。 */
const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 命令本身：commandActions 里是 Codex 解析好的（不带外面那层 pwsh -Command '…'），没有就用原样。 */
function commandOf(p: Json): string {
  const acts = Array.isArray(p.commandActions) ? p.commandActions.map((a: Json) => String(a?.command ?? "")).filter(Boolean) : [];
  return acts.length ? acts.join("; ") : String(p.command ?? "");
}

/** 一次改文件里的每个文件，按 Claude Code 的工具名对上权限规则：新建是 Write，改、删、挪是 Edit（挪的目标也算一个文件）。 */
function fileSteps(changes: Json[]): { tool: string; input: { file_path: string } }[] {
  const out: { tool: string; input: { file_path: string } }[] = [];
  for (const c of changes) {
    if (typeof c?.path !== "string") continue;
    out.push({ tool: c.kind?.type === "add" ? "Write" : "Edit", input: { file_path: c.path } });
    if (typeof c.kind?.move_path === "string") out.push({ tool: "Write", input: { file_path: c.kind.move_path } });
  }
  return out;
}

const n = (v: unknown) => Math.max(0, Number(v) || 0);

/** 线程累计用量里这一轮用了多少（Codex 没有金额，订阅的 costUsd 为 null）。 */
function usageBetween(start: Json | null, end: Json | null): TLocalUsage {
  const d = (k: string) => n(end?.[k]) - n(start?.[k]);
  const cached = Math.max(0, d("cachedInputTokens"));
  return {
    inputTokens: Math.max(0, d("inputTokens") - cached), outputTokens: Math.max(0, d("outputTokens")),
    cacheReadTokens: cached, cacheWriteTokens: Math.max(0, d("cacheWriteInputTokens")), costUsd: null,
  };
}

/** turn/completed 的出错原因 → 契约里的 errorKind。 */
function errorKindOf(info: unknown): string {
  if (info === "usageLimitExceeded") return "usage_limit";
  if (info === "unauthorized") return "auth";
  if (info === "rateLimitExceeded" || info === "serverOverloaded" || info === "internalServerError" || (info && typeof info === "object")) return "api";
  return "other";
}

/** 压缩途中进程没了、Codex 不接：没压成，也没花。 */
const compactFailed = (text: string): CompactResult => ({ ok: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, text });

/** reason：Codex 请求批准时给的理由（主循环第 64 条，有才有）。 */
interface Pending { kind: "command" | "file" | "mcp"; rpcId: number | string; steps: { tool: string; input: Record<string, unknown> }[]; hint: string | null; turnId: string; reason?: unknown }

export class CodexRun implements AgentRun {
  private readonly eventFns: ((e: EventBody) => void)[] = [];
  private readonly draftFns: ((text: string) => void)[] = [];
  /** 正在逐字写的那段话（agentMessage 的 itemId → 到目前为止的全文）。 */
  private readonly drafts = new Map<string, string>();
  private readonly exitFns: ((code: number | null) => void)[] = [];
  private readonly rateFns: ((info: Json) => void)[] = [];
  private readonly permissions = new Map<string, Pending>();
  /** 进行中的 item（改文件要先从 item/started 记下改哪些文件；MCP 的批准要对回是哪个工具）。 */
  private readonly items = new Map<string, Json>();
  /** 带编号发出、还没读到的话：Codex 把它作为 userMessage（clientId 就是编号）放进对话时算读到。 */
  private readonly receipts = new Set<string>();
  private turnId: string | null = null;
  /** 已经做完的轮：turn/start 的回执可能比这一轮的 turn/completed 晚到（一轮很快就做完），不能把做完的当成在跑。 */
  private readonly doneTurns = new Set<string>();
  /** 一轮还没开出来时又来的话：等 turn/start 回了再插进去，不然会各开一轮。 */
  private starting: Promise<void> | null = null;
  private lastText: string | null = null;
  private turnStartUsage: Json | null = null;
  private usage: Json | null = null;
  private requests = 0;
  private retried = false;
  /** 上下文用了多少（设计 17.2 第 42 条）：最近一次模型回复后 Codex 报的（最近一次请求的 token 数、模型上限）。 */
  private readonly context = new ContextReporter((e) => this.emit(e));
  private contextNow: { used: number; max: number | null } | null = null;
  /** 正在压缩上下文（thread/compact/start 开的那一轮）：压完交回结果。这一轮不报 agent_info、turn_end。 */
  private compacting: ((r: CompactResult) => void) | null = null;
  private markReported: () => void = () => {};
  private readonly exitReported = new Promise<void>((r) => { this.markReported = r; });
  lastTurn: TurnModels | null = null;

  constructor(
    private readonly rpc: CodexRpc, private readonly threadId: string, private readonly version: string, private readonly scope: PathScope & Pick<AgentLaunch, "beforeWrite">,
    private readonly autoAllowRoot: string | null, private mode: TLocalPermissionMode,
    /** 下一轮开始时带的模型和思考程度（换模型、换思考程度改这里，从下一轮起生效）。 */
    private model: string, private effort: TLocalEffort | null,
    /** 本机预先放行的工具（本会话的 MCP 工具）：Codex 来问时直接放行。 */
    private readonly preAllowed: Set<string>,
  ) {
    rpc.onNotification((m, p) => this.onNotification(m, p));
    rpc.onServerRequest((id, m, p) => this.onServerRequest(id, m, p));
    let errBuf = "";
    rpc.child.stderr.setEncoding("utf8").on("data", (d: string) => { errBuf = (errBuf + d).slice(-2_000); });
    rpc.child.on("exit", (code) => {
      this.compacting?.(compactFailed("执行方进程已结束"));
      this.compacting = null;
      for (const fn of this.exitFns) fn(code);
      this.markReported();
    });
  }

  get pid() { return this.rpc.child.pid; }
  /** 正在跑一轮（换模型、换思考程度要等这一轮做完）。 */
  get busy() { return this.turnId !== null || this.starting !== null; }
  onEvent(fn: (e: EventBody) => void) { this.eventFns.push(fn); }
  onDraft(fn: (text: string) => void) { this.draftFns.push(fn); }
  onExit(fn: (code: number | null) => void) { this.exitFns.push(fn); }
  onRateLimit(fn: (info: Json) => void) { this.rateFns.push(fn); }
  private emit(e: EventBody) { for (const fn of this.eventFns) fn(e); }
  private draft(text: string) { for (const fn of this.draftFns) fn(text); }

  send(text: string, messageId?: string) {
    if (messageId) this.receipts.add(messageId);
    const input = [{ type: "text", text, text_elements: [] }];
    const delivered = () => { if (messageId) this.emit({ type: "receipt", messageId, state: "delivered" }); };
    // 正在跑一轮：插话（turn/steer），这一次模型回复完了插进同一轮
    if (this.turnId) {
      void this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input, ...(messageId ? { clientUserMessageId: messageId } : {}) })
        // 插不进（这一轮刚好结束了）：当成新的一轮再说一次；进程没了就不再试
        .then(delivered, () => { if (this.rpc.exited) return; this.turnId = null; this.send(text, messageId); });
      return;
    }
    if (this.starting) { void this.starting.then(() => this.send(text, messageId)); return; }
    this.starting = this.rpc.request<Json>("turn/start", {
      threadId: this.threadId, input, model: this.model, ...(this.effort ? { effort: this.effort } : {}),
      ...(messageId ? { clientUserMessageId: messageId } : {}),
    }).then((r) => {
      const id = String(r.turn?.id ?? "");
      if (id && !this.doneTurns.has(id)) this.turnId ??= id;
      delivered();
    }, (e: unknown) => {
      this.emit({ type: "notice", level: "error", code: "agent_stderr", text: `Codex 没开出这一轮：${e instanceof Error ? e.message : String(e)}`.slice(0, 500) });
    }).finally(() => { this.starting = null; });
  }

  async interrupt() {
    if (this.starting) await this.starting;
    if (!this.turnId) return;
    await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 5_000).catch(() => {});
  }

  /** 压缩上下文（0.170.0 的 thread/compact/start，回 {} 以后照一轮的样子报 turn/started、contextCompaction、turn/completed）。 */
  compact(): Promise<CompactResult> {
    if (this.rpc.exited) return Promise.resolve(compactFailed("执行方进程已结束"));
    return new Promise((resolve) => {
      this.compacting = resolve;
      this.rpc.request("thread/compact/start", { threadId: this.threadId }).catch((e: unknown) => {
        if (this.compacting !== resolve) return;
        this.compacting = null;
        resolve(compactFailed(e instanceof Error ? e.message : String(e)));
      });
    });
  }

  respondPermission(requestId: string, a: PermissionAnswer): boolean {
    const p = this.permissions.get(requestId);
    if (!p) return false;
    this.permissions.delete(requestId);
    // Codex 的决定里不能带理由：本人写了话，先作为插话送进去再拒（11/06 实测模型在同一轮里接着读到）
    const reason = a.message?.trim();
    if (!a.allow && reason && this.turnId) {
      void this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: "text", text: `（本人拒绝了这一步）${reason}`, text_elements: [] }] }).catch(() => {});
    }
    this.answer(p, a.allow, Boolean(a.allowForSession));
    return true;
  }

  private answer(p: Pending, allow: boolean, forSession = false) {
    if (p.kind === "mcp") this.rpc.respond(p.rpcId, { action: allow ? "accept" : "decline", content: allow ? {} : null, _meta: null });
    else this.rpc.respond(p.rpcId, { decision: allow ? (forSession && p.kind === "file" ? "acceptForSession" : "accept") : "decline" });
  }

  async setPermissionMode(mode: TLocalPermissionMode): Promise<boolean> {
    if (this.rpc.exited || mode === "plan") return false;
    this.mode = mode;
    for (const [requestId, p] of this.permissions) {
      if (!this.allowed(p)) continue;
      this.permissions.delete(requestId);
      this.answer(p, true);
      this.emit({ type: "permission_resolved", requestId, decision: "allow", message: "换了权限模式，按新的模式放行", allowForSession: false });
    }
    return true;
  }

  isWaiting(requestId: string): boolean { return this.permissions.has(requestId); }
  respondQuestion(): boolean { return false; }
  async setMultiAgent(): Promise<boolean> { return false; }
  async stopTask(): Promise<boolean> { return false; }

  /** 下一轮起用这个模型（Codex 的模型是开一轮时带的，不用重开进程）。 */
  async setModel(model: string): Promise<boolean> { this.model = model; return !this.rpc.exited; }
  async setEffort(effort: TLocalEffort | null): Promise<boolean> { this.effort = effort; return !this.rpc.exited; }

  close() {
    if (this.rpc.exited) return;
    this.rpc.close();
    setTimeout(() => { if (!this.rpc.exited) void this.kill(); }, 10_000).unref();
  }

  kill(): Promise<void> {
    const pid = this.rpc.child.pid;
    if (pid === undefined) return Promise.resolve();
    if (this.rpc.exited) return this.exitReported;
    return new Promise((resolve) => {
      const done = () => resolve();
      void this.exitReported.then(done);
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => setTimeout(done, 2_000));
      else {
        try { process.kill(-pid, "SIGKILL"); } catch { try { this.rpc.child.kill("SIGKILL"); } catch { /* 已退出 */ } }
        setTimeout(done, 2_000);
      }
    });
  }

  /** 这一步按会话的权限模式能不能不问就放行：每个文件、命令都放行才算。 */
  private allowed(p: Pending): boolean {
    if (p.kind === "mcp" && p.steps.every((s) => this.preAllowed.has(s.tool))) return true;
    const scope = p.hint ? { ...this.scope, cwd: p.hint } : this.scope;
    return p.steps.length > 0 && p.steps.every((s) => modeAllows(this.mode, s.tool, s.input, scope, p.hint, this.autoAllowRoot));
  }

  private async ask(requestId: string, p: Pending) {
    // 先留一份（改已有文件的拷一份，命令等这一轮开头那份，undo/），再按权限模式放行或转给本人
    for (const s of p.steps) await this.scope.beforeWrite?.(s.tool, s.input).catch(() => undefined);
    if (this.allowed(p)) { this.answer(p, true); return; }
    this.permissions.set(requestId, p);
    const scope = p.hint ? { ...this.scope, cwd: p.hint } : this.scope;
    const outside = [...new Set(p.steps.flatMap((s) => outsidePaths(s.tool, s.input, scope, p.hint)))].slice(0, 20);
    const first = p.steps[0]!;
    const view: TLocalPermissionRequestView = {
      requestId,
      toolName: first.tool,
      title: clip(describeTool(first.tool, first.input) + (p.steps.length > 1 ? ` 等 ${p.steps.length} 个文件` : ""), 300),
      input: p.kind === "file" ? { files: p.steps.map((s) => s.input.file_path) } : Object.fromEntries(Object.entries(first.input).map(([k, v]) => [k, typeof v === "string" ? clip(v, INPUT_CHARS) : v])),
      outsidePaths: outside,
      // 只有改文件能「这个会话都允许」（Codex 的 acceptForSession 只在本会话内）；命令的「以后都允许」会写进 Codex 的规则文件，不用
      canAllowForSession: p.kind === "file" && !outside.length,
      requestedAt: new Date().toISOString(),
      ...permissionSummary(p.reason, p.steps.flatMap((s) => touchedPaths(s.tool, s.input, scope))),
    };
    this.emit({ type: "permission_request", request: view });
  }

  private onServerRequest(id: number | string, method: string, p: Json) {
    const requestId = `cx-${String(id)}-${String(p.itemId ?? p.turnId ?? "")}`.slice(0, 120);
    if (method === "item/commandExecution/requestApproval") {
      const cwd = typeof p.cwd === "string" ? p.cwd : null;
      void this.ask(requestId, { kind: "command", rpcId: id, steps: [{ tool: SHELL, input: { command: commandOf(p) } }], hint: cwd, turnId: String(p.turnId ?? ""), reason: p.reason });
      return;
    }
    if (method === "item/fileChange/requestApproval") {
      const item = this.items.get(String(p.itemId));
      void this.ask(requestId, { kind: "file", rpcId: id, steps: fileSteps(Array.isArray(item?.changes) ? item.changes : []), hint: null, turnId: String(p.turnId ?? ""), reason: p.reason });
      return;
    }
    if (method === "mcpServer/elicitation/request" && p._meta?.codex_approval_kind === "mcp_tool_call") {
      // 对回是哪个工具：这个服务器上正在跑、还没批的那个 MCP 调用
      const call = [...this.items.values()].reverse().find((i) => i.type === "mcpToolCall" && i.server === p.serverName && i.status === "inProgress" && !i.asked);
      const tool = call?.tool ?? /tool "([^"]+)"/.exec(String(p.message ?? ""))?.[1] ?? "unknown";
      if (call) call.asked = true;
      const args = call?.arguments && typeof call.arguments === "object" ? call.arguments : (p._meta?.tool_params ?? {});
      void this.ask(requestId, { kind: "mcp", rpcId: id, steps: [{ tool: `mcp__${String(p.serverName)}__${tool}`, input: args }], hint: null, turnId: String(p.turnId ?? "") });
      return;
    }
    if (method === "mcpServer/elicitation/request") { this.rpc.respond(id, { action: "decline", content: null, _meta: null }); return; }
    if (method === "item/permissions/requestApproval") { this.rpc.respond(id, { permissions: {}, scope: "turn" }); return; }
    if (method === "item/tool/requestUserInput") { this.rpc.respond(id, { answers: {} }); return; }
    this.rpc.respondError(id, "天枢本机程序不支持这个请求");
  }

  private onNotification(method: string, p: Json) {
    switch (method) {
      case "turn/started": {
        this.turnId = String(p.turn?.id ?? "") || this.turnId;
        this.turnStartUsage = this.usage;
        this.requests = 0;
        this.lastText = null;
        if (this.compacting) return; // 压缩不算一轮
        this.emit({ type: "agent_info", agent: "codex", version: this.version, model: this.model, permissionMode: this.mode });
        return;
      }
      case "item/started": {
        const item = p.item ?? {};
        const id = String(item.id ?? "");
        this.items.set(id, item);
        if (item.type === "userMessage" && typeof item.clientId === "string" && this.receipts.delete(item.clientId)) {
          this.emit({ type: "receipt", messageId: item.clientId, state: "read" });
        } else if (item.type === "commandExecution") {
          const command = commandOf(item);
          this.emit({ type: "tool_call", toolUseId: id, name: SHELL, title: describeTool(SHELL, { command }), input: { command: clip(command, INPUT_CHARS) } });
        } else if (item.type === "fileChange") {
          const steps = fileSteps(Array.isArray(item.changes) ? item.changes : []);
          const first = steps[0];
          this.emit({ type: "tool_call", toolUseId: id, name: first?.tool ?? "Edit", title: first ? describeTool(first.tool, first.input) + (steps.length > 1 ? ` 等 ${steps.length} 个文件` : "") : "改文件", input: { files: steps.map((s) => s.input.file_path) } });
        } else if (item.type === "mcpToolCall") {
          const name = `mcp__${String(item.server)}__${String(item.tool)}`;
          this.emit({ type: "tool_call", toolUseId: id, name, title: describeTool(name, {}), input: item.arguments && typeof item.arguments === "object" ? item.arguments : {} });
        } else if (item.type === "webSearch") {
          this.emit({ type: "tool_call", toolUseId: id, name: "WebSearch", title: describeTool("WebSearch", { query: String(item.query ?? "") }), input: { query: String(item.query ?? "") } });
        }
        return;
      }
      case "item/agentMessage/delta": {
        // 正文逐字来：报这段到目前为止的全文当草稿（思考是 item/reasoning/*，不报）
        if (typeof p.delta !== "string" || (p.threadId && this.threadId && p.threadId !== this.threadId)) return;
        const id = String(p.itemId ?? "");
        const text = (this.drafts.get(id) ?? "") + p.delta;
        this.drafts.set(id, text);
        if (text.trim()) this.draft(text);
        return;
      }
      case "item/completed": {
        const item = p.item ?? {};
        const id = String(item.id ?? "");
        this.items.delete(id);
        this.drafts.delete(id);
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
          this.lastText = item.text;
          this.emit({ type: "assistant_text", text: item.text });
        } else if (item.type === "commandExecution") {
          const ok = item.status === "completed" && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined);
          const out = item.status === "declined" ? "本人没有允许" : String(item.aggregatedOutput ?? "");
          this.emit({ type: "tool_result", toolUseId: id, isError: !ok, preview: clip(out, PREVIEW_CHARS) });
        } else if (item.type === "fileChange") {
          this.emit({ type: "tool_result", toolUseId: id, isError: item.status !== "completed", preview: item.status === "declined" ? "本人没有允许" : item.status === "completed" ? "已改好" : "没改成" });
        } else if (item.type === "mcpToolCall") {
          const text = item.error ? String(item.error.message ?? "出错了") : Array.isArray(item.result?.content) ? item.result.content.map((c: Json) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n") : "";
          this.emit({ type: "tool_result", toolUseId: id, isError: Boolean(item.error) || item.status === "failed", preview: clip(text, PREVIEW_CHARS) });
        } else if (item.type === "webSearch") {
          this.emit({ type: "tool_result", toolUseId: id, isError: false, preview: "" });
        } else if (item.type === "contextCompaction") {
          this.emit(CONTEXT_COMPACTED);
        }
        return;
      }
      case "serverRequest/resolved": {
        // Codex 自己撤回了还在等的批准（这一轮被停了）
        for (const [requestId, pend] of this.permissions) {
          if (pend.rpcId !== p.requestId) continue;
          this.permissions.delete(requestId);
          this.emit({ type: "permission_resolved", requestId, decision: "deny", message: "已撤回", allowForSession: false });
        }
        return;
      }
      case "turn/plan/updated": {
        const status = (s: unknown) => (s === "completed" ? "completed" : s === "inProgress" ? "in_progress" : "pending") as "pending" | "in_progress" | "completed";
        const entries = (Array.isArray(p.plan) ? p.plan : []).filter((s: Json) => typeof s?.step === "string").map((s: Json) => ({ content: String(s.step), status: status(s.status) }));
        this.emit({ type: "plan", entries, progress: planProgress(entries) });
        return;
      }
      case "thread/tokenUsage/updated": {
        this.usage = p.tokenUsage?.total ?? this.usage;
        this.requests += 1;
        const window = Number(p.tokenUsage?.modelContextWindow);
        if (p.tokenUsage?.last) {
          this.contextNow = { used: Math.round(n(p.tokenUsage.last.totalTokens)), max: window > 0 ? Math.round(window) : null };
          this.context.report(this.contextNow.used, this.contextNow.max);
        }
        return;
      }
      case "account/rateLimits/updated":
        if (p.rateLimits && typeof p.rateLimits === "object") for (const fn of this.rateFns) fn(p.rateLimits);
        return;
      case "error":
        if (p.willRetry) {
          this.retried = true;
          this.emit({ type: "notice", level: "warn", code: "api_retry", text: `模型服务出错（${clip(String(p.error?.message ?? ""), 120)}），Codex 正在重试` });
        }
        return;
      case "turn/completed": {
        const turn = p.turn ?? {};
        if (turn.id && this.turnId && turn.id !== this.turnId) return;
        if (turn.id) this.doneTurns.add(String(turn.id));
        this.turnId = null;
        this.items.clear();
        // 这一轮完了还有没写完的那段（停下、出错）：草稿清掉
        if ([...this.drafts.values()].some((t) => t.trim())) this.draft("");
        this.drafts.clear();
        const usage = usageBetween(this.turnStartUsage, this.usage);
        this.lastTurn = { models: [{ model: this.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, costBasis: null, requests: this.requests || null }] };
        const status = String(turn.status ?? "completed");
        const isError = status !== "completed";
        const kind = status === "interrupted" ? "interrupted" : isError ? errorKindOf(turn.error?.codexErrorInfo) : null;
        const retried = this.retried;
        this.retried = false;
        if (kind === "auth") this.emit({ type: "notice", level: "error", code: "auth_required", text: "Codex 还没登录或登录已失效，请在天枢里登录 Codex。" });
        if (this.contextNow) this.context.report(this.contextNow.used, this.contextNow.max, true);
        const compacted = this.compacting;
        if (compacted) {
          // 压完了：不报 turn_end，交回结果（压完的用量上面刚报过）
          this.compacting = null;
          compacted({ ok: !isError, usage, text: isError && turn.error?.message ? String(turn.error.message) : null });
          return;
        }
        this.emit({
          type: "turn_end", isError,
          text: isError && turn.error?.message ? String(turn.error.message) : this.lastText,
          durationMs: Math.max(0, Math.round(n(turn.durationMs))),
          usage,
          ...(isError ? { errorKind: kind === "other" && retried ? "api" : kind } : {}),
        } as EventBody);
        return;
      }
      default:
        return;
    }
  }
}

/** 天枢会话 → Codex 线程（Codex 的线程号是它自己起的，续接要用）：存在本机程序数据目录里。 */
class ThreadMap {
  constructor(private readonly file: string) {}
  get(sessionId: string): string | null { return readJson<Record<string, string>>(this.file, {})[sessionId] ?? null; }
  set(sessionId: string, threadId: string) { writeJsonAtomic(this.file, { ...readJson<Record<string, string>>(this.file, {}), [sessionId]: threadId }); }
}

/** TOML 字符串（-c 的值按 TOML 解析）。 */
const toml = (s: string) => JSON.stringify(s);

/**
 * 本会话的 MCP（本机程序写的 mcp.json，Claude Code 的格式）→ Codex 的 -c mcp_servers.*。只有 HTTP 的（本机程序的转发地址）；
 * 值是 ${变量名} 的请求头走 env_http_headers（钥匙只经子进程环境变量传，不进命令行），写死的走 http_headers。
 */
export function mcpArgs(path: string | null): string[] {
  if (!path) return [];
  let servers: Record<string, Json> = {};
  try { servers = JSON.parse(readFileSync(path, "utf8")).mcpServers ?? {}; } catch { return []; }
  const args: string[] = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof s?.url !== "string") continue;
    args.push("-c", `mcp_servers.${name}.url=${toml(s.url)}`);
    const fromEnv: string[] = [];
    const fixed: string[] = [];
    for (const [h, v] of Object.entries((s.headers ?? {}) as Record<string, string>)) {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v));
      (m ? fromEnv : fixed).push(`${toml(h)}=${toml(m ? m[1]! : String(v))}`);
    }
    if (fromEnv.length) args.push("-c", `mcp_servers.${name}.env_http_headers={${fromEnv.join(",")}}`);
    if (fixed.length) args.push("-c", `mcp_servers.${name}.http_headers={${fixed.join(",")}}`);
  }
  return args;
}

/** 本人自己的技能列一次要另起一个 app-server：5 分钟内不重列。 */
const USER_SKILLS_TTL_MS = 5 * 60_000;

export interface CodexAdapterOptions {
  /** Codex 的配置目录：天枢专用的（登录也在里面），null 是本人的 ~/.codex。 */
  home: string | null;
  /** 本机程序的数据目录：记天枢会话对应的 Codex 线程。 */
  dataDir: string;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Codex 适配器（设计 17.2 第 38 条，协议见 RFC 附录 E）：每个会话起一个 codex app-server（stdio JSON-RPC）。
 * 以 approvalPolicy untrusted、sandbox workspace-write 起，命令、改文件、非只读的 MCP 工具每一步都先到本机（11/10 实测），本机按权限模式放行或转给网页。
 * 模型和思考程度在开每一轮（turn/start）时带。工作规矩和岗位走 developerInstructions。
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  private readonly threads: ThreadMap;
  private userSkills: { at: number; list: { name: string; path: string }[] } | null = null;

  constructor(private readonly resolveBin: () => Promise<CodexBin | null>, private readonly opts: CodexAdapterOptions) {
    this.threads = new ThreadMap(join(opts.dataDir, "codex-threads.json"));
  }

  /**
   * 干净会话（没开「带上个人配置」）不带本人自己的技能，同 Claude Code 那边：用天枢专用的配置目录就是要本人的技能、插件、记忆不带进来，
   * 但 Codex 还会读本人主目录下的 ~/.agents/skills（11/10 实测 0.159.2，和配置目录在哪无关）。所以起会话时把它列出来的本人技能（scope 是 user 的）一个个关掉：
   * 命令行的 -c skills.config=[{path, enabled=false}]，只对这一个进程生效（实测）；技能要飞书的留着 lark-*。列不出来（老版本没有 skills/list）就不关。
   */
  private async personalSkillsOff(bin: CodexBin, launch: AgentLaunch): Promise<string[]> {
    if (launch.includePersonalConfig) return [];
    if (!this.userSkills || Date.now() - this.userSkills.at > USER_SKILLS_TTL_MS) {
      const env = codexEnv(this.opts.baseEnv ?? process.env, this.opts.home);
      const listed = await withCodex(bin, env, (rpc) => rpc.request<Json>("skills/list", { cwds: [launch.cwd], forceReload: true }, 20_000)).catch(() => null);
      if (listed) {
        const skills = (Array.isArray(listed.data) ? listed.data : []).flatMap((e: Json) => (Array.isArray(e?.skills) ? e.skills : []));
        this.userSkills = { at: Date.now(), list: skills.filter((s: Json) => s?.scope === "user" && typeof s.path === "string" && typeof s.name === "string").map((s: Json) => ({ name: s.name, path: s.path })) };
      }
    }
    const off = (this.userSkills?.list ?? []).filter((s) => !(launch.feishuSkillsDir && s.name.startsWith("lark-")));
    return off.length ? ["-c", `skills.config=[${off.map((s) => `{path=${toml(s.path)},enabled=false}`).join(",")}]`] : [];
  }

  async start(launch: AgentLaunch): Promise<AgentRun> {
    const bin = await this.resolveBin();
    if (!bin) throw new AgentStartError("agent_not_installed", "这台电脑上没找到 Codex");
    const model = launch.model.model;
    if (!model) throw new AgentStartError("validation", "Codex 的模型配置没有模型名");
    // 技能要飞书：本人已装的飞书技能链接进天枢专用的配置目录（本人自己的 ~/.codex 不动）；链接变了，本人技能重列一次
    if (launch.feishuSkillsDir && this.opts.home && linkLarkSkills(join(this.opts.home, "skills"), launch.feishuSkillsDir)) this.userSkills = null;
    const extraDirs = launch.extraDirs();
    const args = [
      ...mcpArgs(launch.mcpConfigPath),
      ...(await this.personalSkillsOff(bin, launch)),
      // 角色的工具名单里没有联网搜索时关掉 Codex 自带的
      ...(launch.disallowedTools.includes("WebSearch") ? ["-c", 'web_search="disabled"'] : []),
      // 项目另外绑的文件夹：沙箱里也算可写的目录。Windows 上 Codex 实际以只读起（11/10 实测 0.159.2），写和命令本来就每一步先到本机，这一项带了不起作用也不报错
      ...(extraDirs.length ? ["-c", `sandbox_workspace_write.writable_roots=[${extraDirs.map(toml).join(",")}]`] : []),
    ];
    const env = codexEnv(this.opts.baseEnv ?? process.env, this.opts.home, launch.mcpEnv);
    let opened: Awaited<ReturnType<typeof openCodex>>;
    try {
      opened = await openCodex(bin, env, { cwd: launch.cwd, args, detached: process.platform !== "win32" });
    } catch (e) {
      throw new AgentStartError("agent_not_installed", `Codex 启动失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const { rpc, version } = opened;
    const fail = async (code: "agent_incompatible" | "agent_not_logged_in" | "validation", text: string): Promise<never> => {
      rpc.close();
      try { rpc.child.kill(); } catch { /* 已退出 */ }
      throw new AgentStartError(code, text);
    };
    if (!version || !versionAtLeast(version, MIN_CODEX_VERSION)) return fail("agent_incompatible", `Codex ${version || "版本不明"} 太旧，请升级到 ${MIN_CODEX_VERSION} 以上`);
    const account = await rpc.request<Json>("account/read", { refreshToken: false }).catch(() => null);
    if (account?.requiresOpenaiAuth && !account.account) return fail("agent_not_logged_in", "Codex 还没登录，请在天枢的连接页登录 Codex");
    let instructions: string | null = null;
    try { instructions = launch.systemPromptPath ? readFileSync(launch.systemPromptPath, "utf8") : null; } catch { /* 没写 */ }
    const params = { cwd: launch.cwd, approvalPolicy: "untrusted", sandbox: "workspace-write", model, ...(instructions ? { developerInstructions: instructions } : {}) };
    const prev = launch.resume ? this.threads.get(launch.sessionId) : null;
    let threadId: string;
    try {
      const r = prev ? await rpc.request<Json>("thread/resume", { threadId: prev, ...params }, 60_000) : await rpc.request<Json>("thread/start", params, 60_000);
      threadId = String(r.thread?.id ?? "");
      if (!threadId) throw new CodexRpcError(0, "Codex 没给线程号");
    } catch (e) {
      return fail("agent_incompatible", `Codex 没开出会话：${e instanceof Error ? e.message : String(e)}`);
    }
    this.threads.set(launch.sessionId, threadId);
    const scope: PathScope & Pick<AgentLaunch, "beforeWrite"> = { cwd: launch.cwd, home: homeDir(), allowedRoots: launch.allowedRoots, readRoots: launch.readRoots, toolReads: launch.toolReads, extraDirs: launch.extraDirs, covered: launch.covered, beforeWrite: launch.beforeWrite };
    return new CodexRun(rpc, threadId, version, scope, launch.autoAllowRoot, launch.permissionMode, model, launch.run.effort ?? null, new Set(launch.allowedTools));
  }
}
