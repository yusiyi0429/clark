/**
 * 右栏「用量」（新首页设计 14.4）：两列小格，一格一个用量来源——14 的小圆环（订阅额度剩多少）或「¥」空心圆（API 余额、当天花费）、名字、数。
 * 剩 ≤25% 琥珀、≤10% 或用完红；明细（每个窗口剩多少、几点重置）放在 title 里。
 * 数据是本机 GET /v1/status 的 quota（契约 LocalQuotaSource：id、名字、种类、剩的百分比或金额、窗口），这里只用到它的这几项；
 * 这台电脑读不到时用云端 /api/me/workers 的 resources.quota（各台设备报的 Claude 订阅），带 device 写成「Claude · ThinkPad」。
 */
export type QuotaWindowLike = {
  kind: "session" | "weekly_all" | "weekly_scoped";
  model: string | null;
  usedPercent: number;
  state: "ok" | "warning" | "blocked";
  resetsAt: string | null;
};
export type MoneyLike = { amount: number; currency: string };
export type UsageSourceLike = {
  id: string;
  name: string;
  kind: "subscription" | "api_balance" | "daily_spend";
  remainingPercent: number | null;
  amounts: MoneyLike[];
  monthAmounts?: MoneyLike[];
  windows: QuotaWindowLike[];
  blockedUntil: string | null;
  extraUsage?: boolean | null;
  updatedAt: string | null;
  /** 云端报的别的设备：名字后面加「 · 设备名」。 */
  device?: string;
};

export type QuotaTone = "ok" | "warning" | "danger";
export type UsageCell = {
  id: string;
  name: string;
  /** 订阅：0–100 剩多少（圆环）；钱的为 null（画「¥」）。 */
  percent: number | null;
  /** 「69%」「用完」「¥12.4」。 */
  value: string;
  tone: QuotaTone;
  /** 明细，一行一条（title 里换行）。 */
  tip: string;
  stale: boolean;
};

const STALE_MS = 15 * 60_000;
const WINDOW: Record<QuotaWindowLike["kind"], string> = { session: "5 小时", weekly_all: "本周", weekly_scoped: "本周" };
const SYMBOL: Record<string, string> = { CNY: "¥", RMB: "¥", USD: "$" };

/** 本地时间「08:00」；不是今天的写「11/9 08:00」。 */
export function clock(iso: string, now: number): string {
  const at = new Date(iso);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === at.toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

export const toneOf = (left: number, blocked: boolean): QuotaTone => (blocked || left <= 10 ? "danger" : left <= 25 ? "warning" : "ok");

/** 「¥12.4」；几种币种用「 + 」连起来；一笔都没有是「¥0」。 */
export function money(amounts: MoneyLike[]): string {
  if (!amounts.length) return "¥0";
  return amounts.map((entry) => `${SYMBOL[entry.currency.toUpperCase()] ?? `${entry.currency} `}${Number(entry.amount.toFixed(1))}`).join(" + ");
}

/** 一个来源一格。还没读到过的（没有更新时间，订阅也没有窗口）不画。 */
export function usageCells(sources: UsageSourceLike[], now: number): UsageCell[] {
  return sources.flatMap((source): UsageCell[] => {
    const name = source.device ? `${source.name} · ${source.device}` : source.name;
    const stale = !!source.updatedAt && now - Date.parse(source.updatedAt) > STALE_MS;
    const staleLine = stale && source.updatedAt ? [`${Math.floor((now - Date.parse(source.updatedAt)) / 60_000)} 分钟前更新`] : [];
    if (source.kind !== "subscription") {
      if (!source.updatedAt) return [];
      const lines = source.kind === "daily_spend"
        ? [`今天花了 ${money(source.amounts)}`, ...(source.monthAmounts ? [`本月 ${money(source.monthAmounts)}`] : [])]
        : [`余额 ${money(source.amounts)}`];
      return [{ id: source.id, name, percent: null, value: money(source.amounts), tone: "ok", tip: [...lines, ...staleLine].join("\n"), stale }];
    }
    if (source.remainingPercent === null && !source.windows.length) return [];
    const overall = source.windows.filter((window) => window.kind !== "weekly_scoped");
    const counted = overall.length ? overall : source.windows;
    const used = counted.length ? Math.max(...counted.map((window) => window.usedPercent)) : 100 - (source.remainingPercent ?? 100);
    const blocked = !!source.blockedUntil || counted.some((window) => window.state === "blocked" || window.usedPercent >= 100);
    const left = blocked ? 0 : source.remainingPercent ?? 100 - used;
    const lines = source.windows.map((window) => {
      const label = window.kind === "weekly_scoped" && window.model ? `${WINDOW[window.kind]} · ${window.model}` : WINDOW[window.kind];
      const rest = window.state === "blocked" || window.usedPercent >= 100 ? "用完" : `剩 ${100 - window.usedPercent}%`;
      return `${label}：${rest}${window.resetsAt ? ` · ${clock(window.resetsAt, now)} 重置` : ""}`;
    });
    if (source.blockedUntil) lines.push(`${clock(source.blockedUntil, now)} 恢复`);
    if (source.extraUsage !== null && source.extraUsage !== undefined) lines.push(`额外额度：${source.extraUsage ? "已开" : "未开"}`);
    return [{ id: source.id, name, percent: left, value: blocked ? "用完" : `${left}%`, tone: toneOf(left, blocked), tip: [...lines, ...staleLine].join("\n"), stale }];
  });
}
