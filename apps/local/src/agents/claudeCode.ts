import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TLocalBackgroundItem, TLocalEffort, TLocalPermissionMode, TLocalPermissionRequestView, TLocalQuestion, TLocalUsage } from "@warmap/contracts";
import type { EventBody } from "../eventLog.js";
import { AgentStartError, type AgentAdapter, type AgentLaunch, type AgentRun, type PermissionAnswer, type TurnModels } from "./types.js";
import { buildClaudeArgs, childEnv, describeTool, homeDir, personalSettingsSetKey, versionAtLeast } from "./claudeEnv.js";
import { modeAllows, outsidePaths, permissionSummary, suggestionsReachOutside, touchedPaths, type PathScope } from "./pathGuard.js";
import { planProgress } from "../plan.js";
import { CONTEXT_COMPACTED, ContextReporter } from "./contextUsage.js";

/** 低于这个版本不保证兼容：11/05 实测基于 2.1.318；权限模式 default 改名 manual 也在 2.1.3xx。 */
export const MIN_CLAUDE_VERSION = "2.1.300";

/** 可执行文件：正式是 claude.exe 的绝对路径；测试用 node + 假脚本。 */
export interface ClaudeBin { command: string; prefixArgs: string[] }

/**
 * Claude Code 续接一段被打断、没回完的对话时自己补的助手消息（model 是 <synthetic>，2.1.3xx 程序里的原字）：
 * 不是执行方说的话，给本人看换成中文（3700 验收自由子会话 T，本机程序重启后）。
 */
const SYNTHETIC_NO_REPLY = "No response requested.";
const NO_REPLY_TEXT = "这一轮被打断了，没有回话。";
const zhNoReply = (text: string) => (text.trim() === SYNTHETIC_NO_REPLY ? NO_REPLY_TEXT : text);
const INIT_TIMEOUT_MS = 60_000;
const PREVIEW_CHARS = 600;
const INPUT_CHARS = 2_000;

type Json = Record<string, any>;

/** 工具输入可能很大（整份文件内容），事件里只留截断的版本。 */
function clipInput(input: Json): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === "string") out[k] = v.length > INPUT_CHARS ? `${v.slice(0, INPUT_CHARS)}…（共 ${v.length} 字）` : v;
    else out[k] = v;
  }
  return out;
}

function previewOf(content: unknown): string {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((c: Json) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n") : JSON.stringify(content ?? "");
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** AskUserQuestion 的问题按契约整理（字段缺了补空，超长截断）。 */
function questionsOf(input: Json): TLocalQuestion[] {
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list.slice(0, 10).map((q: Json) => ({
    question: String(q?.question ?? "").slice(0, 2000) || "（没写问题）",
    header: String(q?.header ?? "").slice(0, 100),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 10)
      .map((o: Json) => ({ label: String(o?.label ?? "").slice(0, 200), description: String(o?.description ?? "").slice(0, 1000) }))
      .filter((o: { label: string }) => o.label),
    multiSelect: Boolean(q?.multiSelect),
  }));
}

/** 算子 agent 的后台任务种类（Claude Code 的 task_type）；别的（后台命令、监视、工作流等）都算 command。 */
const AGENT_TASKS = new Set(["local_agent", "remote_agent", "in_process_teammate"]);
/** Claude Code 的任务状态 → 契约里的 state。pending、paused 算还在跑。 */
const TASK_STATE: Record<string, TLocalBackgroundItem["state"]> = {
  pending: "running", running: "running", paused: "running", completed: "done", failed: "failed", killed: "stopped", stopped: "stopped",
};
const isoOf = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString());

function usageOf(result: Json): TLocalUsage {
  const u = result.usage ?? {};
  // result.usage 是本轮的；total_cost_usd 是整个会话累计的，本轮花费看 model_usage_since_last_result（11/05 日志核对过）。
  // 网关模型的 costBasis 是 unknown：Claude Code 按 Opus 价瞎算（DeepSeek 高估约 17 倍），这一轮不算；没有 costBasis 的旧版本照旧算。
  // 这一轮没调成模型（出错、碰壁）时是 {}，算 0（不然本会话累计的标价就一直是 null 了）
  const since = result.model_usage_since_last_result as Record<string, Json> | undefined;
  const models = since ? Object.values(since) : [];
  const unpriced = models.some((m) => m.costBasis !== undefined && m.costBasis !== "list");
  const cost = since && !unpriced ? models.reduce((s, m) => s + (Number(m.costUSD) || 0), 0) : null;
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
    costUsd: cost,
  };
}

