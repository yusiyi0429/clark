"use client";

/**
 * 成员工作台的数据：我的执行事项（通知卡上退回要用）、我的通知、开着时的个人雷达摘要，以及卡上那几件事（退回、看过）。
 * 通知每 20 秒刷新一次（页面在前台时）；在个人菜单里改了雷达设置时马上重读。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { RADAR_SETTINGS_CHANGED, type MemberRadarBrief } from "@/components/radar/personalRadar";
import type { WeeklySyncReminder } from "./weeklySyncNotice";

type MemberTask = components["schemas"]["TaskView"];

export interface MemberNotification {
  id: string;
  kind: "meeting_action_assigned" | "task_returned" | "strategic_rejected" | "task_collaborator_added" | "thread_member_added" | "task_submitted" | "meeting_card_pending" | "task_progress_added";
  text: string;
  /** 会后分派：事情本身和会议名（通知栏正文只写事情，会议名进小字）。 */
  subject?: string;
  source?: string;
  objectType: "task" | "meeting" | "issue";
  objectId: string;
  createdAt: string;
  readAt: string | null;
}
export type UnreadMissionGroup = { cardId: string; title: string; unread: number; href: string };

const REFRESH_MS = 20_000;
const REFRESH_ERROR = "工作台暂时没有连接成功，已保留当前内容；稍后会自动重试。";

type Result = { ok: true } | { ok: false; error: string };
const failed = (error: unknown, fallback: string): Result => ({ ok: false, error: (error as { message?: string } | undefined)?.message ?? fallback });

