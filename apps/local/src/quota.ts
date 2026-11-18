import { join } from "node:path";
import type { TLocalQuotaSource, TLocalQuotaSync, TLocalQuotaWindow } from "@warmap/contracts";

/** 一个订阅在本机记着的样子（quota.json 里就是这个，旧文件多一个 source 字段也认）。 */
export interface SubscriptionState {
  plan: string | null;
  windows: TLocalQuotaWindow[];
  blockedUntil: string | null;
  extraUsage: boolean | null;
  updatedAt: string | null;
  error: string | null;
}

/** 过了重置时间的窗口（读不到时留着的旧数）：已经是新的一期，按用量 0、不警戒算，不留过去的重置时间。 */
export function liveWindows(windows: TLocalQuotaWindow[], now: number): TLocalQuotaWindow[] {
  return windows.map((w) => (w.resetsAt && Date.parse(w.resetsAt) <= now ? { ...w, usedPercent: 0, state: "ok", resetsAt: null } : w));
}

/**
 * 订阅 → 右栏「用量」的一格（新首页设计 14.4）：剩多少是 100 减去用得最多的那个窗口（按模型分的周额度不算，除非只有它），
 * 几点重置跟着那个窗口。过了重置时间的窗口按用量 0 算，过了的恢复时间不报。
 */
export function subscriptionSource(id: string, name: string, s: SubscriptionState, now: number): TLocalQuotaSource {
  const windows = liveWindows(s.windows, now);
  const main = windows.filter((w) => w.kind !== "weekly_scoped");
  const pool = main.length ? main : windows;
  const top = pool.length ? pool.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : null;
  const blockedUntil = s.blockedUntil && Date.parse(s.blockedUntil) > now ? s.blockedUntil : null;
  return {
    id, name, kind: "subscription", remainingPercent: top ? 100 - top.usedPercent : null, amounts: [], windows, resetsAt: top?.resetsAt ?? null,
    blockedUntil, plan: s.plan, extraUsage: s.extraUsage, updatedAt: s.updatedAt, error: s.error,
  };
}

/** 同步给云端的那一份：读到过才有，不带计划名、额外额度、出错原因。 */
export function syncOf(q: TLocalQuotaSource): TLocalQuotaSync[] {
  if (!q.updatedAt) return [];
  return [{
    id: q.id, name: q.name, kind: q.kind, remainingPercent: q.remainingPercent, amounts: q.amounts, ...(q.monthAmounts ? { monthAmounts: q.monthAmounts } : {}),
    windows: q.windows, resetsAt: q.resetsAt, blockedUntil: q.blockedUntil, updatedAt: q.updatedAt,
  }];
}
import { readJson, writeJsonAtomic } from "./store.js";

type Json = Record<string, any>;

/** 读一次额度隔多久：缓存 5 分钟（新首页设计 11.1：get_usage 有自己的限流）。 */
export const QUOTA_TTL_MS = 5 * 60_000;
/**
 * 读不到以后停多久再读：官方额度接口 429 时 Claude Code 自己记着「多久以后再问」，但 get_usage 只回 rate_limits null、不带这个时间
 * （11/18 查 2.1.327），拿不到就停 45 分钟。
 */
