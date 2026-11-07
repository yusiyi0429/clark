import { join } from "node:path";
import type { TLocalQuotaSource, TLocalQuotaSync, TLocalQuotaWindow } from "@warmap/contracts";
import { readJson, writeJsonAtomic } from "./store.js";

type Json = Record<string, any>;

/** 读一次额度隔多久：缓存 5 分钟（新首页设计 11.1：get_usage 有自己的限流）。 */
export const QUOTA_TTL_MS = 5 * 60_000;

const KINDS = new Set<TLocalQuotaWindow["kind"]>(["session", "weekly_all", "weekly_scoped"]);
/** rate_limit_event 的窗口名 → 契约里的种类（只认这两种，按模型分的周额度等 get_usage 来补）。 */
const EVENT_KINDS: Record<string, TLocalQuotaWindow["kind"]> = { five_hour: "session", seven_day: "weekly_all" };

const iso = (v: unknown): string | null => {
  if (typeof v === "number" && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};
const pct = (v: unknown) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

/**
 * get_usage 的回执（11/07 实测 Claude Code 2.1.318）→ 额度。只取 rate_limits.limits 里认得的窗口；邮箱、组织等账号信息不取。
 * 用完了几点恢复只看在用的窗口（is_active 不是 false）：没在用的模型的周额度满了不挡别的卡（真碰上了，跑着的卡会报 rejected）。
 */
export function quotaFromUsage(resp: Json): Pick<TLocalQuotaSource, "plan" | "windows" | "extraUsage" | "blockedUntil"> {
  const rl = resp.rate_limits ?? {};
  const windows: TLocalQuotaWindow[] = [];
  const blocked: string[] = [];
  for (const l of Array.isArray(rl.limits) ? rl.limits : []) {
    if (!KINDS.has(l?.kind)) continue;
    const usedPercent = pct(l.percent);
    const state: TLocalQuotaWindow["state"] = usedPercent >= 100 ? "blocked" : l.severity === "warning" || l.severity === "critical" ? "warning" : "ok";
    const name = l.scope?.model?.display_name;
    const w: TLocalQuotaWindow = { kind: l.kind, model: typeof name === "string" && name ? name.slice(0, 60) : null, usedPercent, state, resetsAt: iso(l.resets_at) };
    windows.push(w);
    if (state === "blocked" && l.is_active !== false && w.resetsAt) blocked.push(w.resetsAt);
  }
  blocked.sort();
  return {
    plan: typeof resp.subscription_type === "string" ? resp.subscription_type.slice(0, 40) : null,
    windows: windows.slice(0, 12),
    extraUsage: typeof rl.extra_usage?.is_enabled === "boolean" ? rl.extra_usage.is_enabled : null,
    blockedUntil: blocked.at(-1) ?? null,
  };
}

/**
 * 本人 Claude 订阅的额度（新首页设计第 11 节）：get_usage 读到的全部窗口，加上跑着的卡实时报的 rate_limit_event。
 * 缓存在数据目录的 quota.json（本机程序重启后还认得「用完了、几点恢复」）。读额度只在本机，同步给云端时只带百分比、状态、时间。
 */
export class QuotaTracker {
  private readonly file: string;
  private state: TLocalQuotaSource | null;
  private reading: Promise<void> | null = null;
  /** 上次去读的时间（没读到也算）：读不到时不能每次轮询都起一个 Claude Code。 */
  private triedAt = 0;
  onChange: () => void = () => {};

  constructor(dataDir: string, private readonly read: () => Promise<Json>, private readonly now = () => Date.now()) {
    this.file = join(dataDir, "quota.json");
    this.state = readJson<TLocalQuotaSource | null>(this.file, null);
  }

  /** GET /v1/status 用：还没读过为空。 */
  view(): TLocalQuotaSource[] { return this.state ? [this.state] : []; }

  /** 同步给云端用：读到过才带，只有窗口、恢复时间、读到的时间。 */
  syncView(): TLocalQuotaSync[] {
    const s = this.state;
    return s?.updatedAt ? [{ source: s.source, windows: s.windows, blockedUntil: s.blockedUntil, updatedAt: s.updatedAt }] : [];
  }

  /** 订阅额度用完、还没到恢复时间：恢复时间（毫秒；有窗口用完了又没给恢复时间为 Infinity）；没用完为 null。 */
  blockedUntil(): number | null {
    const s = this.state;
    if (!s) return null;
    if (s.blockedUntil) { const t = Date.parse(s.blockedUntil); return t > this.now() ? t : null; }
    return s.windows.some((w) => w.state === "blocked" && !w.resetsAt) ? Infinity : null;
  }

  /** 本周（所有模型）用了几个百分点：预算记「开工后涨了几个点」用；读不到为 null。 */
  weeklyPercent(): number | null {
    return this.state?.windows.find((w) => w.kind === "weekly_all")?.usedPercent ?? null;
  }

  /** 5 小时和本周（所有模型）里用得最多的百分比（按模型分的不算）：「无上限」到 95% 对新的轮次关掉多 agent；读不到为 null。 */
  usedPercent(): number | null {
    const ws = this.state?.windows.filter((w) => w.kind !== "weekly_scoped") ?? [];
    return ws.length ? Math.max(...ws.map((w) => w.usedPercent)) : null;
  }

  /** 到了警戒线（Claude Code 报 warning，按模型分的不算）：「自动」「设预算」后面拉起的思考强度降一档。 */
  warning(): boolean {
    return Boolean(this.state?.windows.some((w) => w.kind !== "weekly_scoped" && w.state === "warning"));
  }

  /** 读一次（get_usage）。force 以外 5 分钟内读过、试过就不再读；同时只读一次。从不抛错，没读到记在 error 里。 */
  refresh(force = false): Promise<void> {
    const at = Math.max(this.triedAt, this.state?.updatedAt ? Date.parse(this.state.updatedAt) : 0);
    if (!force && this.now() - at < QUOTA_TTL_MS) return this.reading ?? Promise.resolve();
    if (!this.reading) this.triedAt = this.now();
    this.reading ??= this.read()
      .then((resp) => this.set({ ...quotaFromUsage(resp), updatedAt: this.stamp(), error: null }))
      .catch((e: unknown) => this.set({ ...(this.state ?? { plan: null, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null }), error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }))
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /** 跑着的卡报的额度变化（rate_limit_event 的 rate_limit_info）：只改报到的窗口；rejected 就记下几点恢复。 */
  fromEvent(info: Json): void {
    const s: TLocalQuotaSource = this.state ?? { source: "claude_subscription", plan: null, windows: [], blockedUntil: null, extraUsage: null, updatedAt: null, error: null };
    const windows = [...s.windows];
    const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows as Record<string, Json> : {};
    for (const [name, w] of Object.entries(unified)) {
      const kind = EVENT_KINDS[name];
      if (!kind || !w) continue;
      const next: TLocalQuotaWindow = {
        kind, model: null, usedPercent: pct((Number(w.utilization) || 0) * 100),
        state: w.status === "rejected" ? "blocked" : w.status === "allowed_warning" ? "warning" : "ok", resetsAt: iso(w.resetsAt),
      };
      const i = windows.findIndex((x) => x.kind === kind && x.model === null);
      if (i >= 0) windows[i] = next; else windows.push(next);
    }
    const blockedUntil = info.status === "rejected" ? iso(info.resetsAt) : null;
    this.set({ ...s, windows: windows.slice(0, 12), blockedUntil, updatedAt: this.stamp() });
  }

  private stamp() { return new Date(this.now()).toISOString(); }

  private set(next: Omit<TLocalQuotaSource, "source">) {
    this.state = { source: "claude_subscription", ...next };
    writeJsonAtomic(this.file, this.state);
    this.onChange();
  }
}