export function useMemberHome() {
  const [tasks, setTasks] = useState<MemberTask[]>([]);
  const [notifications, setNotifications] = useState<MemberNotification[]>([]);
  const [meetings, setMeetings] = useState<components["schemas"]["MemberMeetingsResponse"]["meetings"]>([]);
  const [unreadThreads, setUnreadThreads] = useState<components["schemas"]["UnreadThreadsResponse"]["threads"]>([]);
  const [unreadMissionGroups, setUnreadMissionGroups] = useState<UnreadMissionGroup[]>([]);
  const [rounds, setRounds] = useState<TMissionRoundSummary[]>([]);
  /** 雷达关着时为 null，首页整块不出现。 */
  const [radar, setRadar] = useState<MemberRadarBrief | null>(null);
  /** 周五 18:00 到周日本周还没同步时由服务端给出；其余时间为 null。 */
  const [weeklySync, setWeeklySync] = useState<WeeklySyncReminder | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadInFlight.current) return loadInFlight.current;
    loadInFlight.current = (async () => { try {
      const [home, list, missionCards, meetingList, threads] = await Promise.all([browserApi.GET("/api/me/home"), browserApi.GET("/api/me/notifications"), browserApi.GET("/api/me/mission-cards"), browserApi.GET("/api/me/meetings"), browserApi.GET("/api/me/threads/unread")]);
      if (home.response.status === 401 || list.response.status === 401 || missionCards.response.status === 401) {
        window.location.assign("/access?next=%2Fme");
        return;
      }
      if (home.data) { setTasks(home.data.myTasks as MemberTask[]); setRadar(home.data.radar ?? null); setWeeklySync(home.data.weeklySync ?? null); }
      setHomeError(home.data ? null : REFRESH_ERROR);
      if (list.data) setNotifications(list.data.notifications as MemberNotification[]);
      if (meetingList.data) setMeetings(meetingList.data.meetings);
      if (threads.data) setUnreadThreads(threads.data.threads);
      if (missionCards.data) {
        setRounds(missionCards.data.rounds);
        const cards = missionCards.data.rounds.flatMap((round) => round.cards ?? []);
        const missionUnread = await Promise.all(cards.map(async (card) => {
          try {
            const { data } = await browserApi.GET("/api/mission-cards/{cardId}/group", { params: { path: { cardId: card.cardId } } });
            return data?.unread ? { cardId: card.cardId, title: card.ownerName, unread: data.unread,
              href: `/me/mission-cards/${card.cardId}` } : null;
          } catch { return null; }
        }));
        setUnreadMissionGroups(missionUnread.filter((item): item is UnreadMissionGroup => item !== null));
      }
    } catch {
      // 首页在详情背后仍保持挂载；后台轮询断网不能打断当前阅读与讨论。
      setHomeError(REFRESH_ERROR);
    } finally { loadInFlight.current = null; } })();
    return loadInFlight.current;
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    // 拍板可能发生在轮询途中，等旧读取落定后再取一次，不能用旧结果吞掉本次变更。
    const roundChanged = () => { if (loadInFlight.current) void loadInFlight.current.then(load); else void load(); };
    window.addEventListener("focus", resume);
    window.addEventListener("mission-round-changed", roundChanged);
    window.addEventListener("member-tasks-changed", roundChanged);
    window.addEventListener("meeting-changed", roundChanged);
    window.addEventListener(RADAR_SETTINGS_CHANGED, roundChanged);
    document.addEventListener("visibilitychange", resume);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", resume); window.removeEventListener("mission-round-changed", roundChanged); window.removeEventListener("member-tasks-changed", roundChanged); window.removeEventListener("meeting-changed", roundChanged); window.removeEventListener(RADAR_SETTINGS_CHANGED, roundChanged); document.removeEventListener("visibilitychange", resume); };
  }, [load]);

  const replaceTask = (task: MemberTask) => setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));

  /** 通知卡上的「退回」：要写原因，主持人会收到提醒。 */
  const returnTask = useCallback(
    async (taskId: string, reason: string): Promise<Result> => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return { ok: false, error: "这件事已经不在你的执行事项里了。" };
      const { data, error, response } = await browserApi.POST("/api/me/tasks/{id}/return", { params: { path: { id: taskId } }, body: { version: task.version, reason } });
      if (data) {
        replaceTask(data as MemberTask);
        return { ok: true };
      }
      const latest = (error as { latestTask?: MemberTask } | undefined)?.latestTask;
      if (response.status === 409 && latest) {
        replaceTask(latest);
        return { ok: false, error: "这件事刚被改过，已换成最新的样子，请再退回一次。" };
      }
      return failed(error, "没退回成功，请重试。");
    },
    [tasks],
  );

  /** 看过这几条：从通知栏退掉。 */
  const markSeen = useCallback(async (ids: string[]): Promise<Result> => {
    const { error, response } = await browserApi.POST("/api/me/seen", { body: { notificationIds: ids } });
    return response.ok ? { ok: true } : failed(error, "没记上，请重试。");
  }, []);

  /** 从值得注意的通知打开信号时，沿用个人雷达的已读接口。 */
  const readRadarNotice = useCallback(async (id: string): Promise<boolean> => {
    try {
      const { response } = await browserApi.PATCH("/api/me/radar/signals/{id}/state", { params: { path: { id } }, body: { read: true } });
      if (response.status === 401) {
        window.location.assign("/access?next=%2Fme");
        return false;
      }
      if (response.ok) setRadar((current) => current ? {
        ...current,
        unreadCount: Math.max(0, current.unreadCount - 1),
        highlights: current.highlights.map((signal) => signal.id === id ? { ...signal, state: { ...signal.state, read: true } } : signal),
      } : current);
    } catch {
      // 阅读页仍可打开；未标记成功时，用户可以在阅读页手动重试。
    }
    return true;
  }, []);

  /** 卡上办完、回执也淡出了：本地先拿掉，再拉一次最新的。 */
  const settle = useCallback(
    (id: string) => {
      setNotifications((current) => current.filter((item) => item.id !== id));
      void load();
    },
    [load],
  );

  return { tasks, notifications, meetings, unreadThreads, unreadMissionGroups, rounds, radar, weeklySync, homeError, refresh: load, returnTask, markSeen, readRadarNotice, settle };
}
