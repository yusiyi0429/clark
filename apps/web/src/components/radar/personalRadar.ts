import type { components } from "@/lib/api/schema";
import { COMPANY_TIMEZONE, monthDayTime, publishedDate } from "@/lib/companyTime";
import type { SignalOrder } from "@/cards/SignalCard";

export type MyRadar = components["schemas"]["MyRadar"];
export type PersonalRadarRun = components["schemas"]["PersonalRadarRun"];
export type PersonalSignalBrief = components["schemas"]["PersonalSignalBrief"];
export type PersonalSignal = components["schemas"]["PersonalSignal"];
export type MemberRadarBrief = components["schemas"]["MemberRadarBrief"];

/** 同一个状态在首页小组件、我的雷达页说同一句话（spec §3「统一的范围」）。 */
export const RADAR_COPY = {
  off: "雷达已关闭。打开后，我每天按你的方向替你看一遍。",
  firstScan: "第一次扫描还没完成，稍等片刻",
  empty: "这段时间没有和你方向相关的新内容",
} as const;

/** 设置保存后通知首页与雷达页重读（与「mission-round-changed」同一种写法）。 */
export const RADAR_SETTINGS_CHANGED = "radar-settings-changed";

export const scanActive = (run: PersonalRadarRun | null | undefined) => run?.status === "queued" || run?.status === "running";

/** 扫描失败的原因由服务端写在 warnings 里；没写时也要说清是扫描没完成。 */
export const failureReason = (run: PersonalRadarRun) => run.warnings.find((warning) => warning.trim()) ?? "扫描没有完成";

/** 这次运行自己的时间：完成 → 开始 → 排队。 */
const runTime = (run: PersonalRadarRun) => run.completedAt ?? run.startedAt ?? run.queuedAt ?? null;

/** 「刚刚」「12 分钟前」「3 小时前」，一天以上写日期（公司时区）。 */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: COMPANY_TIMEZONE });
}

/** 首页小组件标题旁那一行：最近一次扫描的状态（相对时间）与未读数。 */
export function radarBriefStatus(radar: { lastRun: PersonalRadarRun | null; unreadCount: number }, now = Date.now()): string {
  const run = radar.lastRun;
  const unread = radar.unreadCount ? ` · ${radar.unreadCount} 条未读` : "";
  if (!run) return `还没扫描过${unread}`;
  if (run.status === "queued") return "正在排队扫描";
  if (run.status === "running") return "正在扫描";
  const when = relativeTime(runTime(run), now);
  return `${run.status === "failed" ? "扫描失败" : "最近扫描"}${when ? ` · ${when}` : ""}${unread}`;
}

/** 我的雷达页的状态行（与公司雷达页同一种写法：方式、结果、时间、未读）。 */
export function personalStatusLine(radar: MyRadar, scanning: boolean): string {
  if (scanning || scanActive(radar.lastRun)) return "正在扫描外部信息";
  const run = radar.lastRun;
  if (!run) return radar.enabled ? "还没有扫描过 · 每天定时扫描一次" : "雷达已关闭";
  const how = run.trigger === "manual" ? "手动刷新" : "定时扫描";
  const when = monthDayTime(runTime(run));
  if (run.status === "failed") return `${how}失败${when ? ` · ${when}` : ""}`;
  return `${how}已完成${when ? ` · ${when}` : ""} · 新增 ${run.createdSignals} 条 · ${radar.unreadCount} 条未读`;
}

/** 个人信号的时间：发布时间 → 上榜日 → 收集时间。 */
export const personalSignalTime = (signal: PersonalSignalBrief) =>
  Date.parse(signal.source.publishedAt ?? signal.source.listedOn ?? signal.collectedAt) || 0;

/** 个人信号在「继续浏览」与列表里的顺序：与公司信号同一个 upNextSignals。 */
export const PERSONAL_ORDER: SignalOrder<PersonalSignalBrief> = {
  id: (signal) => signal.id,
  time: personalSignalTime,
  visible: (signal) => !signal.state.dismissed,
};

export const personalSignalHref = (id: string) => `/me/radar/signals/${encodeURIComponent(id)}`;

/** 个人信号卡片：没有配图；来源一行写来源 · 日期 · 命中的方向。 */
export function personalStory(signal: PersonalSignalBrief) {
  return {
    href: personalSignalHref(signal.id),
    title: signal.source.title,
    summary: signal.summary,
    meta: `${signal.source.label} · ${publishedDate(signal.source.publishedAt ?? signal.source.listedOn)} · ${signal.direction.text}`,
    status: signal.state.saved ? "已收藏" : signal.state.read ? "已读" : "新信号",
  };
}

/** 401 回锁屏并带上当前页面。 */
export function goToAccess() {
  window.location.assign(`/access?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
}
