import { spawn } from "node:child_process";
import type { TLocalQuotaSource, TLocalQuotaSync, TLocalQuotaWindow } from "@warmap/contracts";
import { QUOTA_TTL_MS } from "./quota.js";

type Json = Record<string, any>;

/** 按窗口长度认（新首页设计 11.1：不按 primary、secondary 的顺序）：5 小时是 session，7 天是 weekly_all，别的不认。 */
const BY_MINUTES: Record<number, TLocalQuotaWindow["kind"]> = { 300: "session", 10_080: "weekly_all" };

const iso = (sec: unknown) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);

/**
 * codex app-server 的 account/rateLimits/read 回执（11/07 实测 codex-cli 0.159.2：Plus 计划 primary 300 分钟、secondary 10080 分钟）→ 额度。
 * 到 100%（或 ordinaryUsageAllowed 为 false 时用得最多的那个窗口）算用完；Codex 不报警戒线，没有 warning。账号 id 不取。
 */
export function codexQuotaFrom(res: Json): Pick<TLocalQuotaSource, "plan" | "windows" | "extraUsage" | "blockedUntil"> {
  const snap = res.rateLimitsByLimitId?.codex ?? res.rateLimits ?? {};
  const windows: TLocalQuotaWindow[] = [];
  for (const w of [snap.primary, snap.secondary]) {
    const kind = w && BY_MINUTES[Number(w.windowDurationMins)];
    if (!kind || windows.some((x) => x.kind === kind)) continue;
    const usedPercent = Math.min(100, Math.max(0, Math.round(Number(w.usedPercent) || 0)));
    windows.push({ kind, model: null, usedPercent, state: usedPercent >= 100 ? "blocked" : "ok", resetsAt: iso(w.resetsAt) });
  }
  if (res.ordinaryUsageAllowed === false && windows.length && !windows.some((w) => w.state === "blocked")) {
    const top = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    top.state = "blocked";
  }
  const blocked = windows.filter((w) => w.state === "blocked" && w.resetsAt).map((w) => w.resetsAt!).sort();
  return { plan: typeof snap.planType === "string" ? snap.planType.slice(0, 40) : null, windows, extraUsage: null, blockedUntil: blocked.at(-1) ?? null };
}

/**
 * 起一个 codex app-server，握手后读一次额度就关（不开对话、不花 token）。没装回 null；读不到抛错。
 * Windows 上 codex 是 npm 装的 .cmd，要经 shell 才起得来（参数是本机写死的，不带外面来的字）。
 */
export function readCodexLimits(timeoutMs = 30_000): Promise<Json | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    let buf = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 1_000).unref();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("读 Codex 额度超时"))), timeoutMs);
    timer.unref();
    const send = (o: Json) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: Json;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(() => reject(new Error(String(m.error.message ?? "Codex 没有响应握手"))));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (m.id === 2) {
          finish(() => (m.error ? reject(new Error(String(m.error.message ?? "没读到 Codex 额度"))) : resolve(m.result as Json)));
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { err = (err + d).slice(-500); });
    child.stdin.on("error", () => { /* 进程已退出 */ });
    child.once("error", (e: NodeJS.ErrnoException) => finish(() => (e.code === "ENOENT" ? resolve(null) : reject(e))));
    child.once("exit", (code) => finish(() => {
      // 经 Windows 的 shell 起、没装时：cmd 报「不是内部或外部命令」后退出
      if (/not recognized|not found|不是内部或外部命令/i.test(err)) resolve(null);
      else reject(new Error(`Codex 退出了（${code}）`));
    }));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "tianshu-local", title: "天枢本机程序", version: "1" }, capabilities: null } });
  });
}

/** 本人 Codex 订阅的额度（新首页设计 11.1、11.5「Codex 那枚」）：只显示、同步，不挡卡（Codex 还没接成执行方）。缓存 5 分钟，只在内存里。 */
export class CodexQuota {
  private state: TLocalQuotaSource | null = null;
  private reading: Promise<void> | null = null;
  private triedAt = 0;

  constructor(private readonly read: () => Promise<Json | null> = readCodexLimits, private readonly now = () => Date.now()) {}

  view(): TLocalQuotaSource[] { return this.state ? [this.state] : []; }

  syncView(): TLocalQuotaSync[] {
    const s = this.state;
    return s?.updatedAt ? [{ source: s.source, windows: s.windows, blockedUntil: s.blockedUntil, updatedAt: s.updatedAt }] : [];
  }

  /** 读一次：5 分钟内试过就不再读；没装 Codex 就什么都不列。从不抛错。 */
  refresh(force = false): Promise<void> {
    if (!force && this.now() - this.triedAt < QUOTA_TTL_MS) return this.reading ?? Promise.resolve();
    if (this.reading) return this.reading;
    this.triedAt = this.now();
    this.reading = this.read()
      .then((res) => {
        this.state = res ? { source: "codex_subscription", ...codexQuotaFrom(res), updatedAt: new Date(this.now()).toISOString(), error: null } : null;
      })
      .catch((e: unknown) => {
        const prev = this.state ?? { source: "codex_subscription" as const, plan: null, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null };
        this.state = { ...prev, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }
}
