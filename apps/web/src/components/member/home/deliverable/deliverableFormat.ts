import type { TDeliverableItem, TDeliverableReview, TDeliverableVersion, TTaskDeliverableStatus } from "@warmap/contracts";

/** 评审中的几步：读交付物（只写了现状时是读现状说明）、逐条对照、写报告；重评一条时只有一步（服务端给的 label）。 */
export function reviewSteps(review: TDeliverableReview, itemCount: number, criteriaCount: number): string[] {
  if (review.phase?.total === 1) return [review.phase.label];
  return [itemCount ? `读交付物（${itemCount} 份）` : "读现状说明", ...Array.from({ length: criteriaCount }, (_, index) => `对照第 ${index + 1} 条`), "写报告"];
}

/** 0:41、12:05 这样的已用时间。 */
export function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

/** 约 2 分钟、约 40 秒。 */
export function about(seconds: number): string {
  return seconds < 60 ? `约 ${Math.max(1, Math.round(seconds / 10) * 10)} 秒` : `约 ${Math.ceil(seconds / 60)} 分钟`;
}

/** 1 分 52 秒、40 秒。 */
export function duration(seconds: number): string {
  const value = Math.max(1, Math.round(seconds));
  return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分${value % 60 ? ` ${value % 60} 秒` : ""}`;
}

/** 交付过去多久：刚刚、12 分钟、3 小时、2 天。 */
export function since(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时`;
  return `${Math.floor(minutes / (24 * 60))} 天`;
}

/** 材料前面的小标：PDF、Word、MD、HTML、图、链接。 */
export function itemTag(item: TDeliverableItem): string {
  if (item.kind === "link") return "链接";
  if (item.kind === "image") return "图";
  if (item.mimeType === "application/pdf") return "PDF";
  if (item.mimeType?.includes("wordprocessingml")) return "Word";
  if (item.mimeType === "text/html") return "HTML";
  return "MD";
}

/** 材料后面的读取状态：已读 · 6 页、已看、待读，读不了时是原因。 */
export function itemState(item: TDeliverableItem): string {
  if (item.read === "unreadable") return item.readNote ?? "打不开";
  if (item.read === "pending") return "待读";
  if (item.kind === "image") return "已看";
  return item.pageCount ? `已读 · ${item.pageCount} 页` : "已读";
}

/** 版本切换上的小字：v2 · 78、v3 · 评审中、v1 · 没评完、v2 · 已交付。 */
export function versionLabel(version: TDeliverableVersion): string {
  const { review } = version;
  if (version.deliveredAt) return `v${version.number} · 已交付`;
  if (review.status === "queued" || review.status === "running") return `v${version.number} · 评审中`;
  if (review.status === "failed") return `v${version.number} · 没评完`;
  return review.total ? `v${version.number} · ${review.score ?? 0}` : `v${version.number}`;
}

/** 左边 Task 卡上的状态小标。 */
export function statusChip(status: TTaskDeliverableStatus | undefined): { label: string; tone: "plain" | "judgment" | "ready" | "confirmed" } {
  switch (status?.status) {
    case "reviewing": return { label: "评审中", tone: "plain" };
    case "iterating": return { label: status.score === null ? "迭代中" : `迭代中 · ${status.score}`, tone: "judgment" };
    case "ready": return { label: "可以交付", tone: "ready" };
    case "delivered": return { label: "已交付", tone: "confirmed" };
    default: return { label: "未开始", tone: "plain" };
  }
}
