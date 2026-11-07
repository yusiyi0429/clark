import { join } from "node:path";
import type { TBudget, TBudgetMode, TLocalEffort, TLocalModelTier, TLocalMoney, TLocalTaskBudgetView } from "@warmap/contracts";
import { readJson, writeJsonAtomic } from "./store.js";

/** 预算到了这个比例算「到 80%」（新首页设计 11.4）：后面开的卡思考强度降一档，验收员用轻档。 */
export const BUDGET_WARN = 0.8;

type State = TLocalTaskBudgetView["state"];

/** 订阅模型按档位跑什么：重活 Opus high、普通 Opus medium、轻活 Sonnet low（新首页设计 11.3「自动」）。 */
export const TIER_RUN: Record<TLocalModelTier, { model: string; effort: TLocalEffort }> = {
  strong: { model: "opus", effort: "high" },
  normal: { model: "opus", effort: "medium" },
  light: { model: "sonnet", effort: "low" },
};
const LOWER: Record<TLocalEffort, TLocalEffort> = { max: "xhigh", xhigh: "high", high: "medium", medium: "low", low: "low" };
/** 额度到这个百分比，「无上限」对新的轮次关掉多 agent，好在 100% 时干净停下（11.3）。 */
export const MULTI_AGENT_OFF_PERCENT = 95;

/**
 * 一次拉起怎么跑（新首页设计 11.3 的表），只管订阅：
 * - 自动：按档位；额度到警戒线后思考强度降一档。
 * - 设预算：同自动；预算到 80% 后思考强度降一档（警戒线和 80% 都到了也只降一档）；验收员这时用轻档。
 * - 无上限：每张都用 Opus、max，多 agent 开（额度到 95% 不开）；验收员用重档 Opus high。
 */
export function runFor(i: { mode: TBudgetMode; tier: TLocalModelTier; verify: boolean; budgetState: State; quotaPercent: number | null; quotaWarning: boolean }): { model: string; effort: TLocalEffort; multiAgent: boolean } {
  if (i.mode === "unlimited") {
    return i.verify ? { ...TIER_RUN.strong, multiAgent: false } : { model: "opus", effort: "max", multiAgent: (i.quotaPercent ?? 0) < MULTI_AGENT_OFF_PERCENT };
  }
  const tight = i.mode === "set" && i.budgetState !== "ok";
  if (i.verify && tight) return { ...TIER_RUN.light, multiAgent: false };
  const base = TIER_RUN[i.tier];
  return { model: base.model, effort: i.quotaWarning || tight ? LOWER[base.effort] : base.effort, multiAgent: false };
}

/** 验收连续没过几次算「受阻」（11.3：自动、设预算 2 轮，无上限 3 轮）。 */
export const reworkRounds = (mode: TBudgetMode) => (mode === "unlimited" ? 3 : 2);

/** 本机记着的一份预算（一件 Task，或一个不挂 Task 的会话）和用了多少。 */
interface Entry {
  taskId: string | null;
  sessionId: string | null;
  budget: TBudget;
  /** 第一个会话开工的时间。 */
  since: string | null;
  /** 已经跑完的那几段时长（毫秒）；正跑着的那段由会话那边加。 */
  runMs: number;
  /** 本周额度：开工（或上次重置）时的百分比、最近一次读到的、重置前累计涨了多少。 */
  weekly: { base: number; last: number; acc: number } | null;
  /** 网关的钱（本机按价目表估的）：一种币种。 */
  money: { amount: number; currency: string } | null;
  state: State;
  updatedAt: string;
}

/**
 * 预算记账（新首页设计 11.3、11.4）：时长只算真在跑的，本周额度算开工后涨了几个点，钱只算网关的（价目表估的）。
 * 存在数据目录的 budgets.json，本机程序重启后接着算。到了 80%、100% 怎么办由会话那边（SessionManager）做。
 */
export class Budgets {
  private readonly file: string;
  private readonly entries: Record<string, Entry>;

  constructor(dataDir: string, private readonly now = () => Date.now()) {
    this.file = join(dataDir, "budgets.json");
    this.entries = readJson<Record<string, Entry>>(this.file, {});
  }

  /** 记账的那一份：有 Task 按 Task，没有按会话。 */
  static key(taskId: string | null, sessionId: string): string {
    return taskId ? `task:${taskId}` : `session:${sessionId}`;
  }

  has(key: string): boolean { return key in this.entries; }
  budget(key: string): TBudget | null { return this.entries[key]?.budget ?? null; }
  state(key: string): State { return this.entries[key]?.state ?? "ok"; }
  keys(): string[] { return Object.keys(this.entries); }

