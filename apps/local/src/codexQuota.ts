import type { TLocalQuotaSource, TLocalQuotaSync, TLocalQuotaWindow } from "@warmap/contracts";
import { QUOTA_TTL_MS, subscriptionSource, syncOf, type SubscriptionState } from "./quota.js";

type Json = Record<string, any>;

/** 按窗口长度认（新首页设计 11.1：不按 primary、secondary 的顺序）：5 小时是 session，7 天是 weekly_all，别的不认。 */
const BY_MINUTES: Record<number, TLocalQuotaWindow["kind"]> = { 300: "session", 10_080: "weekly_all" };

const iso = (sec: unknown) => (typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null);

/**
 * codex app-server 的 account/rateLimits/read 回执（11/07 实测 codex-cli 0.159.2：Plus 计划 primary 300 分钟、secondary 10080 分钟）→ 额度。
 * 到 100%（或 ordinaryUsageAllowed 为 false 时用得最多的那个窗口）算用完；Codex 不报警戒线，没有 warning。账号 id 不取。
 */
export function codexQuotaFrom(res: Json): Pick<SubscriptionState, "plan" | "windows" | "extraUsage" | "blockedUntil"> {
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
 * 本人 Codex 订阅的额度（新首页设计 11.1、11.5「Codex 那枚」）：读到的（account/rateLimits/read，没装为 null），加上 Codex 子会话跑着时报的
 * account/rateLimits/updated。用完了 Codex 的卡停下等额度（设计 17.2 第 38 条）。缓存 5 分钟，只在内存里。
 */
export class CodexQuota {
  private state: SubscriptionState | null = null;
  private reading: Promise<void> | null = null;
  private triedAt = 0;

  onChange: () => void = () => {};

  constructor(private readonly read: () => Promise<Json | null>, private readonly now = () => Date.now()) {}

  view(): TLocalQuotaSource[] { return this.state ? [subscriptionSource("codex", "Codex", this.state)] : []; }

  syncView(): TLocalQuotaSync[] { return this.view().flatMap(syncOf); }

  /** 读一次：5 分钟内试过就不再读；没装 Codex 就什么都不列。从不抛错。 */
  refresh(force = false): Promise<void> {
    if (!force && this.now() - this.triedAt < QUOTA_TTL_MS) return this.reading ?? Promise.resolve();
    if (this.reading) return this.reading;
    this.triedAt = this.now();
    this.reading = this.read()
      .then((res) => {
        this.state = res ? { ...codexQuotaFrom(res), updatedAt: new Date(this.now()).toISOString(), error: null } : null;
        this.onChange();
      })
      .catch((e: unknown) => {
        const prev = this.state ?? { plan: null, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null };
        this.state = { ...prev, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      })
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /** 用完了、还没到恢复时间：恢复时间（毫秒；用完了又不知道几点恢复为 Infinity）；没用完为 null。 */
  blockedUntil(): number | null {
    const s = this.state;
    if (!s) return null;
    if (s.blockedUntil) { const t = Date.parse(s.blockedUntil); return t > this.now() ? t : null; }
    return s.windows.some((w) => w.state === "blocked") ? Infinity : null;
  }

  /** 跑着的 Codex 会话报的额度（account/rateLimits/updated 的 rateLimits）：只改报到的窗口，没报的留着。 */
  fromEvent(snapshot: Json): void {
    const got = codexQuotaFrom({ rateLimits: snapshot });
    const prev = this.state ?? { plan: null, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null, error: null };
    const windows = [...prev.windows.filter((w) => !got.windows.some((g) => g.kind === w.kind)), ...got.windows];
    const blocked = windows.filter((w) => w.state === "blocked" && w.resetsAt).map((w) => w.resetsAt!).sort();
    this.state = { ...prev, plan: got.plan ?? prev.plan, windows, blockedUntil: blocked.at(-1) ?? null, updatedAt: new Date(this.now()).toISOString(), error: null };
    this.onChange();
  }
}
