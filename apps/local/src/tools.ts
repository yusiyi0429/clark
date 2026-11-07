import { execFile } from "node:child_process";
import type { TLocalToolStatus } from "@warmap/contracts";
import { nowIso } from "./store.js";

/** 跑一条命令：没装（找不到）为 null；装了就回退出码和输出（不管成没成）。 */
export type ToolExec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string } | null>;

/** 默认的执行：Windows 上 lark-cli 是 npm 装的 .cmd，要经 shell 才起得来（参数都是本机写死的，不带外面来的字）。 */
export const defaultExec: ToolExec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 20_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as { code?: unknown } | null;
    // 没装：直接起时是 ENOENT；经 Windows 的 shell 起时是 cmd 报「不是内部或外部命令」、什么都没输出
    const notFound = e?.code === "ENOENT" || (Boolean(e) && !String(stdout).trim() && /not recognized|not found|不是内部或外部命令/i.test(String(stderr)));
    resolve(notFound ? null : { code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

const versionOf = (out: string) => /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
const json = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };

/** gh：gh auth status --json hosts（2.88 起有）里 github.com 当前账号；state 是 success 才算登着。 */
async function gh(exec: ToolExec): Promise<Omit<TLocalToolStatus, "checkedAt">> {
  const v = await exec("gh", ["--version"]);
  if (!v) return { kind: "gh", state: "not_installed", version: null, account: null };
  const version = versionOf(v.stdout);
  const st = await exec("gh", ["auth", "status", "--json", "hosts"]);
  const accounts: any[] = json(st?.stdout ?? "")?.hosts?.["github.com"] ?? [];
  const active = accounts.find((a) => a?.active) ?? accounts[0];
  if (!active) return { kind: "gh", state: "not_logged_in", version, account: null };
  const account = typeof active.login === "string" ? active.login.slice(0, 100) : null;
  return { kind: "gh", state: active.state === "success" ? "ready" : "expired", version, account };
}

/** 飞书命令行：lark-cli auth status 的用户身份（11/07 实测 1.0.93，默认输出 JSON）；刷新令牌过期了算过期。只有机器人身份不算登着。 */
async function larkCli(exec: ToolExec, now: number): Promise<Omit<TLocalToolStatus, "checkedAt">> {
  const v = await exec("lark-cli", ["--version"]);
  if (!v) return { kind: "lark-cli", state: "not_installed", version: null, account: null };
  const version = versionOf(v.stdout);
  const user = json((await exec("lark-cli", ["auth", "status"]))?.stdout ?? "")?.identities?.user;
  if (!user || user.available === false) return { kind: "lark-cli", state: "not_logged_in", version, account: null };
  const account = typeof user.userName === "string" ? user.userName.slice(0, 100) : null;
  const refreshEnds = Date.parse(user.refreshExpiresAt ?? "");
  const expired = user.status === "expired" || (!Number.isNaN(refreshEnds) && refreshEnds <= now);
  return { kind: "lark-cli", state: expired ? "expired" : "ready", version, account };
}

/** Codex：codex login status（11/07 实测 0.159.2：登着时退出码 0、写「Logged in using ChatGPT」，没登录时非 0）。 */
async function codex(exec: ToolExec): Promise<Omit<TLocalToolStatus, "checkedAt">> {
  const v = await exec("codex", ["--version"]);
  if (!v) return { kind: "codex", state: "not_installed", version: null, account: null };
  const st = await exec("codex", ["login", "status"]);
  return { kind: "codex", state: st?.code === 0 && /logged in/i.test(st.stdout + st.stderr) ? "ready" : "not_logged_in", version: versionOf(v.stdout), account: null };
}

/** Claude Code 那一行（照它自己报的登录，状态接口每次现查）：登录到期了算过期。 */
export function claudeTool(a: { installed: boolean; loggedIn: boolean; version: string | null; loginExpiresAt: string | null }, now = Date.now()): TLocalToolStatus {
  const expired = a.loggedIn && a.loginExpiresAt !== null && Date.parse(a.loginExpiresAt) <= now;
  const state = !a.installed ? "not_installed" : !a.loggedIn ? "not_logged_in" : expired ? "expired" : "ready";
  return { kind: "claude-code", state, version: a.version, account: null, checkedAt: new Date(now).toISOString() };
}

/** worker 能用的命令行工具登没登录（连接页「这台电脑」）：本机程序启动时和每 10 分钟查一次，状态接口读缓存。 */
export class CliTools {
  private list: TLocalToolStatus[] = (["codex", "gh", "lark-cli"] as const).map((kind) => ({ kind, state: "unknown", version: null, account: null, checkedAt: null }));
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(private readonly exec: ToolExec = defaultExec, private readonly now = () => Date.now()) {}

  view(): TLocalToolStatus[] { return this.list; }

  refresh(): Promise<void> {
    this.checking ??= Promise.all([codex(this.exec), gh(this.exec), larkCli(this.exec, this.now())])
      .then((found) => { const at = nowIso(); this.list = found.map((t) => ({ ...t, checkedAt: at })); })
      .catch(() => undefined)
      .finally(() => { this.checking = null; });
    return this.checking;
  }

  start(): void {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), 10 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
