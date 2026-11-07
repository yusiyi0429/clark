/**
 * 右栏资源块的额度行（新首页设计 5.4.5「额度」、11.2）：每个来源一行「名字 剩 17% 08:00」，下面一条 2px 额度条；
 * 剩 ≤25% 琥珀、≤10% 或用完红；用完写「用完 · 08:00」；超过 15 分钟没更新整行变淡、写「15 分钟前」。
 * 点开是明细：每个窗口一行「剩多少 · 几点重置」，最后一行「额外额度 · 已开 / 未开」。
 * 数据是本机 GET /v1/status 的 quota（D 的契约 LocalQuotaSource），这里只用到它的这几项。
 */
export type QuotaWindowLike = {
  kind: "session" | "weekly_all" | "weekly_scoped";
  model: string | null;
  usedPercent: number;
  state: "ok" | "warning" | "blocked";
  resetsAt: string | null;
};
export type QuotaSourceLike = {
  source: "claude_subscription";
  windows: QuotaWindowLike[];
  blockedUntil: string | null;
  extraUsage: boolean | null;
  updatedAt: string | null;
};

export type QuotaTone = "ok" | "warning" | "danger";
export type QuotaRow = {
  name: string;
  /** 「剩 17%」或「用完」。 */
  amount: string;
  /** 下次重置的时刻「08:00」（读不到为 null）。 */
  resets: string | null;
  /** 0–100，额度条的填充。 */
  left: number;
  tone: QuotaTone;
  /** 超过 15 分钟没更新：「15 分钟前」（新的为 null）。 */
  stale: string | null;
  details: string[];
};

const STALE_MS = 15 * 60_000;
const NAME: Record<QuotaSourceLike["source"], string> = { claude_subscription: "Claude 订阅" };
const WINDOW: Record<QuotaWindowLike["kind"], string> = { session: "5 小时", weekly_all: "本周", weekly_scoped: "本周" };

/** 本地时间「08:00」；不是今天的写「11/9 08:00」。 */
export function clock(iso: string, now: number): string {
  const at = new Date(iso);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === at.toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

export const toneOf = (left: number, blocked: boolean): QuotaTone => (blocked || left <= 10 ? "danger" : left <= 25 ? "warning" : "ok");

/** 一个来源一行：取剩得最少的那个窗口（用完的优先）。没有窗口（还没读到）不画。 */
export function quotaRows(sources: QuotaSourceLike[], now: number): QuotaRow[] {
  return sources.flatMap((source) => {
    if (!source.windows.length) return [];
    const tightest = [...source.windows].sort((a, b) => Number(b.state === "blocked") - Number(a.state === "blocked") || b.usedPercent - a.usedPercent)[0]!;
    const blocked = tightest.state === "blocked" || tightest.usedPercent >= 100 || !!source.blockedUntil;
    const left = blocked ? 0 : 100 - tightest.usedPercent;
    const resetIso = source.blockedUntil ?? tightest.resetsAt;
    const age = source.updatedAt ? now - Date.parse(source.updatedAt) : 0;
    const details = source.windows.map((window) => {
      const name = window.kind === "weekly_scoped" && window.model ? `${WINDOW[window.kind]} · ${window.model}` : WINDOW[window.kind];
      const rest = window.state === "blocked" || window.usedPercent >= 100 ? "用完" : `剩 ${100 - window.usedPercent}%`;
      return `${name} · ${rest}${window.resetsAt ? ` · ${clock(window.resetsAt, now)} 重置` : ""}`;
    });
    if (source.extraUsage !== null) details.push(`额外额度 · ${source.extraUsage ? "已开" : "未开"}`);
    return [{
      name: NAME[source.source],
      amount: blocked ? "用完" : `剩 ${left}%`,
      resets: resetIso ? clock(resetIso, now) : null,
      left,
      tone: toneOf(left, blocked),
      stale: age > STALE_MS ? `${Math.floor(age / 60_000)} 分钟前` : null,
      details,
    }];
  });
}
