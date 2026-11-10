import type { TLocalAgentSetupPhase, TLocalAgentStatus, TLocalToolStatus } from "@warmap/contracts";
import { versionAtLeast } from "./claudeEnv.js";
import { MIN_CODEX_VERSION } from "./codex.js";
import { codexEnv, openCodex, withCodex, type CodexBin, type CodexRpc } from "./codexRpc.js";

type Json = Record<string, any>;

interface Setup { phase: TLocalAgentSetupPhase; startedAt: string | null; loginUrl: string | null; error: string | null; rpc: CodexRpc | null; loginId: string | null }

const STATUS_TTL_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * 本人的 Codex（设计 17.2 第 38 条）：装没装、登没登录、登录（经 app-server 的 account/login/start 拿 ChatGPT 登录地址，替本人打开浏览器）、
 * 读额度和模型目录。都用同一个配置目录（home；null 是本人的 ~/.codex），起 app-server 只握手和读，不开对话、不花 token。
 */
export class CodexSetup {
  private cached: { at: number; status: Omit<TLocalAgentStatus, "setup"> } | null = null;
  private checking: Promise<Omit<TLocalAgentStatus, "setup">> | null = null;
  private setup: Setup = { phase: "idle", startedAt: null, loginUrl: null, error: null, rpc: null, loginId: null };
  /** 登录成功了（读模型目录、额度）。 */
  onLogin: () => void = () => {};

  constructor(
    readonly bin: () => Promise<CodexBin | null>, private readonly home: string | null,
    private readonly openUrl: (url: string) => void, private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  private env() { return codexEnv(this.baseEnv, this.home); }

  /** 连接页、状态接口用：30 秒内读过就用缓存（每次都起一个 app-server 太重）。 */
  async status(force = false): Promise<TLocalAgentStatus> {
    if (!force && this.cached && Date.now() - this.cached.at < STATUS_TTL_MS) return { ...this.cached.status, setup: this.setupView() };
    this.checking ??= this.check().finally(() => { this.checking = null; });
    const status = await this.checking;
    this.cached = { at: Date.now(), status };
    return { ...status, setup: this.setupView() };
  }

  private async check(): Promise<Omit<TLocalAgentStatus, "setup">> {
    const base = { kind: "codex" as const, installed: false, version: null, path: null, loggedIn: false, authMethod: null, subscriptionType: null, loginExpiresAt: null, minimumVersion: MIN_CODEX_VERSION, compatible: false };
    const bin = await this.bin();
    if (!bin) return base;
    try {
      const { rpc, version } = await openCodex(bin, this.env());
      try {
        const r = await rpc.request<Json>("account/read", { refreshToken: false }, 15_000);
        const a = r.account ?? null;
        return {
          ...base, installed: true, version: version || null, path: bin.prefixArgs[0] ?? bin.command,
          loggedIn: Boolean(a), authMethod: a?.type ?? null, subscriptionType: typeof a?.planType === "string" ? a.planType : null,
          compatible: Boolean(version) && versionAtLeast(version, MIN_CODEX_VERSION),
        };
      } finally { rpc.close(); }
    } catch {
      return { ...base, installed: true, path: bin.prefixArgs[0] ?? bin.command };
    }
  }

  private setupView(): TLocalAgentStatus["setup"] {
    const { phase, startedAt, loginUrl, error } = this.setup;
    return { phase, startedAt, loginUrl, error };
  }

  private busy() { return this.setup.phase === "waiting_browser"; }

  /** 登录：起一个 app-server 等回调（Codex 自己在本机 1455 端口收），替本人打开浏览器；10 分钟没点完算超时。 */
  async login(): Promise<boolean> {
    if (this.busy()) return false;
    const bin = await this.bin();
    if (!bin) return false;
    const { rpc } = await openCodex(bin, this.env());
    this.setup = { phase: "waiting_browser", startedAt: new Date().toISOString(), loginUrl: null, error: null, rpc, loginId: null };
    const timer = setTimeout(() => this.cancel("登录超时，没有在 10 分钟内完成授权"), LOGIN_TIMEOUT_MS);
    timer.unref?.();
    const end = (ok: boolean, error: string | null) => {
      clearTimeout(timer);
      if (this.setup.rpc !== rpc) return;
      this.setup = { ...this.setup, phase: ok ? "succeeded" : "failed", error, rpc: null };
      this.cached = null;
      rpc.close();
      if (ok) this.onLogin();
    };
    rpc.onNotification((method, p) => {
      if (method === "account/login/completed" && (!this.setup.loginId || p.loginId === this.setup.loginId)) end(Boolean(p.success), p.success ? null : String(p.error ?? "登录没有完成").slice(0, 300));
    });
    rpc.child.on("exit", () => { if (this.setup.rpc === rpc) end(false, "登录没有完成"); });
    try {
      const r = await rpc.request<Json>("account/login/start", { type: "chatgpt" });
      if (typeof r.authUrl !== "string") throw new Error("Codex 没给登录地址");
      this.setup.loginId = typeof r.loginId === "string" ? r.loginId : null;
      this.setup.loginUrl = r.authUrl;
      this.openUrl(r.authUrl);
    } catch (e) {
      end(false, (e instanceof Error ? e.message : String(e)).slice(0, 300));
    }
    return true;
  }

  cancel(reason = "已取消"): void {
    const { rpc, loginId } = this.setup;
    this.setup = { ...this.setup, phase: "failed", error: reason, rpc: null };
    if (!rpc) return;
    if (loginId) void rpc.request("account/login/cancel", { loginId }, 5_000).catch(() => {});
    setTimeout(() => { rpc.close(); try { rpc.child.kill(); } catch { /* 已退出 */ } }, 1_000).unref();
  }

  /** 额度（account/rateLimits/read）：没装回 null。 */
  async readLimits(): Promise<Json | null> {
    const bin = await this.bin();
    if (!bin) return null;
    return withCodex(bin, this.env(), (rpc) => rpc.request<Json>("account/rateLimits/read", { excludeResetCreditDetails: true }));
  }

  /** 模型目录（model/list）：没装、没登录回 null。 */
  async readModels(): Promise<Json | null> {
    const bin = await this.bin();
    if (!bin) return null;
    return withCodex(bin, this.env(), async (rpc) => {
      const a = await rpc.request<Json>("account/read", { refreshToken: false }, 15_000);
      if (!a.account) return null;
      return rpc.request<Json>("model/list", { includeHidden: false });
    });
  }
}

/** 连接页「这台电脑」里 Codex 那一行（照它的登录状态）。 */
export function codexTool(a: TLocalAgentStatus, now = Date.now()): TLocalToolStatus {
  return { kind: "codex", state: !a.installed ? "not_installed" : a.loggedIn ? "ready" : "not_logged_in", version: a.version, account: null, checkedAt: new Date(now).toISOString() };
}
