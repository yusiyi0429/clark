import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TLocalAgentStatus, TLocalAgentSetupPhase } from "@warmap/contracts";
import { childEnv, versionAtLeast } from "./claudeEnv.js";
import { MIN_CLAUDE_VERSION, type ClaudeBin } from "./claudeCode.js";

/**
 * Claude Code 的检测、安装、登录（11/06 实验结论，见 RFC 附录 C）：
 * - 不靠 PATH（开机自启的托盘程序拿不到 shell 的 PATH），按默认安装位置找；
 * - 登录状态用 `claude auth status --json`：纯本机读，不耗模型、不写文件；
 * - 安装跑官方脚本（不要管理员）；登录跑 `claude auth login`：本机回环回调，浏览器里点授权即可，
 *   自动跳回失败时浏览器会显示一串代码，网页贴回来写进它的 stdin。
 */
function candidates(configured: string | null): string[] {
  const home = homedir();
  const list = configured ? [configured] : [];
  if (process.platform === "win32") {
    list.push(join(home, ".local", "bin", "claude.exe"));
    if (process.env.LOCALAPPDATA) list.push(join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.exe"));
  } else {
    list.push(join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  }
  return list;
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env: childEnv(process.env) }, (err, stdout) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, out: String(stdout ?? "") });
    });
  });
}

interface Setup { phase: TLocalAgentSetupPhase; startedAt: string | null; loginUrl: string | null; error: string | null; child: ChildProcess | null }

export class ClaudeSetup {
  private found: { path: string; version: string } | null = null;
  private cached: { at: number; status: TLocalAgentStatus } | null = null;
  private setup: Setup = { phase: "idle", startedAt: null, loginUrl: null, error: null, child: null };

  /** run：跑 --version、auth status 用的（测试换成假的）。 */
  constructor(private readonly configuredPath: string | null, private readonly run: typeof exec = exec) {}

  /** 给适配器用：找到的 claude 可执行文件。 */
  async bin(): Promise<ClaudeBin | null> {
    const f = await this.locate();
    return f ? { command: f.path, prefixArgs: [] } : null;
  }

  private async locate(): Promise<{ path: string; version: string } | null> {
    if (this.found && existsSync(this.found.path)) return this.found;
    for (const p of candidates(this.configuredPath)) {
      if (!existsSync(p)) continue;
      const r = await this.run(p, ["--version"], 10_000);
      const m = /^(\d+\.\d+\.\d+)/.exec(r.out.trim());
      if (r.code === 0 && m) return (this.found = { path: p, version: m[1]! });
    }
    return null;
  }

  async status(force = false): Promise<TLocalAgentStatus> {
    if (!force && this.cached && Date.now() - this.cached.at < 3_000) return { ...this.cached.status, setup: this.setupView() };
    this.found = null;
    const f = await this.locate();
    let auth: Record<string, any> = {};
    if (f) {
      const r = await this.run(f.path, ["auth", "status", "--json"], 15_000);
      try { auth = JSON.parse(r.out); } catch { auth = {}; }
    }
    const status: TLocalAgentStatus = {
      kind: "claude-code",
      installed: Boolean(f),
      version: f?.version ?? null,
      path: f?.path ?? null,
      loggedIn: auth.loggedIn === true,
      authMethod: typeof auth.authMethod === "string" ? auth.authMethod : null,
      subscriptionType: typeof auth.subscriptionType === "string" ? auth.subscriptionType : null,
      ...(typeof auth.planTier === "string" ? { planTier: auth.planTier } : {}),
      loginExpiresAt: typeof auth.loginExpiresAt === "string" ? auth.loginExpiresAt : null,
      minimumVersion: MIN_CLAUDE_VERSION,
      compatible: f ? versionAtLeast(f.version, MIN_CLAUDE_VERSION) : false,
      setup: this.setupView(),
    };
    this.cached = { at: Date.now(), status };
    return status;
  }

  private setupView(): TLocalAgentStatus["setup"] {
    const { phase, startedAt, loginUrl, error } = this.setup;
    return { phase, startedAt, loginUrl, error };
  }

  private begin(phase: TLocalAgentSetupPhase, child: ChildProcess): void {
    this.setup = { phase, startedAt: new Date().toISOString(), loginUrl: null, error: null, child };
    this.cached = null;
  }

  private busy(): boolean {
    return this.setup.phase === "installing" || this.setup.phase === "waiting_browser";
  }

  /** 后台跑官方安装脚本，不弹窗。成功以默认位置能跑 --version 为准。 */
  install(): boolean {
    if (this.busy()) return false;
    const child = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"], { windowsHide: true, env: childEnv(process.env), stdio: "ignore" })
      : spawn("/bin/bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], { env: childEnv(process.env), stdio: "ignore" });
    this.begin("installing", child);
    child.on("exit", async () => {
      this.found = null;
      const ok = Boolean(await this.locate());
      this.setup = { ...this.setup, phase: ok ? "succeeded" : "failed", error: ok ? null : "安装没完成：可能连不上 downloads.claude.ai", child: null };
      this.cached = null;
    });
    child.on("error", (e) => { this.setup = { ...this.setup, phase: "failed", error: e.message, child: null }; });
    return true;
  }

  /** 拉起 `claude auth login`：它自己打开默认浏览器；同时从输出里抓兜底地址给网页。 */
  async login(): Promise<boolean> {
    if (this.busy()) return false;
    const f = await this.locate();
    if (!f) return false;
    const child = spawn(f.path, ["auth", "login"], { windowsHide: true, env: childEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    this.begin("waiting_browser", child);
    const onOut = (d: string) => {
      const m = /visit:\s*(https:\/\/\S+)/.exec(d);
      if (m) this.setup.loginUrl = m[1]!;
    };
    child.stdout?.setEncoding("utf8").on("data", onOut);
    child.stderr?.setEncoding("utf8").on("data", onOut);
    child.stdin?.on("error", () => {});
    const timer = setTimeout(() => this.cancel("登录超时，没有在 10 分钟内完成授权"), 10 * 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (this.setup.child !== child) return;
      this.setup = { ...this.setup, phase: code === 0 ? "succeeded" : "failed", error: code === 0 ? null : (this.setup.error ?? "登录没有完成"), child: null };
      this.cached = null;
    });
    return true;
  }

  /** 浏览器显示了代码而没有跳回时，本人把代码贴进网页，转交给 claude。 */
  submitCode(code: string): boolean {
    const c = this.setup.child;
    if (this.setup.phase !== "waiting_browser" || !c?.stdin) return false;
    c.stdin.write(code.trim() + "\n");
    return true;
  }

  cancel(reason = "已取消"): void {
    const c = this.setup.child;
    if (c?.pid) {
      if (process.platform === "win32") execFile("taskkill", ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else c.kill("SIGKILL");
    }
    this.setup = { ...this.setup, phase: "failed", error: reason, child: null };
  }
}
