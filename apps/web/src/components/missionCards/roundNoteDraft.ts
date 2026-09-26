/** 仅保存未提交的输入；确认事实始终以 API 为准。跨卡核对共用一份，按人和讨论窗口隔离。 */
const key = (viewer: string, roundId: string, window: number) => `tkos:mission-round-note:${viewer}:${roundId}:${window}`;

export function readRoundNote(viewer: string, roundId: string, window: number): string {
  try { return sessionStorage.getItem(key(viewer, roundId, window)) ?? ""; } catch { return ""; }
}
export function saveRoundNote(viewer: string, roundId: string, window: number, text: string): void {
  try { sessionStorage.setItem(key(viewer, roundId, window), text); } catch { /* 浏览器禁用存储时，输入仍保留在当前页面。 */ }
}
export function clearRoundNote(viewer: string, roundId: string, window: number): void {
  try { sessionStorage.removeItem(key(viewer, roundId, window)); } catch { /* 本页状态会同时清空。 */ }
}
