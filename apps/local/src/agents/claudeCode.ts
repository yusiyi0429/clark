import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TLocalPermissionRequestView, TLocalUsage } from "@warmap/contracts";
import type { EventBody } from "../eventLog.js";
import { AgentStartError, type AgentAdapter, type AgentLaunch, type AgentRun, type PermissionAnswer } from "./types.js";
import { buildClaudeArgs, childEnv, describeTool, homeDir, personalSettingsSetKey, versionAtLeast } from "./claudeEnv.js";
import { outsidePaths, suggestionsReachOutside, type PathScope } from "./pathGuard.js";
import { planProgress } from "../plan.js";

/** 低于这个版本不保证兼容：11/05 实测基于 2.1.318；权限模式 default 改名 manual 也在 2.1.3xx。 */
export const MIN_CLAUDE_VERSION = "2.1.300";

/** 可执行文件：正式是 claude.exe 的绝对路径；测试用 node + 假脚本。 */
export interface ClaudeBin { command: string; prefixArgs: string[] }

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

function usageOf(result: Json): TLocalUsage {
  const u = result.usage ?? {};
  // result.usage 是本轮的；total_cost_usd 是整个会话累计的，本轮花费看 model_usage_since_last_result（11/05 日志核对过）。
  const since = result.model_usage_since_last_result as Record<string, Json> | undefined;
  const cost = since ? Object.values(since).reduce((s, m) => s + (Number(m.costUSD) || 0), 0) : null;
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
    costUsd: cost,
  };
}

class ClaudeRun implements AgentRun {
  private buf = "";
  private readonly eventFns: ((e: EventBody) => void)[] = [];
  private readonly exitFns: ((code: number | null) => void)[] = [];
  private readonly hostRequests = new Map<string, (r: Json) => void>();
  /** broad：这一步越界，或「这张卡都允许」要放开的范围越界——这时不给本会话放行。 */
  private readonly permissions = new Map<string, { req: Json; broad: boolean }>();
  private interrupting = false;
  private exited = false;
  private authFailed = false;
  private apiRetried = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly sessionId: string, private readonly scope: PathScope) {
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
      for (const fn of this.exitFns) fn(code);
    });
    child.stdin.on("error", () => { /* 进程已退出时写 stdin 会 EPIPE，由 exit 处理 */ });
  }

  get pid() { return this.child.pid; }
  onEvent(fn: (e: EventBody) => void) { this.eventFns.push(fn); }
  onExit(fn: (code: number | null) => void) { this.exitFns.push(fn); }
  private emit(e: EventBody) { for (const fn of this.eventFns) fn(e); }

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

  send(text: string) {
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId });
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
    return true;
  }

  close() {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => { if (!this.exited) void this.kill(); }, 10_000).unref();
  }

  kill(): Promise<void> {
    if (this.exited || this.child.pid === undefined) return Promise.resolve();
    const pid = this.child.pid;
    return new Promise((resolve) => {
      const done = () => resolve();
      this.child.once("exit", done);
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
        };
        this.emit({ type: "permission_request", request: view });
        return;
      }
      case "control_cancel_request": {
        // CLI 自己撤回了还没答复的权限请求（例如停下时）。
        if (this.permissions.delete(ev.request_id)) {
          this.emit({ type: "permission_resolved", requestId: ev.request_id, decision: "deny", message: "已撤回", allowForSession: false });
        }
        return;
      }
      case "system": {
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
      case "assistant": {
        if (ev.error === "authentication_failed") this.authFailure("Claude 还没登录或登录已失效，请在天枢里登录 Claude。");
        else if (!ev.error) this.apiRetried = false; // 重试后模型又答上来了：这一轮之后再出错不算模型服务的错
        if (ev.parent_tool_use_id) return; // 子代理内部的步骤不逐条上屏
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) this.emit({ type: "assistant_text", text: c.text });
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
        this.interrupting = false;
        this.apiRetried = false;
        const isError = Boolean(ev.is_error) || ev.subtype !== "success";
        const auth = this.authFailed || ev.api_error_status === 401;
        if (auth && !this.authFailed) this.authFailure("Claude 登录已失效，请在天枢里重新登录 Claude。");
        this.emit({
          type: "turn_end",
          isError,
          text: typeof ev.result === "string" ? ev.result : null,
          durationMs: Math.max(0, Math.round(Number(ev.duration_ms) || 0)),
          usage: usageOf(ev),
          // 拒连、超时没有 HTTP 状态码，但这一轮重试过就算模型服务的错。
          ...(isError ? { errorKind: interrupted ? "interrupted" : auth ? "auth" : ev.api_error_status || apiRetried ? "api" : "other" } : {}),
        } as EventBody);
        return;
      }
      default:
        return;
    }
  }
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
    const run = new ClaudeRun(child, launch.sessionId, { cwd: launch.cwd, home: homeDir(), allowedRoots: launch.allowedRoots });
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
