const TIME_ZONE = "Asia/Shanghai";

export function formatLockTime(now: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

export function formatLockDate(now: Date) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    month: "long",
    day: "numeric",
    weekday: "long",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${value.month}月${value.day}日 · ${value.weekday}`;
}
