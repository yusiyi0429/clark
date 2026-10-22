/** 北京时间的日期与时刻（法定节假日与调休这一版不算）。 */
const OFFSET_MS = 8 * 60 * 60_000;

/** 北京时间「10月20日 16:00」。 */
export function shanghaiLabel(at: Date): string {
  const local = new Date(at.getTime() + OFFSET_MS);
  return `${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** 北京时间的 YYYY-MM-DD。 */
export function shanghaiDate(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}