/**
 * 这一轮每个模型用了多少、发了几次请求（给本机按价目表算网关的钱）。请求次数按这一轮里不同的助手消息 id 数（主循环和子 agent 都算）：
 * TokenHub 上 result 的 usage.iterations 总是空的（11/06 真机记录）。助手消息里的模型名是上游回的（不带前缀），result 里的是配置的（可能带 wangsu/ 这种前缀）。
 */
function turnModelsOf(result: Json, ids: Map<string, Set<string>>): TurnModels | null {
  const since = result.model_usage_since_last_result as Record<string, Json> | undefined;
  if (!since) return null;
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  const keys = Object.keys(since);
  const requestsOf = (key: string): number | null => {
    const sets = keys.length === 1 ? [...ids.values()] : [...ids.entries()].filter(([m]) => m === key || key.endsWith(`/${m}`) || m.endsWith(`/${key}`)).map(([, s]) => s);
    const count = new Set(sets.flatMap((s) => [...s])).size;
    return count || null;
  };
  return {
    models: Object.entries(since).map(([model, m]) => ({
      model, inputTokens: n(m.inputTokens), outputTokens: n(m.outputTokens), cacheReadTokens: n(m.cacheReadInputTokens), cacheWriteTokens: n(m.cacheCreationInputTokens),
      costBasis: typeof m.costBasis === "string" ? m.costBasis : null, requests: requestsOf(model),
    })),
  };
}

