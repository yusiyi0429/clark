/**
 * 成员通知栏的两组（clark DRI 通知栏「推动」那一组的处理方式）：
 * - 新的执行事项：会后分给我的事 —— 「接下」（看过，事已经在我的执行事项里），或「退回」（写原因，告诉主持人）。
 * - 回复与结果：我主持的会里有人退回、CEO 不同意战略议题 —— 「知道了」；外部工具替我提交了验收（design-12）——
 *   点开直接弹出验收。打开不等于处理：验收完或点「还要继续做」，服务端才把它标为已读。
 * - 协作进展：别人在我推进或协作的事项上写了进展（同一件事只一条，文案是最新一条）—— 点开进事项并算看过，或「知道了」。
 * 只列没看过的；看过的从通知栏退掉（通知只指向对象，文案按对象此刻的状态写，C-05）。
 */

import type { ActionNotice } from "@/components/ActionNoticeCard";
import type { NoticeOutcome } from "@/components/NoticeActions";
import { monthDayTime } from "@/lib/companyTime";
import type { MemberNotification } from "./useMemberHome";

type Result = { ok: true } | { ok: false; error: string };

/** 通知栏空状态里算的未读通知：会议记录待确认（meeting_card_pending）在「会议记录」那一组按会议列，不算在这里。 */
export function quietNoticeCount(notifications: MemberNotification[]): number {
  return notifications.filter((item) => !item.readAt && item.kind !== "meeting_card_pending").length;
}

export function memberNoticeGroups(
  notifications: MemberNotification[],
  handlers: { markSeen: (ids: string[]) => Promise<Result>; returnTask: (taskId: string, reason: string) => Promise<Result>; openTask?: (id: string, from: Element | null) => void; openAcceptance?: (id: string, from: Element | null) => void; openGroup?: (type: "issue" | "meeting", id: string, from: Element | null) => void },
): { assigned: ActionNotice[]; results: ActionNotice[]; progress: ActionNotice[] } {
  const unread = notifications.filter((item) => !item.readAt);
  const seen = async (id: string, settled?: string): Promise<NoticeOutcome> => {
    const result = await handlers.markSeen([id]);
    return result.ok ? { ok: true, settled } : result;
  };
  const assigned = unread
    .filter((item) => item.kind === "meeting_action_assigned" || item.kind === "task_collaborator_added" || item.kind === "thread_member_added")
    .map<ActionNotice>((item) => item.kind === "thread_member_added" ? ({
      id: item.id, title: item.text, detail: `邀请你进群 · ${monthDayTime(item.createdAt)}`, tone: "neutral",
      onOpen: (from) => { void handlers.markSeen([item.id]); handlers.openGroup?.(item.objectType as "issue" | "meeting", item.objectId, from); },
      buttons: [{ label: "知道了", emphasis: true, run: () => seen(item.id) }],
    }) : item.kind === "task_collaborator_added" ? ({
      id: item.id,
      title: item.text,
      detail: `邀请你协作 · ${monthDayTime(item.createdAt)}`,
      tone: "neutral",
      onOpen: (from) => handlers.openTask?.(item.objectId, from),
      buttons: [{ label: "知道了", emphasis: true, run: () => seen(item.id) }],
    }) : ({
      id: item.id,
      title: item.text,
      detail: `会后分给你 · ${monthDayTime(item.createdAt)}`,
      tone: "amber",
      onOpen: (from) => handlers.openTask?.(item.objectId, from),
      buttons: [{ label: "接下", emphasis: true, run: () => seen(item.id, "已接下") }],
      reason: {
        label: "退回",
        fieldLabel: "退回的原因",
        placeholder: "比如：会上没这么定",
        submitLabel: "退回，告诉主持人",
        run: async (reason) => {
          const result = await handlers.returnTask(item.objectId, reason);
          if (!result.ok) return result;
          return seen(item.id, "已退回");
        },
      },
    }));
  const results = unread
    .filter((item) => item.kind === "task_returned" || item.kind === "strategic_rejected" || item.kind === "task_submitted" || item.kind === "task_auto_done")
    .map<ActionNotice>((item) => item.kind === "task_submitted" ? ({
      id: item.id,
      title: item.text,
      detail: `外部工具提交 · ${monthDayTime(item.createdAt)}`,
      tone: "neutral",
      onOpen: (from) => handlers.openAcceptance?.(item.objectId, from),
      buttons: [],
    }) : item.kind === "task_auto_done" ? ({
      id: item.id,
      title: item.text,
      detail: `外部工具判定 · ${monthDayTime(item.createdAt)}`,
      tone: "neutral",
      onOpen: (from) => handlers.openTask?.(item.objectId, from),
      buttons: [{ label: "知道了", emphasis: true, run: () => seen(item.id) }],
    }) : ({
      id: item.id,
      title: item.text,
      detail: `${item.kind === "task_returned" ? "有人退回" : "CEO 表态"} · ${monthDayTime(item.createdAt)}`,
      tone: item.kind === "strategic_rejected" ? "amber" : "neutral",
      // 退回的是执行事项，打开事项；CEO 表态落在会议上，打开会议。
      onOpen: (from) => item.objectType === "task" ? handlers.openTask?.(item.objectId, from) : handlers.openGroup?.(item.objectType as "issue" | "meeting", item.objectId, from),
      buttons: [{ label: "知道了", emphasis: true, run: () => seen(item.id) }],
    }));
  const progress = unread
    .filter((item) => item.kind === "task_progress_added")
    .map<ActionNotice>((item) => ({
      id: item.id,
      title: item.text,
      detail: `协作进展 · ${monthDayTime(item.createdAt)}`,
      tone: "neutral",
      onOpen: (from) => { void handlers.markSeen([item.id]); handlers.openTask?.(item.objectId, from); },
      buttons: [{ label: "知道了", emphasis: true, run: () => seen(item.id) }],
    }));
  return { assigned, results, progress };
}
