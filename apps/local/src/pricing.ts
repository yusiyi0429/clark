import type { TLocalMoney } from "@warmap/contracts";
import type { TurnModels } from "./agents/types.js";

type Json = Record<string, any>;

/**
 * 网关模型的真钱（新首页设计 11.4）：按 TokenHub 的价目表自己算，照它的 price_util.py（TokenkingOS/tokavi-tokenhub @ f31dd05）：
 * - 价目表：GET {网关主机}/api/tokavi/v1/model/prices?model_name=…，带本机存的钥匙（x-api-key），回 { model_name, price_info }；缓存 1 小时。
 * - 两种策略：input-tiered 按一次请求的输入长度选档；peak-low-timed 按调用时刻在价目表时区里落在哪个时段选价格段（reference 是别的段乘倍率）。
 * - 输入长度按 TokenHub 的口径算（含缓存读写）；Claude Code 的请求都带缓存标记，按显式缓存的单价，价目表没给缓存价就按输入价。
 * 和 TokenHub 实际扣的会有出入，都标「估」：节假日按周一到周五算工作日（TokenHub 用国内节假日表）；一轮里几次请求按平均长度选档（数不出次数时按整轮）；币种照价目表，不换算。
 */
const UNIT: Record<string, number> = { "1M-token": 1e6, "1k-token": 1e3, "1-token": 1 };
const SIZE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30 };

function size(text: string): number {
  const m = /^(-?inf|\d+(?:\.\d+)?)(k|K|M|G|Ki|Mi|Gi)?$/.exec(text.trim());
  if (!m) throw new Error(`价目表里的长度认不出：${text}`);
  if (m[1] === "inf") return Infinity;
  if (m[1] === "-inf") return -Infinity;
  return Number(m[1]) * (m[2] ? SIZE[m[2]]! : 1);
}

export function inInterval(value: number, text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || !"([".includes(t[0]!) || !")]".includes(t.at(-1)!)) throw new Error(`价目表里的区间认不出：${text}`);
  const [a, b] = t.slice(1, -1).split(",");
  const lo = size(a ?? ""), hi = size(b ?? "");
  const loOk = lo === -Infinity || (t[0] === "[" ? value >= lo : value > lo);
  const hiOk = hi === Infinity || (t.at(-1) === "]" ? value <= hi : value < hi);
  return loOk && hiOk;
}

const priceOf = (block: Json | undefined, key: string): number | null => {
  const v = block?.[`${key}_text`] ?? block?.[key];
  return v === null || v === undefined ? null : Number(v);
};

/** datetime 表达式：| 或、& 与、! 非、括号。操作数是 weekday、weekend、workday、non_workday、all_date 和价目表里命名的时段。 */
export function evalExpr(expr: string, flags: Record<string, boolean>): boolean {
  const tokens = expr.match(/\(|\)|!|&|\||[A-Za-z_][A-Za-z_0-9]*/g) ?? [];
  let i = 0;
  const or = (): boolean => { let v = and(); while (tokens[i] === "|") { i++; v = and() || v; } return v; };
  const and = (): boolean => { let v = factor(); while (tokens[i] === "&") { i++; v = factor() && v; } return v; };
  const factor = (): boolean => {
    const t = tokens[i++];
    if (t === "!") return !factor();
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") throw new Error(`时段表达式认不出：${expr}`); return v; }
    if (t === undefined || !(t in flags)) throw new Error(`时段表达式认不出：${expr}`);
    return flags[t]!;
  };
  const v = or();
  if (i !== tokens.length) throw new Error(`时段表达式认不出：${expr}`);
  return v;
}

function inRanges(minutes: number, ranges: unknown): boolean {
  const m = (s: string) => { const [h, mi] = s.trim().split(":").map(Number); return (h ?? 0) * 60 + (mi ?? 0); };
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const [a, b] = String(r).split("-");
    const start = m(a ?? ""), end = m(b ?? "");
    if (start >= end ? minutes >= start || minutes <= end : minutes >= start && minutes <= end) return true;
  }
  return false;
}

/** peak-low-timed：按价目表时区的本地时刻挑价格段，都不中就是 other。 */
function pickPeriod(price: Json, at: Date): string {
  const def = price.datetime_define ?? {};
  const tz = /^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(String(def.timezone ?? "UTC+8").trim());
  const offset = tz ? (tz[1] === "-" ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3] ?? 0)) : 480;
  const local = new Date(at.getTime() + offset * 60_000);
  const day = local.getUTCDay();
  const weekend = day === 0 || day === 6;
  const flags: Record<string, boolean> = { weekday: !weekend, weekend, workday: !weekend, non_workday: weekend, all_date: true };
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  for (const [name, ranges] of Object.entries(def.time ?? {})) flags[name] = inRanges(minutes, ranges);
  for (const [name, period] of Object.entries((price.price_periods ?? {}) as Record<string, Json>)) {
    if (name !== "other" && period?.datetime && evalExpr(String(period.datetime), flags)) return name;
  }
  if (!price.price_periods?.other) throw new Error("价目表分时段却没有 other");
  return "other";
}

