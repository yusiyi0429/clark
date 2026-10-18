import type { TAdminCounterKey, TAdminPersonRow, TAdminStatus } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";

export type Source = "collector" | "feishu" | "world";
export const SOURCES: { key: Source; label: string }[] = [
  { key: "collector", label: "本机采集器" },
  { key: "feishu", label: "飞书授权" },
  { key: "world", label: "本体" },
];

export const COUNTER_LABELS: Record<TAdminCounterKey, string> = {
  collector_gap: "采集断档",
  feishu_auth: "授权到期 / 失效",
  meeting_stuck: "卡住的会议",
  delivery_failed: "推送失败",
  world_failed: "本体写入失败",
  job_failed: "后台任务失败",
};

const SIGNAL_LABELS: Record<string, string> = { memory_mark_unknown_id: "记忆标记对不上", run_failed: "运行失败" };
export const signalLabel = (signal: string) => SIGNAL_LABELS[signal] ?? signal;
const RUN_KINDS: Record<string, string> = { conversation: "对话" };
export const runKindLabel = (kind: string) => RUN_KINDS[kind] ?? kind;
const ISSUE_NAMES: Record<string, string> = { meeting_event: "会后事件" };
export const issueName = (name: string) => ISSUE_NAMES[name] ?? name;

/** 「刚刚」「12 分钟」「5 小时」「3 天」：离现在多久。 */
export function age(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export const isProblem = (status: TAdminStatus) => status === "red" || status === "yellow";

/** 计数筛选到人 × 来源的哪一列。 */
export const COUNTER_SOURCE: Partial<Record<TAdminCounterKey, Source>> = { collector_gap: "collector", feishu_auth: "feishu" };
/** 计数筛选到失败列表的哪一类。 */
export const COUNTER_ISSUE: Partial<Record<TAdminCounterKey, "job" | "world_write">> = { world_failed: "world_write", job_failed: "job" };

/** 提醒的默认标题和正文（发出前在预览里可以改）。 */
export function reminderDraft(row: TAdminPersonRow, source: Source, now: Date): { title: string; body: string } {
  if (source === "collector") {
    const cell = row.collector;
    if (cell.status === "none") return { title: "请装上本机采集器", body: "天枢还没有收到过你的本机采集器心跳。" };
    const lines = cell.devices.map((device) => `${device.deviceName}（${device.source}）：${device.lastSuccessAt ? `最近一次成功 ${monthDayTime(device.lastSuccessAt)}` : "还没成功同步过"}`);
    return { title: `本机采集器 ${age(cell.lastSuccessAt ?? cell.devices[0]?.firstSeenAt ?? null, now)}没同步`, body: lines.join("\n") };
  }
  if (source === "feishu") {
    const cell = row.feishu;
    if (cell.status === "none") return { title: "请授权飞书", body: "天枢还没有你的飞书授权。" };
    return cell.tokenStatus === "reauth_required"
      ? { title: "飞书授权已失效，请重新授权", body: `上次授权：${monthDayTime(cell.authorizedAt)}` }
      : { title: "飞书授权快到期，请重新授权", body: `上次授权：${monthDayTime(cell.authorizedAt)}` };
  }
  const cell = row.world;
  return { title: "周复盘没写进本体", body: `${cell.lastWeek ?? ""} 这一周的周复盘，${cell.failedTargets} 个对象没写进本体。` };
}