  /** 收下一份预算（开工带来的、网页改的），以最新的为准。回 true 表示预算变了。 */
  set(key: string, scope: { taskId: string | null; sessionId: string | null }, budget: TBudget): boolean {
    const e = this.entries[key];
    if (e && JSON.stringify(e.budget) === JSON.stringify(budget)) return false;
    this.entries[key] = e ? { ...e, budget, updatedAt: this.stamp() } : {
      ...scope, budget, since: null, runMs: 0, weekly: null, money: null, state: "ok", updatedAt: this.stamp(),
    };
    this.save();
    return true;
  }

  /** 这一份第一次有会话开工：记下时间和本周额度的起点。 */
  start(key: string, weeklyPercent: number | null): void {
    const e = this.entries[key];
    if (!e || e.since) return;
    e.since = this.stamp();
    if (weeklyPercent !== null) e.weekly = { base: weeklyPercent, last: weeklyPercent, acc: 0 };
    this.save();
  }

  addRun(key: string, ms: number): void {
    const e = this.entries[key];
    if (!e || ms <= 0) return;
    e.runMs += ms;
    this.save();
  }

  /** 网关一轮的钱：预算设了金额就只算那个币种；没设就照第一笔的币种（别的币种不算，不换算）。 */
  addMoney(key: string, money: TLocalMoney): void {
    const e = this.entries[key];
    if (!e || money.amount <= 0) return;
    const currency = e.budget.money?.currency ?? e.money?.currency ?? money.currency;
    if (money.currency !== currency) return;
    e.money = { amount: (e.money?.currency === currency ? e.money.amount : 0) + money.amount, currency };
    this.save();
  }

  /** 读到了本周额度（整个账号的）：开工了的每一份都记上；百分比往下掉就是重置了，之前涨的累加进去、从 0 接着算。 */
  observeWeekly(percent: number): void {
    let changed = false;
    for (const e of Object.values(this.entries)) {
      if (!e.since) continue;
      if (!e.weekly) e.weekly = { base: percent, last: percent, acc: 0 };
      else if (percent < e.weekly.last) e.weekly = { base: 0, last: percent, acc: e.weekly.acc + e.weekly.last - e.weekly.base };
      else if (percent !== e.weekly.last) e.weekly.last = percent;
      else continue;
      changed = true;
    }
    if (changed) this.save();
  }

  /** 用掉的比例：设预算时各项「用了 ÷ 上限」里最大的；别的模式为 null。liveMs 是正跑着的那几段。 */
  ratio(key: string, liveMs = 0): number | null {
    const e = this.entries[key];
    if (!e || e.budget.mode !== "set") return null;
    const s = this.spent(e, liveMs);
    const parts = [
      e.budget.hours ? s.hours / e.budget.hours : 0,
      e.budget.weeklyPercent ? (s.weeklyPercent ?? 0) / e.budget.weeklyPercent : 0,
      e.budget.money && s.money?.currency === e.budget.money.currency ? s.money.amount / e.budget.money.amount : 0,
    ];
    return Math.max(...parts);
  }

  /** 按比例该是什么状态（不改记着的）。 */
  judge(key: string, liveMs = 0): State {
    const r = this.ratio(key, liveMs);
    return r === null ? "ok" : r >= 1 ? "exhausted" : r >= BUDGET_WARN ? "warning" : "ok";
  }

  setState(key: string, state: State): void {
    const e = this.entries[key];
    if (!e || e.state === state) return;
    e.state = state;
    e.updatedAt = this.stamp();
    this.save();
  }

  view(key: string, liveMs = 0): TLocalTaskBudgetView | null {
    const e = this.entries[key];
    if (!e) return null;
    const ratio = this.ratio(key, liveMs);
    return {
      taskId: e.taskId, sessionId: e.sessionId, budget: e.budget, spent: this.spent(e, liveMs),
      ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000, state: e.state, since: e.since, updatedAt: e.updatedAt,
    };
  }

  private spent(e: Entry, liveMs: number): TLocalTaskBudgetView["spent"] {
    return {
      hours: Math.round(((e.runMs + liveMs) / 3_600_000) * 10_000) / 10_000,
      weeklyPercent: e.weekly ? Math.max(0, e.weekly.acc + e.weekly.last - e.weekly.base) : null,
      money: e.money ? { amount: Math.round(e.money.amount * 1e6) / 1e6, currency: e.money.currency, estimated: true } : null,
    };
  }

  private stamp() { return new Date(this.now()).toISOString(); }
  private save() { writeJsonAtomic(this.file, this.entries); }
}