class ClaudeRun implements AgentRun {
  private buf = "";
  private readonly eventFns: ((e: EventBody) => void)[] = [];
  private readonly draftFns: ((text: string) => void)[] = [];
  /** 正在逐字写的这段正文（null：现在写的不是正文，是思考或工具参数）；drafted：报过草稿、还没等到这段写完。 */
  private drafting: string | null = null;
  private drafted = false;
  private readonly exitFns: ((code: number | null) => void)[] = [];
  private readonly hostRequests = new Map<string, (r: Json) => void>();
  /** 带编号发出、还没读到的话（等 command_lifecycle 回执）。 */
  private readonly receipts = new Set<string>();
  /** broad：这一步越界，或「这张卡都允许」要放开的范围越界——这时不给本会话放行。 */
  private readonly permissions = new Map<string, { req: Json; broad: boolean }>();
  /** 等留一份时 CLI 撤回了的请求：留好以后不再放行、不再转给本人。 */
  private readonly cancelled = new Set<string>();
  /** 在等本人回答的提问（AskUserQuestion）。 */
  private readonly questions = new Map<string, Json>();
  /** Claude Code 报来的任务（task_started 起）。visible：算不算后台任务（前台跑完的普通命令、它内部的任务不算）。 */
  private readonly tasks = new Map<string, { item: TLocalBackgroundItem; visible: boolean }>();
  private readonly rateFns: ((info: Json) => void)[] = [];
  private markReported: () => void = () => {};
  /** 退出已经报给会话（onExit 都跑过了）。 */
  private readonly exitReported = new Promise<void>((r) => { this.markReported = r; });
  lastTurn: TurnModels | null = null;
  /** 这一轮见过的助手消息 id（按助手消息里的模型名分）：数请求次数。 */
  private turnIds = new Map<string, Set<string>>();
  private interrupting = false;
  private exited = false;
  private authFailed = false;
  private apiRetried = false;
  /** 这一轮碰到订阅额度用完了（rate_limit_event rejected、usage_limit_reached）。 */
  private limitHit = false;
  /** 这一轮网关说余额不足（billing_error）。 */
  private balanceHit = false;
  /** 上下文用了多少（设计 17.2 第 42 条）：上限是上一次 get_context_usage 读到的，这一轮中间拿它估百分比。 */
  private readonly context = new ContextReporter((e) => this.emit(e));
  private contextMax: number | null = null;
  /** 这个进程（或换了模型以后）还没读过上限：第一次模型回复后先读一次，不然第一轮中间估不出百分比。 */
  private contextAsked = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams, private readonly sessionId: string, private readonly scope: PathScope & Pick<AgentLaunch, "beforeWrite">,
    private readonly autoAllowRoot: string | null, private readonly subscription: boolean,
    /** 现在的权限模式：本机按它放行请求（pathGuard 的 modeAllows）。 */
    private mode: TLocalPermissionMode,
  ) {
    child.stdout.setEncoding("utf8").on("data", (d: string) => this.onStdout(d));
    let errBuf = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      errBuf += d;
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.emit({ type: "notice", level: "warn", code: "agent_stderr", text: line.slice(0, 500) });
    });
    child.on("exit", (code) => {
      this.exited = true;
      for (const r of this.hostRequests.values()) r({ subtype: "error", error: "process exited" });
      this.hostRequests.clear();
      // 退出时最后几行可能还没读完（额度用完时 Claude Code 报完 rate_limit_event 就退出）：读完再报退出，最多等 1 秒
      let reported = false;
      const report = () => {
        if (reported) return;
        reported = true;
        for (const fn of this.exitFns) fn(code);
        this.markReported();
      };
      if (child.stdout.readableEnded) report();
      else { setTimeout(report, 1_000).unref(); child.stdout.once("end", report); }
    });
    child.stdin.on("error", () => { /* 进程已退出时写 stdin 会 EPIPE，由 exit 处理 */ });
  }

  get pid() { return this.child.pid; }
  onEvent(fn: (e: EventBody) => void) { this.eventFns.push(fn); }
  onDraft(fn: (text: string) => void) { this.draftFns.push(fn); }
  onExit(fn: (code: number | null) => void) { this.exitFns.push(fn); }
  private emit(e: EventBody) { for (const fn of this.eventFns) fn(e); }
  private draft(text: string) { for (const fn of this.draftFns) fn(text); }

  onRateLimit(fn: (info: Json) => void) { this.rateFns.push(fn); }

  private write(obj: Json) {
    if (this.exited) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  control(request: Json, timeoutMs = 15_000): Promise<Json> {
    const request_id = `h-${randomUUID()}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.hostRequests.delete(request_id); resolve({ subtype: "error", error: "timeout" }); }, timeoutMs);
      this.hostRequests.set(request_id, (r) => { clearTimeout(t); resolve(r); });
      this.write({ type: "control_request", request_id, request });
    });
  }

  send(text: string, messageId?: string) {
    if (messageId) this.receipts.add(messageId);
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId, ...(messageId ? { uuid: messageId } : {}) });
  }

  async interrupt() {
    this.interrupting = true;
    await this.control({ subtype: "interrupt" }, 5_000);
  }

  respondPermission(requestId: string, a: PermissionAnswer): boolean {
    const entry = this.permissions.get(requestId);
    if (!entry) return false;
    this.permissions.delete(requestId);
    const { req } = entry;
    // 「这张卡都允许」只在本会话内有效：Claude Code 有的建议会写进仓库的 .claude/settings.local.json（11/06 实测 Bash），一律改成 session。
    // 越界的这一步、或建议放开的范围越界时不给：越界建议是把外面的目录加进工作目录或放行整个外面的目录。
    const session = a.allowForSession && !entry.broad && Array.isArray(req.permission_suggestions)
      ? req.permission_suggestions.map((s: Json) => ({ ...s, destination: "session" }))
      : null;
    const response = a.allow
      ? { behavior: "allow", updatedInput: req.input ?? {}, ...(session ? { updatedPermissions: session } : {}) }
      : { behavior: "deny", message: a.message?.trim() || "本人在天枢网页上拒绝了这一步" };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    // 本人批了计划：出 plan、转成「自动」接着做（Claude Code 批了 ExitPlanMode 自己也会出 plan，这里再明说一次 default）
    if (a.allow && req.tool_name === "ExitPlanMode" && this.mode === "plan") {
      this.mode = "auto";
      void this.control({ subtype: "set_permission_mode", mode: "default" }, 10_000);
      this.emit({ type: "permission_mode", mode: "auto", by: "plan_approved" });
    }
    return true;
  }

  async setPermissionMode(mode: TLocalPermissionMode): Promise<boolean> {
    if (this.exited) return false;
    if ((mode === "plan") !== (this.mode === "plan")) {
      const r = await this.control({ subtype: "set_permission_mode", mode: mode === "plan" ? "plan" : "default" }, 10_000);
      if (r.subtype !== "success") return false;
    }
    this.mode = mode;
    // 换成更宽的档：等着的请求按新档重判，新档放行的自己放行
    for (const [requestId, p] of this.permissions) {
      if (!modeAllows(mode, String(p.req.tool_name ?? ""), p.req.input ?? {}, this.scope, p.req.blocked_path, this.autoAllowRoot)) continue;
      this.permissions.delete(requestId);
      this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: p.req.input ?? {} } } });
      this.emit({ type: "permission_resolved", requestId, decision: "allow", message: "换了权限模式，按新的模式放行", allowForSession: false });
    }
    return true;
  }

  isWaiting(requestId: string): boolean {
    return this.permissions.has(requestId) || this.questions.has(requestId);
  }

  async setMultiAgent(on: boolean): Promise<boolean> {
    const r = await this.control({ subtype: "apply_flag_settings", settings: { ultracode: on } }, 10_000);
    return r.subtype === "success";
  }

  async setEffort(effort: TLocalEffort): Promise<boolean> {
    const r = await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: effort } }, 10_000);
    return r.subtype === "success";
  }

  async setModel(model: string): Promise<boolean> {
    const r = await this.control({ subtype: "set_model", model }, 10_000);
    if (r.subtype !== "success") return false;
    // 新模型的上下文上限可能不一样：等下一次模型回复后重读
    this.contextMax = null;
    this.contextAsked = false;
    return true;
  }

  /**
   * 读一次上下文用了多少（控制请求 get_context_usage，11/10 实测 2.1.318：回 totalTokens、maxTokens，约 1 秒、不调模型）：每轮做完读。
   * 老版本不认这个请求就不报。
   */
  private async refreshContext(): Promise<void> {
    if (this.exited) return;
    const r = await this.control({ subtype: "get_context_usage" }, 10_000);
    const c = r.response;
    if (r.subtype !== "success" || typeof c?.totalTokens !== "number") return;
    this.contextMax = typeof c.maxTokens === "number" && c.maxTokens > 0 ? Math.round(c.maxTokens) : null;
    this.context.report(Math.max(0, Math.round(c.totalTokens)), this.contextMax, true);
  }

  async stopTask(taskId: string): Promise<boolean> {
    const r = await this.control({ subtype: "stop_task", task_id: taskId }, 10_000);
    return r.subtype === "success";
  }

  /** 任务开始或变了：记下，算后台任务的报给会话（状态、名字、能不能停有变化才报）。 */
  private taskChanged(id: string, change: Partial<TLocalBackgroundItem>, visible?: boolean) {
    const t = this.tasks.get(id);
    if (!t) return;
    const next: TLocalBackgroundItem = { ...t.item, ...change };
    if (next.state !== "running") {
      next.stoppable = false;
      next.finishedAt ??= new Date().toISOString();
    }
    const shown = visible ?? t.visible;
    const differs = (["title", "state", "finishedAt", "stoppable"] as const).some((k) => next[k] !== t.item[k]);
    this.tasks.set(id, { item: next, visible: shown });
    if (shown && (differs || !t.visible)) this.emit({ type: "background", item: next });
    if (next.state === "running") return;
    // 子 agent 结束了（多半是被停了），它还在等的权限请求作废（agent_id 就是它的 task_id），不然会话一直等你批准
    for (const [requestId, p] of this.permissions) {
      if (p.req.agent_id !== id) continue;
      this.permissions.delete(requestId);
      this.emit({ type: "permission_resolved", requestId, decision: "deny", message: "子 agent 已结束", allowForSession: false });
    }
  }

  respondQuestion(requestId: string, answers: Record<string, string>): boolean {
    const req = this.questions.get(requestId);
    if (!req) return false;
    this.questions.delete(requestId);
    // Claude Code 的「问用户」：放行时在输入里带上 answers（问题原文 → 回答），它就当成本人的回答。
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: { ...(req.input ?? {}), answers } } } });
    return true;
  }

  close() {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => { if (!this.exited) void this.kill(); }, 10_000).unref();
  }

  kill(): Promise<void> {
    if (this.child.pid === undefined) return Promise.resolve();
    if (this.exited) return this.exitReported;
    const pid = this.child.pid;
    return new Promise((resolve) => {
      const done = () => resolve();
      void this.exitReported.then(done);
      if (process.platform === "win32") {
        // 只杀自己 spawn 出来、记下的这个 PID 及其子进程。
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => setTimeout(done, 2_000));
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch { try { this.child.kill("SIGKILL"); } catch { /* 已退出 */ } }
        setTimeout(done, 2_000);
      }
    });
  }

  private onStdout(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev: Json;
      try { ev = JSON.parse(line); } catch { continue; }
      this.handle(ev);
    }
  }

  private authFailure(text: string) {
    if (this.authFailed) return;
    this.authFailed = true;
    this.emit({ type: "notice", level: "error", code: "auth_required", text });
  }

  /** 一次权限请求：先留一份（改已有文件的拷一份，命令等这一轮开头那份，undo/），再按会话的权限模式放行或转给本人。 */
  private async permit(ev: Json, req: Json, toolName: string) {
    await this.scope.beforeWrite?.(toolName, req.input ?? {}).catch(() => undefined);
    if (this.cancelled.delete(ev.request_id) || this.exited) return;
    // 按会话的权限模式放行（规则在 pathGuard 的 modeAllows；硬规矩哪一档都问本人）
    if (modeAllows(this.mode, toolName, req.input ?? {}, this.scope, req.blocked_path, this.autoAllowRoot)) {
      this.write({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: { behavior: "allow", updatedInput: req.input ?? {} } } });
      return;
    }
    // blocked_path：Claude Code 自己从 Bash 命令里认出的越界路径（11/06 实测）。
    const outside = outsidePaths(toolName, req.input ?? {}, this.scope, req.blocked_path);
    const broad = outside.length > 0 || suggestionsReachOutside(req.permission_suggestions, this.scope);
    this.permissions.set(ev.request_id, { req, broad });
    const view: TLocalPermissionRequestView = {
      requestId: ev.request_id,
      toolName,
      title: describeTool(toolName, req.input ?? {}),
      input: clipInput(req.input ?? {}),
      outsidePaths: outside,
      canAllowForSession: !broad && Array.isArray(req.permission_suggestions) && req.permission_suggestions.length > 0,
      requestedAt: new Date().toISOString(),
      // 批准说人话（主循环第 64 条）：Bash、PowerShell 入参里执行方写的那句 description，和会动的文件
      ...permissionSummary(req.input?.description, touchedPaths(toolName, req.input ?? {}, this.scope)),
    };
    this.emit({ type: "permission_request", request: view });
  }

  private handle(ev: Json) {
    switch (ev.type) {
      case "control_response": {
        const r = ev.response ?? {};
        const fn = this.hostRequests.get(r.request_id);
        if (fn) { this.hostRequests.delete(r.request_id); fn(r); }
        return;
      }
      case "control_request": {
        if (ev.request?.subtype !== "can_use_tool") {
          this.write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: "unsupported" } });
          return;
        }
        const req = ev.request;
        const toolName = String(req.tool_name ?? "");
        if (toolName === "AskUserQuestion") {
          // 「问用户」不是权限：转成提问，等本人在网页上选（会话转成等你回复）
          this.questions.set(ev.request_id, req);
          this.emit({ type: "question", request: { requestId: ev.request_id, questions: questionsOf(req.input ?? {}), askedAt: new Date().toISOString() } });
          return;
        }
        void this.permit(ev, req, toolName);
        return;
      }
      case "control_cancel_request": {
        // CLI 自己撤回了还没答复的权限请求或提问（例如停下时）。
        if (!this.permissions.has(ev.request_id) && !this.questions.has(ev.request_id)) this.cancelled.add(ev.request_id);
        if (this.permissions.delete(ev.request_id)) {
          this.emit({ type: "permission_resolved", requestId: ev.request_id, decision: "deny", message: "已撤回", allowForSession: false });
        }
        if (this.questions.delete(ev.request_id)) this.emit({ type: "question_resolved", requestId: ev.request_id, choices: null, text: null });
        return;
      }
      case "system": {
        if (ev.subtype === "task_started" && typeof ev.task_id === "string" && !ev.ambient && !ev.skip_transcript) {
          // 后台任务：子 agent 都算；命令只算放到后台的（前台跑完的普通命令不算）；Claude Code 别的任务算 command
          const type = String(ev.task_type ?? "");
          const kind = AGENT_TASKS.has(type) ? "subagent" : "command";
          const visible = kind === "subagent" || type !== "local_bash" || ev.is_backgrounded === true;
          // 名字用 Claude Code 给的说明（模型没写说明时它自己会填上命令）；不另外取命令和子 agent 的提示词，免得把整段命令、提示词同步到云端
          const title = String(ev.description ?? "").trim().slice(0, 200) || (kind === "subagent" ? "子 agent" : "后台命令");
          const item: TLocalBackgroundItem = { id: ev.task_id.slice(0, 120), title, kind, state: "running", startedAt: new Date().toISOString(), finishedAt: null, stoppable: true };
          this.tasks.set(ev.task_id, { item, visible });
          if (visible) this.emit({ type: "background", item });
        } else if (ev.subtype === "task_updated" && typeof ev.task_id === "string") {
          const p = ev.patch ?? {};
          const state = TASK_STATE[String(p.status)];
          this.taskChanged(ev.task_id, {
            ...(state ? { state } : {}),
            ...(typeof p.description === "string" && p.description.trim() ? { title: p.description.trim().slice(0, 200) } : {}),
            ...(state && state !== "running" && p.end_time ? { finishedAt: isoOf(p.end_time) } : {}),
          }, p.is_backgrounded === true ? true : undefined);
        } else if (ev.subtype === "task_notification" && typeof ev.task_id === "string") {
          const state = TASK_STATE[String(ev.status)];
          if (state) this.taskChanged(ev.task_id, { state });
        }
        if (ev.subtype === "compact_boundary") {
          // 压缩了上下文（自动压的、本人让它压的都报）：记一行；新的用量随下一次模型回复、这一轮做完时报
          this.emit(CONTEXT_COMPACTED);
        }
        if (ev.subtype === "init") {
          this.emit({ type: "agent_info", agent: "claude-code", version: String(ev.claude_code_version ?? ""), model: ev.model ?? null, permissionMode: ev.permissionMode ?? null });
        } else if (ev.subtype === "api_retry" && ev.error === "authentication_failed") {
          // 第一次认证失败就停，不必等它重试十次。
          this.authFailure("Claude 登录已失效，请在天枢里重新登录 Claude。");
          void this.kill();
        } else if (ev.subtype === "api_retry") {
          // 模型服务出错时每次重试都马上告诉网页，不等最后失败。
          this.apiRetried = true;
          const why = typeof ev.error_status === "number" ? `模型服务出错（HTTP ${ev.error_status}）` : "连不上模型服务（超时或拒绝连接）";
          this.emit({ type: "notice", level: "warn", code: "api_retry", text: `${why}，正在重试（第 ${Number(ev.attempt) || 1}/${Number(ev.max_retries) || "?"} 次）` });
        }
        return;
      }
      case "stream_event": {
        // 逐字输出（--include-partial-messages）：只取主线正文的字报草稿；思考、工具参数、子 agent 的不报
        if (ev.parent_tool_use_id) return;
        const e = ev.event ?? {};
        if (e.type === "content_block_start") this.drafting = e.content_block?.type === "text" ? "" : null;
        else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && this.drafting !== null && typeof e.delta.text === "string") {
          this.drafting += e.delta.text;
          if (this.drafting.trim()) { this.drafted = true; this.draft(this.drafting); }
        }
        return;
      }
      case "command_lifecycle": {
        // 带 uuid 发的话，Claude Code 回 queued（收下了）、started（放进对话，下一次模型请求就带着它）、completed / cancelled（11/08 实测 2.1.318）
        const id = ev.command_uuid;
        if (typeof id !== "string" || !this.receipts.has(id)) return;
        if (ev.state === "queued") this.emit({ type: "receipt", messageId: id, state: "delivered" });
        if (ev.state === "started") { this.receipts.delete(id); this.emit({ type: "receipt", messageId: id, state: "read" }); }
        return;
      }
      case "rate_limit_event": {
        // 额度变化（只在百分比、重置时间、状态变了时来）：给本机记额度；rejected 就是用完了（用完的这一串没真机复现过，照社区复现和 Claude Code 程序里的字符串）
        const info = ev.rate_limit_info;
        if (!info || typeof info !== "object") return;
        if (info.status === "rejected" && this.subscription) this.limitHit = true;
        for (const fn of this.rateFns) fn(info);
        return;
      }
      case "assistant": {
        // 订阅额度用完时 Claude Code 自己补一条助手消息：error rate_limit、api_error usage_limit_reached（文字会变，不看文字）。
        // 只有 error rate_limit 的是别的 429（限流），照旧算模型服务的错，不当成额度用完
        if (this.subscription && ev.api_error === "usage_limit_reached") this.limitHit = true;
        // 网关余额不足（TokenHub 回 402，Claude Code 记成 billing_error）：停着等本人，不重试
        if (!this.subscription && (ev.error === "billing_error" || ev.api_error === "billing_error")) this.balanceHit = true;
        const msgId = ev.message?.id;
        if (typeof msgId === "string" && !ev.error) {
          const model = String(ev.message?.model ?? "");
          if (!this.turnIds.has(model)) this.turnIds.set(model, new Set());
          this.turnIds.get(model)!.add(msgId);
        }
        if (ev.error === "authentication_failed") this.authFailure("Claude 还没登录或登录已失效，请在天枢里登录 Claude。");
        else if (!ev.error) this.apiRetried = false; // 重试后模型又答上来了：这一轮之后再出错不算模型服务的错
        if (ev.parent_tool_use_id) return; // 子代理内部的步骤不逐条上屏
        // 这一次模型回复后上下文大约用了多少：这次请求的输入（含缓存）加输出
        const used = ev.message?.usage;
        if (!this.contextAsked && !ev.error) {
          this.contextAsked = true;
          void this.refreshContext();
        }
        if (used && !ev.error) {
          const n = (v: unknown) => Math.max(0, Number(v) || 0);
          this.context.report(n(used.input_tokens) + n(used.cache_read_input_tokens) + n(used.cache_creation_input_tokens) + n(used.output_tokens), this.contextMax);
        }
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) { this.drafted = false; this.emit({ type: "assistant_text", text: zhNoReply(c.text) }); }
          if (c.type === "tool_use") {
            this.emit({ type: "tool_call", toolUseId: c.id, name: c.name, title: describeTool(c.name, c.input ?? {}), input: clipInput(c.input ?? {}) });
            if (c.name === "TodoWrite" && Array.isArray(c.input?.todos)) {
              const entries = c.input.todos
                .filter((t: Json) => typeof t?.content === "string")
                .map((t: Json) => ({ content: t.content, status: ["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending" }));
              this.emit({ type: "plan", entries, progress: planProgress(entries) });
            }
          }
        }
        return;
      }
      case "user": {
        if (ev.parent_tool_use_id) return;
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type !== "tool_result") continue;
          this.emit({ type: "tool_result", toolUseId: c.tool_use_id, isError: Boolean(c.is_error), preview: previewOf(c.content) });
          if (ev.tool_use_result && typeof ev.tool_use_result === "object" && ev.tool_use_result.searchCount === 0) {
            this.emit({ type: "notice", level: "warn", code: "search_not_effective", text: "这次联网搜索没有真的搜到东西（当前模型可能不支持搜索），结果不可靠。" });
          }
        }
        return;
      }
      case "result": {
        const interrupted = this.interrupting && ev.subtype === "error_during_execution";
        const apiRetried = this.apiRetried;
        const limited = this.limitHit;
        // 余额不足：TokenHub 回 402，正文是 Insufficient wallet balance（tokavi-tokenhub f31dd05 的 exception_handler）
        const balance = !this.subscription && (this.balanceHit || ev.api_error_status === 402 || /insufficient wallet balance/i.test(String(ev.result ?? "")));
        this.interrupting = false;
        this.apiRetried = false;
        this.limitHit = false;
        this.balanceHit = false;
        // 这一轮完了还有没写完的那段（停下、出错）：草稿清掉
        this.drafting = null;
        if (this.drafted) { this.drafted = false; this.draft(""); }
        this.lastTurn = turnModelsOf(ev, this.turnIds);
        this.turnIds = new Map();
        const isError = Boolean(ev.is_error) || ev.subtype !== "success";
        const auth = this.authFailed || ev.api_error_status === 401;
        if (auth && !this.authFailed) this.authFailure("Claude 登录已失效，请在天枢里重新登录 Claude。");
        this.emit({
          type: "turn_end",
          isError,
          text: typeof ev.result === "string" ? zhNoReply(ev.result) : null,
          durationMs: Math.max(0, Math.round(Number(ev.duration_ms) || 0)),
          usage: usageOf(ev),
          // 拒连、超时没有 HTTP 状态码，但这一轮重试过就算模型服务的错。
          ...(isError ? { errorKind: interrupted ? "interrupted" : auth ? "auth" : limited ? "usage_limit" : balance ? "balance" : ev.api_error_status || apiRetried ? "api" : "other" } : {}),
        } as EventBody);
        void this.refreshContext();
        return;
      }
      default:
        return;
    }
  }
}

/**
 * 起一个不发提示的 Claude Code（不存会话、不读本人的全局设置），握手（initialize）过了交给 fn，做完就关。不花 token。握手没过抛错。
 */
async function probe<T>(bin: ClaudeBin, cwd: string, baseEnv: NodeJS.ProcessEnv, timeoutMs: number, fn: (init: Json, control: (id: string, request: Json) => Promise<Json>) => Promise<T>): Promise<T> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--strict-mcp-config", "--no-session-persistence"];
  const child = spawn(bin.command, [...bin.prefixArgs, ...args], { cwd, env: childEnv(baseEnv, { DISABLE_AUTOUPDATER: "1" }), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const waiters = new Map<string, (r: Json) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let ev: Json;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "control_response") waiters.get(ev.response?.request_id)?.(ev.response);
    }
  });
  child.stderr.resume();
  const gone = new Promise<Json>((resolve) => { child.once("error", (e) => resolve({ subtype: "error", error: e.message })); child.once("exit", () => resolve({ subtype: "error", error: "Claude Code 退出了" })); });
  const control = (id: string, request: Json) => Promise.race([
    new Promise<Json>((resolve) => { waiters.set(id, resolve); child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`); }),
    gone,
    new Promise<Json>((resolve) => setTimeout(() => resolve({ subtype: "error", error: "读额度超时" }), timeoutMs).unref()),
  ]);
  try {
    const init = await control("u1", { subtype: "initialize" });
    if (init.subtype !== "success") throw new Error(String(init.error ?? "Claude Code 没有响应握手"));
    return await fn(init, control);
  } finally {
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 5_000).unref();
  }
}

