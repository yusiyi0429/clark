"use client";

/**
 * Task 页的看板（GET /api/plan-tasks/:taskId/cards）：卡、草稿、最近一次拆卡、准备中的、下一版的号。
 * 前台时每 10 秒重取（本机在跑的卡由本机实时事件补上，手机靠这个轮询）；拆卡在跑时 3 秒一次。
 * 看板接口还没有（404）时退回首页计划里挂在这个 Task 下的事项，草稿、准备中为空。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TCardBoardResponse, THomePlanResponse } from "@warmap/contracts";
import { readBoard } from "./cloud";
import type { CardItem } from "./cards";

export type TaskBoard = Omit<TCardBoardResponse, "cards"> & { cards: CardItem[]; fallback: boolean };

export function fallbackBoard(plan: THomePlanResponse, taskId: string): TaskBoard | null {
  const task = plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) return null;
  const criteria = task.criteria.length ? task.criteria : task.doneDefinition ? [task.doneDefinition] : [];
  return {
    taskId,
    criteria: criteria.map((text, index) => ({ index: index + 1, text })),
    cards: plan.activities.map((activity) => activity.item).filter((item) => item.planTaskId === taskId && item.status !== "returned"),
    drafts: [],
    plan: null,
    pending: [],
    nextVersion: (task.deliverable?.version ?? 0) + 1,
    fallback: true,
  };
}

export function useTaskBoard(taskId: string, plan: THomePlanResponse | null) {
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const load = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const data = await readBoard(taskId);
        if (data) { setBoard({ ...data, fallback: false }); setMissing(false); }
        else setMissing(true);
        setError(null);
      } catch {
        setError("看板暂时没读到，稍后自动重试。");
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [taskId]);

  const planning = board?.plan?.status === "queued" || board?.plan?.status === "running";
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, planning ? 3000 : 10_000);
    return () => window.clearInterval(timer);
  }, [load, planning]);

  const shown = board && !missing ? board : plan ? fallbackBoard(plan, taskId) : null;
  return { board: shown, error, refresh: load };
}
