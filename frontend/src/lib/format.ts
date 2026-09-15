/**
 * Timestamps render in Asia/Shanghai regardless of where the browser is, so a
 * demo on a laptop set to another timezone still shows the times the meeting
 * and the signals actually happened at.
 */
const TZ = "Asia/Shanghai";

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateOnly = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  month: "numeric",
  day: "numeric",
});

const clockOnly = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `08/07 09:12` */
export function formatStamp(iso: string): string {
  return dateTime.format(new Date(iso)).replace(/\//g, "-");
}

/** `8/7` */
export function formatDay(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/**
 * `14:32` —— **只到分钟**。
 *
 * 给「刚才那件事是什么时候完的」用。不带日期：它出现的地方是刚刚发生的事
 * （扫描收工那一行），把日期一起写上去反而让人以为那是一条历史记录。
 * 秒也不写 —— 一号位要的是「几点几分完的」，秒数只会让这行字每次都长得不一样。
 */
export function formatClock(iso: string): string {
  return clockOnly.format(new Date(iso));
}

/**
 * `1 分 05 秒` / `48 秒`。
 *
 * 分钟为 0 时不写「0 分」—— 屏幕上不出现只为对齐而存在的零。倒计时用它，所以秒数补零：
 * 从 1 分 10 秒跳到 1 分 9 秒时，后面的字不该跟着往左动一格。
 */
export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${String(s).padStart(2, "0")} 秒` : `${s} 秒`;
}

/**
 * `刚刚` / `12 分钟前` / `3 小时前` / `4 天前`。
 *
 * 给「上一次那件事是多久以前」用。它和 `formatStamp` 的分工是：绝对时间给「哪一条」（得能对帐），
 * 这一个给「还新不新」—— 他看节奏时问的是后者，而 `08-29 07:00` 要他自己在心里减一次。
 *
 * 一分钟以内说「刚刚」：秒数在这一档上每刷一次都不一样，而那一位对他没有任何意义。
 * 跨过两天才换成「N 天前」：「30 小时前」比「1 天前」准，而到了四五天上反过来。
 *
 * `now` 可注入：否则拿它写的断言只能跟着真实时钟走，那种断言守不住任何东西。
 */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  // 取不出时间、或者时钟倒着走（服务端盖的时间比本机快）都归「刚刚」，不报负数。
  if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