/**
 * 读本人订阅的额度：握手后发 get_usage。11/07 实测不花 token、约 0.7 秒回。get_usage 是 Claude Code 自己标的实验接口，形状可能变。读不到抛错。
 */
export function readUsage(bin: ClaudeBin, cwd: string, baseEnv: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<Json> {
  return probe(bin, cwd, baseEnv, timeoutMs, async (_init, control) => {
    const usage = await control("u2", { subtype: "get_usage", skip_behaviors: true });
    if (usage.subtype !== "success" || !usage.response) throw new Error(String(usage.error ?? "没读到额度"));
    return usage.response as Json;
  });
}

/**
 * 读本人 Claude 订阅能用的模型（设计 17.2 第 40 条）：握手的回执里就有（models，11/10 实测 2.1.318 回 14 个，每个带显示名和支持的思考档）。
 * 老版本没有这一项时回空的。
 */
export function readModels(bin: ClaudeBin, cwd: string, baseEnv: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000): Promise<unknown[]> {
  return probe(bin, cwd, baseEnv, timeoutMs, async (init) => (Array.isArray(init.response?.models) ? init.response.models as unknown[] : []));
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;

  constructor(private readonly resolveBin: () => Promise<ClaudeBin | null>, private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

  async start(launch: AgentLaunch): Promise<AgentRun> {
    const bin = await this.resolveBin();
    if (!bin) throw new AgentStartError("agent_not_installed", "这台电脑上没找到 Claude Code");
    if (launch.includePersonalConfig && launch.model.source === "gateway" && personalSettingsSetKey(this.baseEnv)) {
      throw new AgentStartError("validation", "本人的 Claude Code 全局设置里自己设了模型钥匙，会盖过这张卡选的网关模型。请关掉「带上个人配置」，或改用订阅模型。");
    }
    const { args, env } = buildClaudeArgs(launch);
    const child = spawn(bin.command, [...bin.prefixArgs, ...args], {
      cwd: launch.cwd,
      env: childEnv(this.baseEnv, env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      // Mac/Linux 上自成进程组，强停时整组杀掉。
      detached: process.platform !== "win32",
    });
    const run = new ClaudeRun(child, launch.sessionId, { cwd: launch.cwd, home: homeDir(), allowedRoots: launch.allowedRoots, readRoots: launch.readRoots, toolReads: launch.toolReads, extraDirs: launch.extraDirs, covered: launch.covered, beforeWrite: launch.beforeWrite }, launch.autoAllowRoot, launch.model.source === "subscription", launch.permissionMode);
    const spawned = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (e) => resolve(e));
    });
    if (spawned) throw new AgentStartError("agent_not_installed", `Claude Code 启动失败：${spawned.message}`);
    const init = await run.control({ subtype: "initialize" }, INIT_TIMEOUT_MS);
    const version = String(init.response?.claude_code_version ?? "");
    if (init.subtype !== "success" || !version) {
      await run.kill();
      throw new AgentStartError("agent_incompatible", "Claude Code 没有响应握手，可能版本太旧");
    }
    if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) {
      await run.kill();
      throw new AgentStartError("agent_incompatible", `Claude Code ${version} 太旧，请升级到 ${MIN_CLAUDE_VERSION} 以上`);
    }
    return run;
  }
}