export const QUOTA_RETRY_MS = 45 * 60_000;
/** 读不到时记在 error 里的话（网页见到 error 就在旧数旁边写「暂时读不到」）。 */
const UNREADABLE = "暂时读不到（get_usage 没给额度）";

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
export function quotaFromUsage(resp: Json): Pick<SubscriptionState, "plan" | "windows" | "extraUsage" | "blockedUntil"> {
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
  private state: SubscriptionState | null;
  private reading: Promise<void> | null = null;
  /** 上次去读的时间（没读到也算）：读不到时不能每次轮询都起一个 Claude Code。 */
  private triedAt = 0;
  /** 读不到以后，这之前不再去读（force 照读）。 */
  private retryAt = 0;
  onChange: () => void = () => {};

  constructor(dataDir: string, private readonly read: () => Promise<Json>, private readonly now = () => Date.now()) {
    this.file = join(dataDir, "quota.json");
    this.state = readJson<SubscriptionState | null>(this.file, null);
  }

  /** GET /v1/status 用：还没读过为空。 */
  view(): TLocalQuotaSource[] { return this.state ? [subscriptionSource("claude", "Claude", this.state, this.now())] : []; }

  /** 同步给云端用：读到过才带。 */
  syncView(): TLocalQuotaSync[] { return this.view().flatMap(syncOf); }

  /** 订阅额度用完、还没到恢复时间：恢复时间（毫秒；有窗口用完了又没给恢复时间为 Infinity）；没用完为 null。 */
  blockedUntil(): number | null {
    const s = this.state;
    if (!s) return null;
    if (s.blockedUntil) { const t = Date.parse(s.blockedUntil); return t > this.now() ? t : null; }
    return s.windows.some((w) => w.state === "blocked" && !w.resetsAt) ? Infinity : null;
  }

  /** 本周（所有模型）用了几个百分点：预算记「开工后涨了几个点」用（过了重置时间按 0，预算那边当本周重置）；读不到为 null。 */
  weeklyPercent(): number | null {
    return liveWindows(this.state?.windows ?? [], this.now()).find((w) => w.kind === "weekly_all")?.usedPercent ?? null;
  }

  /** 5 小时和本周（所有模型）里用得最多的百分比（按模型分的不算）：「无上限」到 95% 对新的轮次关掉多 agent；读不到为 null。 */
  usedPercent(): number | null {
    const ws = liveWindows(this.state?.windows ?? [], this.now()).filter((w) => w.kind !== "weekly_scoped");
    return ws.length ? Math.max(...ws.map((w) => w.usedPercent)) : null;
  }

  /** 到了警戒线（Claude Code 报 warning，按模型分的不算）：「自动」「设预算」后面拉起的思考强度降一档。 */
  warning(): boolean {
    return liveWindows(this.state?.windows ?? [], this.now()).some((w) => w.kind !== "weekly_scoped" && w.state === "warning");
  }

  /**
   * 读一次（get_usage）。force 以外 5 分钟内读过、试过就不再读，读不到以后停 45 分钟；同时只读一次。从不抛错，没读到记在 error 里。
   * 一个认得的窗口都没给（rate_limits 为 null 等）算读不到：上一次的数和时间留着，只记 error。读的途中跑着的卡报过（比这次读新）就以卡报的为准。
   */
  refresh(force = false): Promise<void> {
    const at = Math.max(this.triedAt, this.state?.updatedAt ? Date.parse(this.state.updatedAt) : 0);
    if (!force && (this.now() < this.retryAt || this.now() - at < QUOTA_TTL_MS)) return this.reading ?? Promise.resolve();
    if (!this.reading) this.triedAt = this.now();
    const startedAt = this.now();
    this.reading ??= this.read()
      .then((resp) => {
        const got = quotaFromUsage(resp);
        if (!got.windows.length) this.retryAt = this.now() + QUOTA_RETRY_MS;
        if (this.state?.updatedAt && Date.parse(this.state.updatedAt) > startedAt) return;
        if (!got.windows.length) return this.set({ ...(this.state ?? { plan: got.plan, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null }), error: UNREADABLE });
        this.set({ ...got, updatedAt: this.stamp(), error: null });
      })
      .catch((e: unknown) => this.set({ ...(this.state ?? { plan: null, windows: [], extraUsage: null, blockedUntil: null, updatedAt: null }), error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }))
      .finally(() => { this.reading = null; });
    return this.reading;
  }

  /** 跑着的卡报的额度变化（rate_limit_event 的 rate_limit_info）：只改报到的窗口；rejected 就记下几点恢复。 */
  fromEvent(info: Json): void {
    const s: SubscriptionState = this.state ?? { plan: null, windows: [], blockedUntil: null, extraUsage: null, updatedAt: null, error: null };
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
    this.set({ ...s, windows: windows.slice(0, 12), blockedUntil, updatedAt: this.stamp(), error: null });
  }

  private stamp() { return new Date(this.now()).toISOString(); }

  private set(next: SubscriptionState) {
    this.state = next;
    writeJsonAtomic(this.file, this.state);
    this.onChange();
  }
}