function multiply(tiered: Json, k: number): Json {
  const scale = (o: Json) => Object.fromEntries(Object.entries(o).filter(([key, v]) => key !== "range" && v !== null).map(([key, v]) => [key, Number(v) * k]));
  return {
    ...tiered,
    tiers: (tiered.tiers ?? []).map((t: Json) => Object.fromEntries(Object.entries(t).map(([key, v]) => {
      if (key === "range" || v === null) return [key, v];
      if (key === "implicit_cached" && v && typeof v === "object") return [key, scale(v as Json)];
      if (key === "explicit_cached" && v && typeof v === "object") return [key, { ttl: ((v as Json).ttl ?? []).map(scale) }];
      return [key, Number(v) * k];
    }))),
  };
}

function resolvePeriod(price: Json, name: string | null, seen: string[] = []): Json {
  const target = name === null ? price : price.price_periods?.[name]?.price;
  if (!target) throw new Error(`价目表里没有价格段 ${name}`);
  const strategy = target.strategy ?? "input-tiered";
  if (strategy === "reference") {
    const to = target.ref?.refer_to;
    if (!to || seen.includes(to)) throw new Error("价目表的参考价格段不对");
    return multiply(resolvePeriod(price, to, [...seen, to]), Number(target.ref?.multiply ?? 1));
  }
  if (strategy !== "input-tiered") throw new Error(`价目表策略认不出：${strategy}`);
  return target;
}

/** 一个模型在一轮里的用量（TokenHub 口径：输入含缓存读写）。perRequestInput 是选档用的一次请求的输入长度。 */
export interface PricedUsage { input: number; cacheRead: number; cacheWrite: number; output: number; perRequestInput: number }

/** 照 TokenHub 的 calculate_cost 算一个模型的费用和币种（cache_mode 按 explicit）。 */
export function costOf(u: PricedUsage, price: Json, at: Date): { amount: number; currency: string } {
  const divisor = UNIT[String(price.unit ?? "1M-token").trim()];
  if (!divisor) throw new Error(`价目表单位认不出：${price.unit}`);
  const strategy = price.strategy ?? "input-tiered";
  const tiered = strategy === "input-tiered" ? price : strategy === "peak-low-timed" ? resolvePeriod(price, pickPeriod(price, at)) : null;
  if (!tiered) throw new Error(`价目表策略认不出：${strategy}`);
  const tier = (tiered.tiers ?? []).find((t: Json) => inInterval(u.perRequestInput, String(t.range ?? "")));
  if (!tier) throw new Error("价目表里没有这个长度的档");
  const input = priceOf(tier, "input");
  const output = priceOf(tier, "output");
  const ttl = tier.explicit_cached?.ttl?.[0];
  const read = priceOf(ttl, "read") ?? input;
  const write = priceOf(ttl, "write") ?? input;
  const plain = Math.max(u.input - u.cacheRead - u.cacheWrite, 0);
  const amount = ((input ?? 0) * plain + (read ?? 0) * u.cacheRead + (write ?? 0) * u.cacheWrite + (output ?? 0) * u.output) / divisor;
  return { amount, currency: String(price.currency ?? "") };
}

/** 网关地址（如 https://tokenhub.corp.tokenkingos.com/api/anthropic）→ 同一台主机上的价目表接口。 */
export const pricesUrl = (baseUrl: string, model: string) => {
  const u = new URL("/api/tokavi/v1/model/prices", new URL(baseUrl).origin);
  u.searchParams.set("model_name", model);
  return u.toString();
};

/** 按 TokenHub 价目表估网关一轮的钱。读不到价目表、价目表认不出就是 null（这一轮不算真钱）。 */
export class GatewayPricing {
  private readonly cache = new Map<string, { at: number; price: Json | null }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now = () => Date.now()) {}

  private async price(baseUrl: string, apiKey: string, model: string): Promise<Json | null> {
    const key = `${new URL(baseUrl).origin} ${model}`;
    const hit = this.cache.get(key);
    // 读到的缓存 1 小时，没读到的 10 分钟后再试
    if (hit && this.now() - hit.at < (hit.price ? 3_600_000 : 600_000)) return hit.price;
    let price: Json | null = null;
    try {
      const res = await this.fetchImpl(pricesUrl(baseUrl, model), { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(10_000) });
      const body = res.ok ? ((await res.json()) as Json) : null;
      price = body?.price_info && typeof body.price_info === "object" ? body.price_info : null;
    } catch { price = null; }
    this.cache.set(key, { at: this.now(), price });
    return price;
  }

  async money(gateway: { baseUrl: string | null; apiKey: string | null }, turn: TurnModels | null, at = new Date(this.now())): Promise<TLocalMoney | null> {
    if (!gateway.baseUrl || !gateway.apiKey || !turn?.models.length) return null;
    const totals = new Map<string, number>();
    for (const m of turn.models) {
      const price = await this.price(gateway.baseUrl, gateway.apiKey, m.model);
      if (!price) return null;
      const input = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
      try {
        const c = costOf({ input, cacheRead: m.cacheReadTokens, cacheWrite: m.cacheWriteTokens, output: m.outputTokens, perRequestInput: input / Math.max(1, m.requests ?? 1) }, price, at);
        if (!c.currency) return null;
        totals.set(c.currency, (totals.get(c.currency) ?? 0) + c.amount);
      } catch { return null; }
    }
    // 一轮里几个模型币种不同时不换算：只报用得最多的那个币种（极少见）
    const [currency, amount] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return { amount: Math.round(amount * 1e6) / 1e6, currency, estimated: true };
  }
}
