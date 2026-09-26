/**
 * 右列未读数的显示（clark `conversation/seen.ts`）。「看到哪儿了」的底账随群组一起接（2b：群组读到哪里记在服务端）。
 */

/** 角标上的数字：没有就不画，两位数写 9+。 */
export function formatUnread(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9 ? "9+" : String(Math.floor(count));
}

/** 读屏名称后面那一截：「，3 条未读」。没有未读就是空串。 */
export function unreadPhrase(count: number): string {
  return count > 0 ? `，${count} 条未读` : "";
}
