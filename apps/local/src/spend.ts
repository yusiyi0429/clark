import { createHash } from "node:crypto";
import type { TLocalMoney, TLocalSpendSource, TLocalSpendSync } from "@warmap/contracts";

type Json = Record<string, any>;

/** 读一次花费隔多久（网页每 10 秒问一次状态）。 */
export const SPEND_TTL_MS = 5 * 60_000;
/** 一个月最多 31 × 48 个半小时 × 用过的模型数，一页最多 500 条；超过这么多页就不读了（报错）。 */
const MAX_PAGES = 20;

export interface Gateway { baseUrl: string; apiKey: string }

/** TokenHub 的用量统计接口（tokavi-tokenhub f31dd05 的 tokavi_router.get_log_usage）：只能查这把钥匙所在的计费账户，半小时一格。 */
export const usageUrl = (baseUrl: string, start: Date, page: number) => {
  const u = new URL("/api/tokavi/v1/log/usage", new URL(baseUrl).origin);
  u.searchParams.set("time_start", start.toISOString());
  u.searchParams.set("page", String(page));
  u.searchParams.set("page_size", "500");
  return u.toString();
};

/** 本机今天 0 点、本月 1 日 0 点（本人所在时区）。 */
export function dayAndMonthStart(now: Date): { day: Date; month: Date } {
  return { day: new Date(now.getFullYear(), now.getMonth(), now.getDate()), month: new Date(now.getFullYear(), now.getMonth(), 1) };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const moneyOf = (totals: Map<string, number>): TLocalMoney[] =>
  [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([currency, amount]) => ({ amount: round(amount), currency, estimated: false }));

/**
 * 网关花了多少（新首页设计 11.2、13.1：右栏「TokenHub 今天 ¥x」，每人一个计费账户，就是本人的）：用本机存的网关钥匙调 TokenHub 自己的用量统计，
 * 按币种加今天、本月的 wallet_charge。不是 TokenHub 的网关（没有这个接口）不列。读到的只在内存里，本机程序重启后重读。
 */
export class GatewaySpend {
  private readonly sources = new Map<string, TLocalSpendSource>();
  private reading: Promise<void> | null = null;
  private triedAt = 0;

  constructor(private readonly gateways: () => Promise<Gateway[]>, private readonly fetchImpl: typeof fetch = fetch, private readonly now = () => Date.now()) {}

  view(): TLocalSpendSource[] {
    return [...this.sources.values()].slice(0, 4);
  }

  /** 同步给云端：读到过才带，只有今天、本月和时间。 */
  syncView(): TLocalSpendSync[] {
    return this.view().flatMap((s) => (s.updatedAt ? [{ source: s.source, today: s.today, month: s.month, updatedAt: s.updatedAt }] : []));
  }

  /** 读一次。force 以外 5 分钟内试过就不再读；同时只读一次。从不抛错，没读到记在那一项的 error 里。 */
  refresh(force = false): Promise<void> {
    if (!force && this.now() - this.triedAt < SPEND_TTL_MS) return this.reading ?? Promise.resolve();
    if (this.reading) return this.reading;
    this.triedAt = this.now();
    this.reading = this.readAll().finally(() => { this.reading = null; });
    return this.reading;
  }

  private async readAll(): Promise<void> {
    const list = await this.gateways().catch(() => [] as Gateway[]);
    const seen = new Set<string>();
    for (const g of list) {
      let host: string;
      try { host = new URL(g.baseUrl).host; } catch { continue; }
      // 同一把钥匙配在几个模型上只读一次；钥匙不出本机，只用它的摘要认是不是同一把
      const id = `${host}#${createHash("sha256").update(g.apiKey).digest("hex").slice(0, 12)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const prev = this.sources.get(id);
      try {
        const got = await this.read(g);
        if (!got) { this.sources.delete(id); continue; }
        this.sources.set(id, { source: "tokenhub", host, account: got.account, today: got.today, month: got.month, updatedAt: new Date(this.now()).toISOString(), error: null });
      } catch (e) {
        this.sources.set(id, {
          source: "tokenhub", host, account: prev?.account ?? null, today: prev?.today ?? [], month: prev?.month ?? [], updatedAt: prev?.updatedAt ?? null,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        });
      }
    }
    // 删掉的网关不再列
    for (const id of [...this.sources.keys()]) if (!seen.has(id)) this.sources.delete(id);
    // 同一个计费账户配了几把钥匙：只留一项
    const byAccount = new Map<string, string>();
    for (const [id, s] of this.sources) {
      if (!s.account) continue;
      const k = `${s.host} ${s.account}`;
      if (byAccount.has(k)) this.sources.delete(id); else byAccount.set(k, id);
    }
  }

  /** 读一把钥匙的今天、本月。不是 TokenHub（404）回 null；别的失败抛错。 */
  private async read(g: Gateway): Promise<{ account: string | null; today: TLocalMoney[]; month: TLocalMoney[] } | null> {
    const { day, month } = dayAndMonthStart(new Date(this.now()));
    const today = new Map<string, number>();
    const total = new Map<string, number>();
    let account: string | null = null;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error("这个月的用量条目太多，没读完");
      const res = await this.fetchImpl(usageUrl(g.baseUrl, month, page), { headers: { "x-api-key": g.apiKey }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 404) return null;
      if (res.status === 401) throw new Error("TokenHub 不认这把钥匙");
      if (!res.ok) throw new Error(`TokenHub 用量接口回 ${res.status}`);
      const body = (await res.json()) as Json;
      if (!Array.isArray(body.items)) throw new Error("TokenHub 用量接口的回执认不出");
      if (typeof body.account_name === "string") account = body.account_name.slice(0, 100);
      for (const it of body.items as Json[]) {
        const currency = typeof it.pay_currency === "string" ? it.pay_currency : "";
        const charge = Number(it.wallet_charge) || 0;
        if (!currency || charge <= 0) continue; // 没配价格的不计费
        total.set(currency, (total.get(currency) ?? 0) + charge);
        // 半小时一格：从今天 0 点起的那几格算今天
        if (Date.parse(String(it.call_time_half_hour)) >= day.getTime()) today.set(currency, (today.get(currency) ?? 0) + charge);
      }
      const size = Number(body.page_size) || 500;
      if ((body.items as Json[]).length < size || page * size >= (Number(body.total) || 0)) break;
    }
    return { account, today: moneyOf(today), month: moneyOf(total) };
  }
}
