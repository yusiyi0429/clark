"use client";

/**
 * 成员首页的数据：我的执行事项、我的通知，以及卡上那几件事（改状态、退回、看过）。通知每 20 秒刷新一次（页面在前台时）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import type { MemberTask, TaskStatus } from "./MemberTasks";

export interface MemberNotification {
  id: string;
  kind: "meeting_action_assigned" | "task_returned" | "strategic_rejected";
  text: string;
  objectType: "task" | "meeting";
  objectId: string;
  createdAt: string;
  readAt: string | null;
}

const REFRESH_MS = 20_000;
const REFRESH_ERROR = "工作台暂时没有连接成功，已保留当前内容；稍后会自动重试。";

type Result = { ok: true } | { ok: false; error: string };
const failed = (error: unknown, fallback: string): Result => ({ ok: false, error: (error as { message?: string } | undefined)?.message ?? fallback });

export function useMemberHome() {
  const [tasks, setTasks] = useState<MemberTask[]>([]);
  const [notifications, setNotifications] = useState<MemberNotification[]>([]);
  const [rounds, setRounds] = useState<TMissionRoundSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (loadInFlight.current) return loadInFlight.current;
    loadInFlight.current = (async () => { try {
      const [home, list, missionCards] = await Promise.all([browserApi.GET("/api/me/home"), browserApi.GET("/api/me/notifications"), browserApi.GET("/api/me/mission-cards")]);
      if (home.response.status === 401 || list.response.status === 401 || missionCards.response.status === 401) {
        window.location.assign("/access?next=%2Fme");
        return;
      }
      if (home.data) setTasks(home.data.myTasks as MemberTask[]);
      if (list.data) setNotifications(list.data.notifications as MemberNotification[]);
      if (missionCards.data) setRounds(missionCards.data.rounds);
      if (home.data && list.data && missionCards.data) setTaskError((current) => current === REFRESH_ERROR ? null : current);
    } catch {
      // 首页在详情背后仍保持挂载；后台轮询断网不能打断当前阅读与讨论。
      setTaskError(REFRESH_ERROR);
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
    document.addEventListener("visibilitychange", resume);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", resume); window.removeEventListener("mission-round-changed", roundChanged); document.removeEventListener("visibilitychange", resume); };
  }, [load]);

  const replaceTask = (task: MemberTask) => setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));

  /** 卡底的「开始推进」「标记完成」。版本过期时换成服务端最新的那一张，并写明原因。 */
  const setStatus = useCallback(async (task: MemberTask, status: TaskStatus) => {
    if (status === "returned") return;
    setBusyId(task.id);
    setTaskError(null);
    const { data, error, response } = await browserApi.PATCH("/api/me/tasks/{id}", { params: { path: { id: task.id } }, body: { version: task.version, status } });
    setBusyId(null);
    if (data) return replaceTask(data as MemberTask);
    const latest = (error as { latestTask?: MemberTask } | undefined)?.latestTask;
    if (response.status === 409 && latest) replaceTask(latest);
    setTaskError(response.status === 409 ? "这件事刚被改过，已换成最新的样子，请再按一次。" : "没改成，请重试。");
  }, []);

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

  /** 卡上办完、回执也淡出了：本地先拿掉，再拉一次最新的。 */
  const settle = useCallback(
    (id: string) => {
      setNotifications((current) => current.filter((item) => item.id !== id));
      void load();
    },
    [load],
  );

  return { tasks, notifications, rounds, refresh: load, busyId, taskError, setStatus, returnTask, markSeen, settle };
}
