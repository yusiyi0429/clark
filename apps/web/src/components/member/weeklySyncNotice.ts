import type { components } from "@/lib/api/schema";
import type { ActionNotice } from "@/components/ActionNoticeCard";
import { openConnectionDialog } from "@/components/monthlyReview/personalReviewApi";
import { SYNC_INSTRUCTION } from "@/lib/connectionGuide";

export type WeeklySyncReminder = components["schemas"]["WeeklySyncReminder"];

/** 周五兜底：服务端判断本周还没同步，这里只给文案和一步操作。 */
export function weeklySyncNotices(reminder: WeeklySyncReminder | null): ActionNotice[] {
  if (!reminder) return [];
  return [reminder.reason === "no_connection" ? {
    id: "weekly-sync", tone: "amber", title: "本周进展还没同步",
    detail: "",
    buttons: [{ label: "连接你的 Agent", emphasis: true, run: async () => { openConnectionDialog(); return { ok: true, settled: "已打开连接设置" }; } }],
  } : {
    id: "weekly-sync", tone: "amber", title: "本周进展还没同步",
    detail: "",
    buttons: [{ label: "复制同步指令", emphasis: true, run: async () => {
      try { await navigator.clipboard.writeText(SYNC_INSTRUCTION); return { ok: true, settled: "已复制同步指令" }; }
      catch { return { ok: false, error: "复制失败，请在「连接到外部工具」里手动复制" }; }
    } }],
  }];
}
